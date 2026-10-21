-- 0146 — Manager products: listing moderation (restricted categories, parked
-- price changes, hiding), the menu change history, listing flags, and the
-- audited RPCs managers use to flag, hide, approve, resolve and adjust stock.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0146.mjs); run it on staging first.
-- Depends on 0001 (menu_items, "menu — read"), 0062 (stock, variants,
-- guard_order_item_insert, take_stock), 0141 (zones, _ops_log,
-- manager_can_see_zone), 0142 (ops_require_staff, _ops_replayed, _ops_set_actor).
-- Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-4-vendors-products.md.
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * `menu_items` gains moderation columns. A shop owner holds UPDATE on their
--     dishes; guard_menu_item_moderation() keeps every moderation column at its
--     old value for them, so a vendor can neither approve, unhide nor park a
--     price. It is security INVOKER so `current_user` is the caller's role.
--   * "menu — read" is re-created: customers (anon/authenticated) read only
--     live dishes of approved shops — approved (or approved with a price change
--     waiting, sold at the old price) and not hidden; owners, admins and the
--     dish's zone managers read everything.
--   * guard_order_item_insert() (0062's body) refuses a pending, rejected or
--     hidden dish for a customer's order line.
--   * New tables listing_restricted_categories, menu_item_changes,
--     listing_flags: RLS on; reads for the shop owner (own shop), admins and
--     the zone's managers; no write for anon/authenticated (history is written
--     by a security definer trigger, the rest by the ops_* RPCs).
--   * Every ops_* function here is service_role only and re-checks the actor's
--     zone in the database (ops_require_staff); each sets the session flag
--     `deligro.ops_moderation` locally so the guard lets its write through.
--
-- Rollback:
--   drop function if exists public.ops_flag_listing(uuid, uuid, text, text, text);
--   drop function if exists public.ops_set_listing_hidden(uuid, uuid, boolean, text, text);
--   drop function if exists public.ops_decide_listing(uuid, uuid, text, text, text);
--   drop function if exists public.ops_resolve_listing_flag(uuid, uuid, text, text, text);
--   drop function if exists public.ops_adjust_stock(uuid, uuid, integer, text, text);
--   drop function if exists public.ops_set_restricted_category(uuid, text, boolean, text, text);
--   drop function if exists public._ops_item_zone(uuid);
--   drop trigger if exists guard_menu_item_moderation on public.menu_items;
--   drop trigger if exists log_menu_item_change on public.menu_items;
--   drop function if exists public.guard_menu_item_moderation();
--   drop function if exists public.log_menu_item_change();
--   drop function if exists public.is_restricted_category(text);
--   drop table if exists public.listing_flags, public.menu_item_changes, public.listing_restricted_categories;
--   drop policy if exists "menu — read" on public.menu_items;  -- then re-create 0001's
--   -- re-run guard_order_item_insert() from 0062_store_inventory_options.sql
--   alter table public.menu_items drop column if exists approval_status, drop column if exists approval_note,
--     drop column if exists pending_price, drop column if exists hidden_by_ops, drop column if exists hidden_reason,
--     drop column if exists moderated_by, drop column if exists moderated_at, drop column if exists updated_at;

begin;

-- 1. Moderation columns ------------------------------------------------------------
alter table public.menu_items
  add column if not exists approval_status text not null default 'approved',
  add column if not exists approval_note   text,
  add column if not exists pending_price   integer,
  add column if not exists hidden_by_ops   boolean not null default false,
  add column if not exists hidden_reason   text,
  add column if not exists moderated_by    uuid references public.profiles (id) on delete set null,
  add column if not exists moderated_at    timestamptz,
  add column if not exists updated_at      timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_approval_status_check') then
    alter table public.menu_items add constraint menu_items_approval_status_check
      check (approval_status in ('approved', 'pending', 'rejected'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_pending_price_nonneg') then
    alter table public.menu_items add constraint menu_items_pending_price_nonneg check (pending_price is null or pending_price >= 0);
  end if;
end $$;

create index if not exists menu_items_moderation_idx on public.menu_items (approval_status) where approval_status <> 'approved';
create index if not exists menu_items_hidden_idx on public.menu_items (restaurant_id) where hidden_by_ops;

comment on column public.menu_items.pending_price is
  'A price change on an approved restricted dish, held for approval; the old price stays live until then.';

-- 2. Restricted categories ----------------------------------------------------------
create table if not exists public.listing_restricted_categories (
  name       text primary key check (name = lower(btrim(name)) and char_length(name) between 1 and 60),
  note       text check (note is null or char_length(note) <= 300),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.listing_restricted_categories enable row level security;
drop policy if exists "listing_restricted_categories — staff read" on public.listing_restricted_categories;
create policy "listing_restricted_categories — staff read" on public.listing_restricted_categories for select
  using (public.is_admin() or public.is_manager());
revoke all on public.listing_restricted_categories from anon, authenticated;
grant select on public.listing_restricted_categories to authenticated;

-- The guard runs as the caller (a vendor cannot read the list), so it asks here.
create or replace function public.is_restricted_category(p_category text)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_category is not null
     and exists (select 1 from public.listing_restricted_categories c where c.name = lower(btrim(p_category)));
$$;
revoke all on function public.is_restricted_category(text) from public;
grant execute on function public.is_restricted_category(text) to authenticated, service_role;

-- 3. The moderation guard -------------------------------------------------------------
create or replace function public.guard_menu_item_moderation()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  trusted constant boolean :=
    public.is_admin()
    or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
    or current_user in ('postgres', 'supabase_admin')
    or coalesce(current_setting('deligro.ops_moderation', true), '') = 'on';
begin
  new.updated_at := now();
  if trusted then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.approval_status := case when public.is_restricted_category(new.category) then 'pending' else 'approved' end;
    new.approval_note := null;
    new.pending_price := null;
    new.hidden_by_ops := false;
    new.hidden_reason := null;
    new.moderated_by := null;
    new.moderated_at := null;
    return new;
  end if;

  -- Moderation is not the vendor's to set.
  new.approval_status := old.approval_status;
  new.approval_note := old.approval_note;
  new.pending_price := old.pending_price;
  new.hidden_by_ops := old.hidden_by_ops;
  new.hidden_reason := old.hidden_reason;
  new.moderated_by := old.moderated_by;
  new.moderated_at := old.moderated_at;

  if public.is_restricted_category(new.category) then
    if not public.is_restricted_category(old.category) then
      -- Moved into a restricted category: a new listing, hidden until approved.
      new.approval_status := 'pending';
      new.pending_price := null;
    elsif new.price is distinct from old.price
          and (old.approval_status = 'approved' or old.pending_price is not null) then
      -- A live restricted dish keeps its old price until the new one is approved.
      new.pending_price := new.price;
      new.price := old.price;
      new.approval_status := 'pending';
    end if;
  end if;

  -- Editing a rejected listing resubmits it.
  if old.approval_status = 'rejected'
     and (new.name, new.price, new.category, new.description, new.image_url)
         is distinct from (old.name, old.price, old.category, old.description, old.image_url) then
    new.approval_status := 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_menu_item_moderation on public.menu_items;
create trigger guard_menu_item_moderation
  before insert or update on public.menu_items
  for each row execute function public.guard_menu_item_moderation();

-- 4. Change history --------------------------------------------------------------------
create table if not exists public.menu_item_changes (
  id            bigint generated always as identity primary key,
  menu_item_id  uuid not null references public.menu_items (id) on delete cascade,
  restaurant_id uuid not null,
  field         text not null,
  old_value     text,
  new_value     text,
  source        text not null check (source in ('vendor', 'ops', 'admin', 'system')),
  actor_id      uuid,
  created_at    timestamptz not null default now()
);
create index if not exists menu_item_changes_item_idx on public.menu_item_changes (menu_item_id, created_at desc);
create index if not exists menu_item_changes_field_idx on public.menu_item_changes (restaurant_id, field, created_at desc);

alter table public.menu_item_changes enable row level security;
drop policy if exists "menu_item_changes — read" on public.menu_item_changes;
create policy "menu_item_changes — read" on public.menu_item_changes for select
  using (
    public.owns_restaurant(restaurant_id)
    or public.is_admin()
    or exists (select 1 from public.restaurants r where r.id = restaurant_id and public.manager_can_see_zone(r.zone_id))
  );
revoke all on public.menu_item_changes from anon, authenticated;
grant select on public.menu_item_changes to authenticated;

-- One row per changed field. Stock moved by another trigger (0062's take_stock /
-- return_stock: an order) is not a person's change and is not recorded.
create or replace function public.log_menu_item_change()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ops_on constant boolean := coalesce(current_setting('deligro.ops_moderation', true), '') = 'on';
  src    text;
  actor  uuid := coalesce(auth.uid(), nullif(current_setting('deligro.actor_id', true), '')::uuid);
  f      text;
  o      jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  n      jsonb := to_jsonb(new);
begin
  src := case
    when ops_on then 'ops'
    when pg_trigger_depth() > 1 then 'system'
    when public.is_admin() then 'admin'
    when coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin') then 'system'
    else 'vendor'
  end;
  if src = 'system' then
    actor := null;
  end if;
  foreach f in array array['price', 'discount_price', 'available', 'name', 'image_url', 'category',
                           'approval_status', 'hidden_by_ops', 'stock_qty'] loop
    if tg_op = 'INSERT' and f <> 'approval_status' then
      continue;
    end if;
    if f = 'stock_qty' and pg_trigger_depth() > 1 then
      continue;
    end if;
    if (o -> f) is distinct from (n -> f) then
      insert into public.menu_item_changes (menu_item_id, restaurant_id, field, old_value, new_value, source, actor_id)
      values (new.id, new.restaurant_id, f, o ->> f, n ->> f, src, actor);
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function public.log_menu_item_change() from public;

drop trigger if exists log_menu_item_change on public.menu_items;
create trigger log_menu_item_change
  after insert or update on public.menu_items
  for each row execute function public.log_menu_item_change();

-- 5. Listing flags ---------------------------------------------------------------------
create table if not exists public.listing_flags (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references public.menu_items (id) on delete cascade,
  restaurant_id uuid not null,
  reason        text not null check (reason in ('inaccurate', 'inappropriate', 'wrong_image', 'wrong_price', 'wrong_category', 'other')),
  note          text check (note is null or char_length(note) <= 500),
  status        text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  raised_by     uuid not null references public.profiles (id) on delete cascade,
  raised_at     timestamptz not null default now(),
  resolution    text,
  resolved_by   uuid references public.profiles (id) on delete set null,
  resolved_at   timestamptz
);
create index if not exists listing_flags_status_idx on public.listing_flags (status, raised_at desc);
create index if not exists listing_flags_item_idx on public.listing_flags (menu_item_id);
create unique index if not exists listing_flags_one_open on public.listing_flags (menu_item_id, reason) where status = 'open';

alter table public.listing_flags enable row level security;
drop policy if exists "listing_flags — read" on public.listing_flags;
create policy "listing_flags — read" on public.listing_flags for select
  using (
    public.owns_restaurant(restaurant_id)
    or public.is_admin()
    or exists (select 1 from public.restaurants r where r.id = restaurant_id and public.manager_can_see_zone(r.zone_id))
  );
revoke all on public.listing_flags from anon, authenticated;
grant select on public.listing_flags to authenticated;

-- 6. What customers may read and order ----------------------------------------------------
drop policy if exists "menu — read" on public.menu_items;
create policy "menu — read" on public.menu_items for select
  using (
    -- Live: approved, or approved with a price change waiting (it sells at the old price).
    ((approval_status = 'approved' or (approval_status = 'pending' and pending_price is not null))
      and not hidden_by_ops
      and exists (select 1 from public.restaurants r where r.id = restaurant_id and r.approved))
    or public.owns_restaurant(restaurant_id)
    or public.is_admin()
    or exists (select 1 from public.restaurants r where r.id = restaurant_id and public.manager_can_see_zone(r.zone_id))
  );

-- 0062's order-line guard, unchanged except the dish must also be approved and
-- not hidden by Deligro.
create or replace function public.guard_order_item_insert()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  o            record;
  m            record;
  v            record;
  g            record;
  opts         jsonb := coalesce(new.options, '{}'::jsonb);
  variant_id   uuid;
  variant_json jsonb := null;
  addon_ids    uuid[];
  addons_json  jsonb;
  addons_total integer;
  chosen       integer;
  unit         integer;
  shop         text;
  local        timestamp := now() at time zone 'Asia/Kolkata';
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  select customer_id, restaurant_id, status, payment_status into o
    from public.orders where id = new.order_id;
  if not found or o.customer_id is distinct from auth.uid() or o.status <> 'placed' then
    raise exception 'order_items: you can only add items to your own new order';
  end if;

  -- 0055: once payment has started the total is what the customer is being charged.
  if o.payment_status is distinct from 'pending'
     or exists (select 1 from public.payments p where p.order_id = new.order_id) then
    raise exception 'order_items: payment has started for this order';
  end if;

  shop := public.restaurant_status_now(o.restaurant_id);
  if shop <> 'open' then
    raise exception 'order_items: restaurant_closed (%)', shop;
  end if;

  select name, price, discount_price, available, stock_qty, available_days, available_from, available_to,
         approval_status, pending_price, hidden_by_ops into m
    from public.menu_items
   where id = new.menu_item_id and restaurant_id = o.restaurant_id;
  if not found then
    raise exception 'order_items: item is not on this restaurant''s menu';
  end if;
  -- 0146: a new listing awaiting approval, a rejected one, or one hidden by Deligro.
  -- (A live dish with a price change waiting still sells, at its current price.)
  if not (m.approval_status = 'approved' or (m.approval_status = 'pending' and m.pending_price is not null))
     or m.hidden_by_ops then
    raise exception 'order_items: item is not available';
  end if;
  if m.available is not true then
    raise exception 'order_items: item is sold out';
  end if;
  if new.qty is null or new.qty < 1 then
    raise exception 'order_items: qty must be at least 1';
  end if;

  if (m.available_days is not null and cardinality(m.available_days) > 0
        and not (extract(dow from local)::smallint = any (m.available_days)))
     or (m.available_from is not null and m.available_to is not null and m.available_from <> m.available_to
        and case when m.available_from < m.available_to
                 then local::time < m.available_from or local::time >= m.available_to
                 else local::time < m.available_from and local::time >= m.available_to end) then
    raise exception 'order_items: % is not available right now', m.name;
  end if;

  if m.stock_qty is not null and m.stock_qty < new.qty then
    raise exception 'order_items: only % left of %', m.stock_qty, m.name;
  end if;

  -- Variant: required whenever the dish has any available variant.
  variant_id := nullif(opts ->> 'variantId', '')::uuid;
  if variant_id is not null
     or exists (select 1 from public.menu_item_variants x where x.menu_item_id = new.menu_item_id and x.available) then
    if variant_id is null then
      raise exception 'order_items: choose a size (variant) for %', m.name;
    end if;
    select id, name, price, available into v
      from public.menu_item_variants where id = variant_id and menu_item_id = new.menu_item_id;
    if not found or v.available is not true then
      raise exception 'order_items: that variant of % is not available', m.name;
    end if;
    unit := v.price;
    variant_json := jsonb_build_object('id', v.id, 'name', v.name, 'price', v.price);
  else
    -- Same rule as effectivePrice() in src/lib/utils/cart.ts.
    unit := case
      when m.discount_price is null or m.discount_price < 0 or m.discount_price >= m.price then m.price
      else m.discount_price
    end;
  end if;

  -- Add-ons: each must belong to one of this dish's groups and be available;
  -- each group's minimum and maximum hold (repeats count).
  addon_ids := coalesce(array(select (e)::uuid from jsonb_array_elements_text(coalesce(opts -> 'addonIds', '[]'::jsonb)) e), '{}');
  if exists (
    select 1 from unnest(addon_ids) x(id)
     where not exists (
       select 1 from public.menu_item_addons ad
         join public.menu_item_addon_groups gr on gr.id = ad.group_id
        where ad.id = x.id and gr.menu_item_id = new.menu_item_id and ad.available
     )
  ) then
    raise exception 'order_items: an add-on you chose is not available for %', m.name;
  end if;
  for g in select id, name, min_select, max_select from public.menu_item_addon_groups where menu_item_id = new.menu_item_id loop
    select count(*) into chosen from unnest(addon_ids) x(id) join public.menu_item_addons ad on ad.id = x.id where ad.group_id = g.id;
    if chosen < g.min_select then
      raise exception 'order_items: choose at least % from % for %', g.min_select, g.name, m.name;
    end if;
    if chosen > g.max_select then
      raise exception 'order_items: choose at most % from % for %', g.max_select, g.name, m.name;
    end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('id', ad.id, 'name', ad.name, 'price', ad.price, 'group', gr.name)
                            order by gr.sort_order, gr.name, ad.sort_order, ad.name), '[]'::jsonb),
         coalesce(sum(ad.price), 0)
    into addons_json, addons_total
    from unnest(addon_ids) x(id)
    join public.menu_item_addons ad on ad.id = x.id
    join public.menu_item_addon_groups gr on gr.id = ad.group_id;

  new.price := unit + addons_total;
  new.name := m.name || case when variant_json is null then '' else ' (' || (variant_json ->> 'name') || ')' end;
  new.options := case
    when variant_json is null and cardinality(addon_ids) = 0 then null
    else jsonb_build_object('variant', variant_json, 'addons', addons_json)
  end;
  return new;
end;
$$;

-- 7. Product RPCs ------------------------------------------------------------------------
create or replace function public._ops_item_zone(p_item uuid)
returns table (restaurant_id uuid, zone_id uuid)
language sql stable security definer set search_path = public as $$
  select mi.restaurant_id, r.zone_id from public.menu_items mi join public.restaurants r on r.id = mi.restaurant_id
   where mi.id = p_item;
$$;
revoke execute on function public._ops_item_zone(uuid) from public, anon, authenticated, service_role;

create or replace function public.ops_flag_listing(
  p_actor uuid, p_item uuid, p_reason text, p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  z      record;
  fid    uuid;
  v_note constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into z from public._ops_item_zone(p_item);
  if z.restaurant_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, z.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    select (after ->> 'flagId')::uuid into fid from public.ops_audit_log where client_action_id = p_client_action_id and actor_id = p_actor;
    return jsonb_build_object('flag_id', fid);
  end if;
  if p_reason not in ('inaccurate', 'inappropriate', 'wrong_image', 'wrong_price', 'wrong_category', 'other')
     or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  select id into fid from public.listing_flags where menu_item_id = p_item and reason = p_reason and status = 'open';
  if fid is not null then
    return jsonb_build_object('flag_id', fid);
  end if;
  insert into public.listing_flags (menu_item_id, restaurant_id, reason, note, raised_by)
  values (p_item, z.restaurant_id, p_reason, v_note, p_actor)
  returning id into fid;
  perform public._ops_log(p_actor, 'product.flag', 'product', p_item::text, z.zone_id, v_note, null,
                          jsonb_build_object('flagId', fid, 'reason', p_reason), p_client_action_id);
  return jsonb_build_object('flag_id', fid);
end;
$$;

create or replace function public.ops_set_listing_hidden(
  p_actor uuid, p_item uuid, p_hidden boolean, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  z      record;
  was    boolean;
  reason constant text := trim(coalesce(p_reason, ''));
begin
  select * into z from public._ops_item_zone(p_item);
  if z.restaurant_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, z.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('item_id', p_item);
  end if;
  if char_length(reason) < 3 or char_length(reason) > 300 or p_hidden is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  select hidden_by_ops into was from public.menu_items where id = p_item for update;
  if was = p_hidden then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  perform set_config('deligro.ops_moderation', 'on', true);
  perform public._ops_set_actor(p_actor, reason);
  update public.menu_items
     set hidden_by_ops = p_hidden, hidden_reason = case when p_hidden then reason end,
         moderated_by = p_actor, moderated_at = now()
   where id = p_item;
  perform set_config('deligro.ops_moderation', '', true);
  perform public._ops_log(p_actor, case when p_hidden then 'product.hide' else 'product.unhide' end, 'product', p_item::text,
                          z.zone_id, reason, jsonb_build_object('hidden', was), jsonb_build_object('hidden', p_hidden), p_client_action_id);
  return jsonb_build_object('item_id', p_item);
end;
$$;

create or replace function public.ops_decide_listing(
  p_actor uuid, p_item uuid, p_decision text, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  z      record;
  m      record;
  reason constant text := nullif(trim(coalesce(p_reason, '')), '');
  target text;
begin
  select * into z from public._ops_item_zone(p_item);
  if z.restaurant_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, z.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('item_id', p_item);
  end if;
  select approval_status, price, pending_price into m from public.menu_items where id = p_item for update;
  if p_decision not in ('approve', 'reject') or m.approval_status <> 'pending' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if p_decision = 'reject' and (reason is null or char_length(reason) < 3) then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if reason is not null and char_length(reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  target := case when p_decision = 'approve' or m.pending_price is not null then 'approved' else 'rejected' end;
  perform set_config('deligro.ops_moderation', 'on', true);
  perform public._ops_set_actor(p_actor, reason);
  update public.menu_items
     set approval_status = target,
         price = case when p_decision = 'approve' and pending_price is not null then pending_price else price end,
         pending_price = null,
         approval_note = reason,
         moderated_by = p_actor,
         moderated_at = now()
   where id = p_item;
  perform set_config('deligro.ops_moderation', '', true);
  perform public._ops_log(p_actor, 'product.' || p_decision, 'product', p_item::text, z.zone_id, reason,
                          jsonb_build_object('approvalStatus', m.approval_status, 'price', m.price, 'pendingPrice', m.pending_price),
                          jsonb_build_object('approvalStatus', target), p_client_action_id);
  return jsonb_build_object('item_id', p_item, 'approval_status', target);
end;
$$;

create or replace function public.ops_resolve_listing_flag(
  p_actor uuid, p_flag uuid, p_status text, p_resolution text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  f            record;
  v_resolution constant text := nullif(trim(coalesce(p_resolution, '')), '');
begin
  select lf.id, lf.menu_item_id, lf.status, r.zone_id into f
    from public.listing_flags lf join public.restaurants r on r.id = lf.restaurant_id
   where lf.id = p_flag for update of lf;
  if f.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, f.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('flag_id', p_flag);
  end if;
  if p_status not in ('resolved', 'dismissed') or f.status <> 'open' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if v_resolution is null or char_length(v_resolution) < 3 or char_length(v_resolution) > 500 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  update public.listing_flags
     set status = p_status, resolution = v_resolution, resolved_by = p_actor, resolved_at = now()
   where id = p_flag;
  perform public._ops_log(p_actor, 'product.flag.' || p_status, 'product', f.menu_item_id::text, f.zone_id, v_resolution,
                          jsonb_build_object('flagId', p_flag, 'status', 'open'),
                          jsonb_build_object('flagId', p_flag, 'status', p_status), p_client_action_id);
  return jsonb_build_object('flag_id', p_flag);
end;
$$;

-- Stock stays the vendor's unless a manager holds manager.products.adjust_stock
-- (checked by the route). 0062's menu_stock_rules then decide availability.
create or replace function public.ops_adjust_stock(
  p_actor uuid, p_item uuid, p_stock_qty integer, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  z      record;
  was    integer;
  reason constant text := trim(coalesce(p_reason, ''));
begin
  select * into z from public._ops_item_zone(p_item);
  if z.restaurant_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, z.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('item_id', p_item);
  end if;
  if char_length(reason) < 3 or char_length(reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_stock_qty is not null and (p_stock_qty < 0 or p_stock_qty > 100000) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  select stock_qty into was from public.menu_items where id = p_item for update;
  perform set_config('deligro.ops_moderation', 'on', true);
  perform public._ops_set_actor(p_actor, reason);
  update public.menu_items set stock_qty = p_stock_qty where id = p_item;
  perform set_config('deligro.ops_moderation', '', true);
  perform public._ops_log(p_actor, 'product.stock', 'product', p_item::text, z.zone_id, reason,
                          jsonb_build_object('stockQty', was), jsonb_build_object('stockQty', p_stock_qty), p_client_action_id);
  return jsonb_build_object('item_id', p_item);
end;
$$;

-- A platform-wide list: any admin or manager (the route checks
-- manager.products.moderate); not zone-scoped.
create or replace function public.ops_set_restricted_category(
  p_actor uuid, p_name text, p_restricted boolean, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  role_name text;
  v_name    constant text := lower(btrim(coalesce(p_name, '')));
  reason    constant text := trim(coalesce(p_reason, ''));
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.role::text into role_name from public.profiles p where p.id = p_actor;
  if role_name is null or role_name not in ('admin', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('name', v_name);
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 60 or p_restricted is null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if char_length(reason) < 3 or char_length(reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_restricted then
    insert into public.listing_restricted_categories (name, note, created_by) values (v_name, reason, p_actor)
    on conflict (name) do nothing;
  else
    delete from public.listing_restricted_categories where name = v_name;
  end if;
  perform public._ops_log(p_actor, 'product.restricted_category', 'category', v_name, null, reason, null,
                          jsonb_build_object('name', v_name, 'restricted', p_restricted), p_client_action_id);
  return jsonb_build_object('name', v_name, 'restricted', p_restricted);
end;
$$;

revoke execute on function public.ops_flag_listing(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_set_listing_hidden(uuid, uuid, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.ops_decide_listing(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_resolve_listing_flag(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_adjust_stock(uuid, uuid, integer, text, text) from public, anon, authenticated;
revoke execute on function public.ops_set_restricted_category(uuid, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.ops_flag_listing(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_set_listing_hidden(uuid, uuid, boolean, text, text) to service_role;
grant execute on function public.ops_decide_listing(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_resolve_listing_flag(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_adjust_stock(uuid, uuid, integer, text, text) to service_role;
grant execute on function public.ops_set_restricted_category(uuid, text, boolean, text, text) to service_role;

commit;
