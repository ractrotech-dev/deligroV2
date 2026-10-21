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
--   * Restricted dishes: a vendor's main-price change is parked; a discount
--     price, size or add-on change, or a category move into / out of / between
--     restricted categories, takes the dish off sale until a manager approves
--     (guard_menu_option_moderation on the 0062 option tables). Nothing a
--     customer pays on a restricted dish is ever unapproved.
--   * The restricted-category list is admin-only (platform-wide).
--   * ops_adjust_stock takes the count the manager saw and refuses a stale one.
--   * listing_image_reviews (§12.7): RLS on, admin / zone-manager read, written
--     only by ops_review_listing_image.
--   * New tables listing_restricted_categories, menu_item_changes,
--     listing_flags: RLS on; reads for the shop owner (own shop), admins and
--     the zone's managers; no write for anon/authenticated (history is written
--     by a security definer trigger, the rest by the ops_* RPCs).
--   * Every ops_* function here is service_role only and re-checks the actor's
--     zone in the database (ops_require_staff); each sets the session flag
--     `deligro.ops_moderation` locally so the guard lets its write through.
--
-- Rollback:
--   drop function if exists public.ops_product_insights(uuid[], uuid, timestamptz, timestamptz, integer);
--   drop function if exists public.ops_product_counts(uuid[], uuid, text, boolean, text);
--   drop function if exists public.ops_review_listing_image(uuid, bigint, text, text, text, text);
--   drop function if exists public.ops_image_review_queue(uuid[], uuid, bigint, integer);
--   drop table if exists public.listing_image_reviews;
--   drop trigger if exists guard_menu_option_moderation on public.menu_item_variants;
--   drop trigger if exists guard_menu_option_moderation on public.menu_item_addon_groups;
--   drop trigger if exists guard_menu_option_moderation on public.menu_item_addons;
--   drop function if exists public.guard_menu_option_moderation();
--   drop function if exists public.menu_moderation_trusted();  -- after guard_menu_item_moderation
--   drop function if exists public.ops_flag_listing(uuid, uuid, text, text, text);
--   drop function if exists public.ops_set_listing_hidden(uuid, uuid, boolean, text, text);
--   drop function if exists public.ops_decide_listing(uuid, uuid, text, text, text);
--   drop function if exists public.ops_resolve_listing_flag(uuid, uuid, text, text, text);
--   drop function if exists public.ops_adjust_stock(uuid, uuid, integer, integer, text, text);
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
-- Who may change a listing without moderation: admins, the service role and
-- the database owner, and the ops_* RPCs (which set deligro.ops_moderation).
create or replace function public.menu_moderation_trusted()
returns boolean
language sql stable security invoker set search_path = public as $$
  select public.is_admin()
      or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
      or current_user in ('postgres', 'supabase_admin')
      or coalesce(current_setting('deligro.ops_moderation', true), '') = 'on';
$$;

-- For a vendor's edit of a restricted dish, what reaches a customer's bill is
-- held for approval:
--   * the main price of a live dish is parked (it keeps selling at the old one);
--   * a discount price, or a size / add-on change (deligro.option_hold, set by
--     guard_menu_option_moderation), takes the dish off sale until approved —
--     those prices have no parking slot, so nothing unapproved is ever charged;
--   * a category move into, out of or between restricted categories is a new
--     listing (off sale until approved), and drops any parked price so an
--     approval can never apply a stale one.
-- A rejection keeps the dish off sale until the vendor edits it (resubmits).
create or replace function public.guard_menu_item_moderation()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  hold     constant text := nullif(current_setting('deligro.option_hold', true), '');
  was_live boolean;
  now_r    boolean;
  was_r    boolean;
begin
  new.updated_at := now();
  if public.menu_moderation_trusted() then
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

  was_live := old.approval_status = 'approved' or (old.approval_status = 'pending' and old.pending_price is not null);
  now_r := public.is_restricted_category(new.category);
  was_r := public.is_restricted_category(old.category);

  -- A size or add-on of a restricted dish changed (guard_menu_option_moderation).
  if hold is not null and now_r then
    -- The price under review becomes the one the vendor asked for; nobody pays it until approval.
    new.price := coalesce(old.pending_price, new.price);
    new.pending_price := null;
    new.approval_status := 'pending';
    new.approval_note := hold;
    return new;
  end if;

  if new.category is distinct from old.category then
    new.pending_price := null;
    if now_r then
      new.approval_status := 'pending';
      new.approval_note := 'Moved to the restricted category ' || btrim(new.category);
      return new;
    elsif was_r and old.approval_status <> 'rejected' then
      new.approval_status := 'pending';
      new.approval_note := 'Moved out of the restricted category ' || btrim(old.category);
      return new;
    end if;
  elsif now_r and was_live then
    if new.discount_price is distinct from old.discount_price then
      new.price := case when new.price is distinct from old.price then new.price else coalesce(old.pending_price, new.price) end;
      new.pending_price := null;
      new.approval_status := 'pending';
      new.approval_note := 'Discount price changed';
      return new;
    elsif new.price is distinct from old.price then
      -- A live restricted dish keeps its old price until the new one is approved.
      new.pending_price := new.price;
      new.price := old.price;
      new.approval_status := 'pending';
    end if;
  end if;

  -- Editing a rejected listing resubmits it.
  if old.approval_status = 'rejected'
     and (new.name, new.price, new.discount_price, new.category, new.description, new.image_url)
         is distinct from (old.name, old.price, old.discount_price, old.category, old.description, old.image_url) then
    new.approval_status := 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_menu_item_moderation on public.menu_items;
create trigger guard_menu_item_moderation
  before insert or update on public.menu_items
  for each row execute function public.guard_menu_item_moderation();

-- Sizes and add-ons (0062) price the order line too. A vendor's change to them
-- on a restricted dish — adding or removing a size, group or add-on, or
-- changing a price, availability or a group's limits — sends the dish back for
-- approval: it re-saves the dish with deligro.option_hold set, and the guard
-- above takes it off sale. Renames pass. Invoker: the write goes through the
-- vendor's own "menu — owner manage" policy, so a vendor can only ever hold
-- their own dish.
create or replace function public.guard_menu_option_moderation()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  item_id uuid;
  what    text;
begin
  if public.menu_moderation_trusted() then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'menu_item_variants' then
    if tg_op = 'DELETE' then
      item_id := old.menu_item_id; what := 'Size removed: ' || coalesce(old.name, '');
    elsif tg_op = 'INSERT' then
      item_id := new.menu_item_id; what := 'Size added: ' || coalesce(new.name, '');
    elsif (new.price, new.available, new.menu_item_id) is distinct from (old.price, old.available, old.menu_item_id) then
      item_id := new.menu_item_id; what := 'Size changed: ' || coalesce(new.name, '');
    end if;
  elsif tg_table_name = 'menu_item_addon_groups' then
    if tg_op = 'DELETE' then
      item_id := old.menu_item_id; what := 'Add-on group removed: ' || coalesce(old.name, '');
    elsif tg_op = 'INSERT' then
      item_id := new.menu_item_id; what := 'Add-on group added: ' || coalesce(new.name, '');
    elsif (new.min_select, new.max_select, new.menu_item_id) is distinct from (old.min_select, old.max_select, old.menu_item_id) then
      item_id := new.menu_item_id; what := 'Add-on group limits changed: ' || coalesce(new.name, '');
    end if;
  else -- menu_item_addons
    if tg_op = 'DELETE' then
      select g.menu_item_id into item_id from public.menu_item_addon_groups g where g.id = old.group_id;
      what := 'Add-on removed: ' || coalesce(old.name, '');
    elsif tg_op = 'INSERT' then
      select g.menu_item_id into item_id from public.menu_item_addon_groups g where g.id = new.group_id;
      what := 'Add-on added: ' || coalesce(new.name, '');
    elsif (new.price, new.available, new.group_id) is distinct from (old.price, old.available, old.group_id) then
      select g.menu_item_id into item_id from public.menu_item_addon_groups g where g.id = new.group_id;
      what := 'Add-on changed: ' || coalesce(new.name, '');
    end if;
  end if;

  if item_id is not null
     and public.is_restricted_category((select mi.category from public.menu_items mi where mi.id = item_id)) then
    perform set_config('deligro.option_hold', left(what, 200), true);
    update public.menu_items set updated_at = now() where id = item_id;
    perform set_config('deligro.option_hold', '', true);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists guard_menu_option_moderation on public.menu_item_variants;
create trigger guard_menu_option_moderation
  after insert or update or delete on public.menu_item_variants
  for each row execute function public.guard_menu_option_moderation();
drop trigger if exists guard_menu_option_moderation on public.menu_item_addon_groups;
create trigger guard_menu_option_moderation
  after insert or update or delete on public.menu_item_addon_groups
  for each row execute function public.guard_menu_option_moderation();
drop trigger if exists guard_menu_option_moderation on public.menu_item_addons;
create trigger guard_menu_option_moderation
  after insert or update or delete on public.menu_item_addons
  for each row execute function public.guard_menu_option_moderation();

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
    -- A new dish records its moderation state and its photo (§12.7 reviews it).
    if tg_op = 'INSERT' and f not in ('approval_status', 'image_url') then
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
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
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
-- p_expected_stock is the count the manager was shown (null = untracked): an
-- order or the vendor moving stock in between makes the adjustment stale
-- rather than silently overwriting it.
drop function if exists public.ops_adjust_stock(uuid, uuid, integer, text, text);
create or replace function public.ops_adjust_stock(
  p_actor uuid, p_item uuid, p_stock_qty integer, p_expected_stock integer, p_reason text, p_client_action_id text
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
  if was is distinct from p_expected_stock then
    raise exception 'stale' using errcode = '40001', detail = coalesce(was::text, 'untracked');
  end if;
  perform set_config('deligro.ops_moderation', 'on', true);
  perform public._ops_set_actor(p_actor, reason);
  update public.menu_items set stock_qty = p_stock_qty where id = p_item;
  perform set_config('deligro.ops_moderation', '', true);
  perform public._ops_log(p_actor, 'product.stock', 'product', p_item::text, z.zone_id, reason,
                          jsonb_build_object('stockQty', was), jsonb_build_object('stockQty', p_stock_qty), p_client_action_id);
  return jsonb_build_object('item_id', p_item);
end;
$$;

-- A platform-wide list, so admins only: a zone's manager must not change
-- moderation for every other zone's vendors.
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
  if role_name is distinct from 'admin' then
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

-- 8. Product sales (§12.10) -----------------------------------------------------------
-- Units and line revenue (qty × price) per dish over [p_start, p_end), on the
-- orders every other figure counts (ops_counts_as_order, 0144) that were not
-- cancelled. Summed here so a zone's month of order lines never travels to the
-- server. Parity with a row-by-row sum: scripts/qa/ops-sql-parity.ts.
create or replace function public.ops_product_sales(
  p_zone_ids uuid[], p_start timestamptz, p_end timestamptz, p_restaurant uuid default null
)
returns table (menu_item_id uuid, units bigint, revenue bigint, orders bigint)
language sql stable set search_path = public as $$
  select oi.menu_item_id, sum(oi.qty)::bigint, sum(oi.qty * oi.price)::bigint, count(distinct oi.order_id)::bigint
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where oi.menu_item_id is not null
     and o.created_at >= p_start and o.created_at < p_end
     and o.status::text <> 'cancelled'
     and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
     and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
     and (p_restaurant is null or o.restaurant_id = p_restaurant)
   group by oi.menu_item_id;
$$;

-- One dish, day by day (IST), for its detail chart.
create or replace function public.ops_product_daily(p_item uuid, p_start timestamptz, p_end timestamptz)
returns table (day date, units bigint)
language sql stable set search_path = public as $$
  select (o.created_at at time zone 'Asia/Kolkata')::date, sum(oi.qty)::bigint
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where oi.menu_item_id = p_item
     and o.created_at >= p_start and o.created_at < p_end
     and o.status::text <> 'cancelled'
     and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
   group by 1
   order by 1;
$$;

-- 9. Image review (§12.7) ----------------------------------------------------------------
-- A vendor's new or changed dish photo waits in a review queue until a manager
-- marks it fine or flags it. Only the photo a dish shows now is reviewed: a
-- superseded change drops out of the queue on its own.
create table if not exists public.listing_image_reviews (
  change_id    bigint primary key references public.menu_item_changes (id) on delete cascade,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  outcome      text not null check (outcome in ('ok', 'flagged')),
  flag_id      uuid references public.listing_flags (id) on delete set null,
  note         text check (note is null or char_length(note) <= 500),
  reviewed_by  uuid not null references public.profiles (id),
  reviewed_at  timestamptz not null default now()
);
create index if not exists listing_image_reviews_item_idx on public.listing_image_reviews (menu_item_id);
create index if not exists menu_item_changes_image_idx on public.menu_item_changes (id desc) where field = 'image_url';

alter table public.listing_image_reviews enable row level security;
drop policy if exists "listing_image_reviews — read" on public.listing_image_reviews;
create policy "listing_image_reviews — read" on public.listing_image_reviews for select
  using (
    public.is_admin()
    or exists (select 1 from public.menu_items mi join public.restaurants r on r.id = mi.restaurant_id
                where mi.id = menu_item_id and public.manager_can_see_zone(r.zone_id))
  );
revoke all on public.listing_image_reviews from anon, authenticated;
grant select on public.listing_image_reviews to authenticated;

-- Newest first; p_before pages by change id. p_zone_ids null = every zone (admins).
create or replace function public.ops_image_review_queue(
  p_zone_ids uuid[], p_restaurant uuid, p_before bigint, p_limit integer
)
returns table (change_id bigint, menu_item_id uuid, restaurant_id uuid, old_value text, new_value text,
               actor_id uuid, created_at timestamptz)
language sql stable set search_path = public as $$
  select c.id, c.menu_item_id, c.restaurant_id, c.old_value, c.new_value, c.actor_id, c.created_at
    from public.menu_item_changes c
    join public.menu_items mi on mi.id = c.menu_item_id
    join public.restaurants r on r.id = c.restaurant_id
   where c.field = 'image_url'
     and c.source = 'vendor'
     and c.new_value is not null
     and c.new_value = mi.image_url
     and (p_zone_ids is null or r.zone_id = any (p_zone_ids))
     and (p_restaurant is null or c.restaurant_id = p_restaurant)
     and (p_before is null or c.id < p_before)
     and not exists (select 1 from public.listing_image_reviews v where v.change_id = c.id)
     and not exists (select 1 from public.menu_item_changes later
                      where later.menu_item_id = c.menu_item_id and later.field = 'image_url' and later.id > c.id)
   order by c.id desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function public.ops_review_listing_image(
  p_actor uuid, p_change bigint, p_outcome text, p_flag_reason text, p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c      record;
  fid    uuid;
  v_note constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  select ch.id, ch.menu_item_id, ch.restaurant_id, ch.field, r.zone_id into c
    from public.menu_item_changes ch join public.restaurants r on r.id = ch.restaurant_id
   where ch.id = p_change;
  if c.id is null or c.field <> 'image_url' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, c.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    select (after ->> 'flagId')::uuid into fid from public.ops_audit_log where client_action_id = p_client_action_id and actor_id = p_actor;
    return jsonb_build_object('change_id', p_change, 'flag_id', fid);
  end if;
  if p_outcome not in ('ok', 'flag')
     or exists (select 1 from public.listing_image_reviews v where v.change_id = p_change) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_outcome = 'flag' then
    if p_flag_reason is null or p_flag_reason not in ('wrong_image', 'inappropriate') then
      raise exception 'invalid_transition' using errcode = '22023';
    end if;
    if v_note is null or char_length(v_note) < 3 then
      raise exception 'reason_required' using errcode = '22023';
    end if;
    select id into fid from public.listing_flags where menu_item_id = c.menu_item_id and reason = p_flag_reason and status = 'open';
    if fid is null then
      insert into public.listing_flags (menu_item_id, restaurant_id, reason, note, raised_by)
      values (c.menu_item_id, c.restaurant_id, p_flag_reason, v_note, p_actor)
      returning id into fid;
    end if;
  end if;
  insert into public.listing_image_reviews (change_id, menu_item_id, outcome, flag_id, note, reviewed_by)
  values (p_change, c.menu_item_id, case when p_outcome = 'ok' then 'ok' else 'flagged' end, fid, v_note, p_actor);
  perform public._ops_log(p_actor, 'product.image_review', 'product', c.menu_item_id::text, c.zone_id, v_note, null,
                          jsonb_build_object('changeId', p_change, 'outcome', p_outcome, 'flagId', fid), p_client_action_id);
  return jsonb_build_object('change_id', p_change, 'flag_id', fid);
end;
$$;

-- 10. Product list counts and insights, summed here --------------------------------------
-- The counts a product list shows above its rows, for the same filters the
-- list applies (zone, shop, category or uncategorised, name search). One query
-- instead of six; the list asks for it on its first page only.
create or replace function public.ops_product_counts(
  p_zone_ids uuid[], p_restaurant uuid, p_category text, p_uncategorised boolean, p_term text
)
returns table (unavailable integer, out_of_stock integer, low_stock integer, pending_approval integer,
               hidden integer, open_flags integer)
language sql stable set search_path = public as $$
  with items as (
    select mi.id, mi.available, mi.sold_out_by_stock, mi.stock_qty, mi.low_stock_at, mi.approval_status, mi.hidden_by_ops
      from public.menu_items mi
      join public.restaurants r on r.id = mi.restaurant_id
     where (p_zone_ids is null or r.zone_id = any (p_zone_ids))
       and (p_restaurant is null or mi.restaurant_id = p_restaurant)
       and (case when coalesce(p_uncategorised, false) then mi.category is null
                 when p_category is not null then mi.category = p_category
                 else true end)
       and (p_term is null or p_term = ''
            or mi.name ilike '%' || replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_') || '%')
  )
  select (count(*) filter (where not available))::integer,
         (count(*) filter (where sold_out_by_stock or stock_qty = 0))::integer,
         (count(*) filter (where stock_qty > 0 and low_stock_at is not null and stock_qty <= low_stock_at))::integer,
         (count(*) filter (where approval_status = 'pending'))::integer,
         (count(*) filter (where hidden_by_ops))::integer,
         (select count(*) from public.listing_flags lf join items i on i.id = lf.menu_item_id where lf.status = 'open')::integer
    from items;
$$;

-- §12.3, §12.5, §12.6, §12.10 in one bounded answer: at most p_limit rows per
-- section, so a platform-wide scope never ships its whole menu to the server.
-- Each section mirrors buildProductInsights / availabilityStats
-- (src/lib/ops/product-*.ts); parity: scripts/qa/manager-product-insights-sql.ts.
--   top / slow  dishes a customer could buy, by units then revenue (ties: id)
--   price       price changes inside [p_start, p_end), newest first
--   oos         out of stock (sold out by stock or stock 0), by id
--   unavailable unavailable ≥ 3 times or ≥ 24 h in the range; the state at the
--               start is the last change before it, else the opposite of the
--               first change after it, else the dish's current value
create or replace function public.ops_product_insights(
  p_zone_ids uuid[], p_restaurant uuid, p_start timestamptz, p_end timestamptz, p_limit integer
)
returns table (section text, menu_item_id uuid, units bigint, revenue bigint, times integer, down_ms bigint,
               at timestamptz, old_value text, new_value text, source text)
language sql stable set search_path = public as $$
  with items as (
    select mi.id, mi.available, mi.approval_status, mi.pending_price, mi.hidden_by_ops, mi.stock_qty, mi.sold_out_by_stock
      from public.menu_items mi
      join public.restaurants r on r.id = mi.restaurant_id
     where (p_zone_ids is null or r.zone_id = any (p_zone_ids))
       and (p_restaurant is null or mi.restaurant_id = p_restaurant)
  ),
  lim as (select greatest(1, least(coalesce(p_limit, 20), 100)) as n),
  sales as (
    select s.menu_item_id, s.units, s.revenue from public.ops_product_sales(p_zone_ids, p_start, p_end, p_restaurant) s
  ),
  sellable as (
    select i.id, coalesce(s.units, 0)::bigint as units, coalesce(s.revenue, 0)::bigint as revenue
      from items i left join sales s on s.menu_item_id = i.id
     where i.available and not i.hidden_by_ops and i.approval_status <> 'rejected'
       and not (i.approval_status = 'pending' and i.pending_price is null)
  ),
  top as (
    select 'top'::text as sec, id, units, revenue from sellable where units > 0
     order by units desc, revenue desc, id limit (select n from lim)
  ),
  slow as (
    select 'slow'::text as sec, id, units, revenue from sellable
     order by units asc, revenue asc, id limit (select n from lim)
  ),
  oos as (
    select 'oos'::text as sec, id from items where sold_out_by_stock or stock_qty = 0 order by id limit (select n from lim)
  ),
  price as (
    select 'price'::text as sec, c.menu_item_id, c.created_at, c.old_value, c.new_value, c.source
      from public.menu_item_changes c join items i on i.id = c.menu_item_id
     where c.field = 'price' and c.created_at >= p_start and c.created_at < p_end
     order by c.created_at desc, c.id limit (select n from lim)
  ),
  avail as (
    select c.menu_item_id as id, c.id as cid, c.created_at as t, c.new_value = 'true' as to_
      from public.menu_item_changes c join items i on i.id = c.menu_item_id
     where c.field = 'available'
  ),
  init as (
    select i.id,
           coalesce(
             (select a.to_ from avail a where a.id = i.id and a.t < p_start order by a.t desc, a.cid desc limit 1),
             (select not a.to_ from avail a where a.id = i.id and a.t >= p_start order by a.t, a.cid limit 1),
             i.available) as s0
      from items i
  ),
  pts as (
    select id, p_start as t, 0 as ord, 0::bigint as cid, s0 as st, false as is_change from init
    union all
    select id, t, 1, cid, coalesce(to_, false), true from avail where t >= p_start and t < p_end
  ),
  seg as (
    select id, st, is_change,
           lag(st) over w as prev,
           lead(t, 1, p_end) over w as nt,
           t
      from pts
    window w as (partition by id order by t, ord, cid)
  ),
  agg as (
    select id,
           (count(*) filter (where is_change and prev and not st))::integer as times,
           coalesce(round(sum(extract(epoch from (nt - t)) * 1000) filter (where not st)), 0)::bigint as down_ms
      from seg group by id
  ),
  unavailable as (
    select 'unavailable'::text as sec, id, times, down_ms from agg
     where times >= 3 or round(down_ms / 36000.0) >= 2400
     order by round(down_ms / 36000.0) desc, times desc, id limit (select n from lim)
  )
  select t.sec, t.id, t.units, t.revenue, null::integer, null::bigint, null::timestamptz, null::text, null::text, null::text from top t
  union all select s.sec, s.id, s.units, s.revenue, null, null, null, null, null, null from slow s
  union all select o.sec, o.id, null, null, null, null, null, null, null, null from oos o
  union all select p.sec, p.menu_item_id, null, null, null, null, p.created_at, p.old_value, p.new_value, p.source from price p
  union all select u.sec, u.id, null, null, u.times, u.down_ms, null, null, null, null from unavailable u;
$$;

revoke execute on function public.ops_image_review_queue(uuid[], uuid, bigint, integer) from public, anon, authenticated;
revoke execute on function public.ops_review_listing_image(uuid, bigint, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_product_counts(uuid[], uuid, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.ops_product_insights(uuid[], uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.ops_image_review_queue(uuid[], uuid, bigint, integer) to service_role;
grant execute on function public.ops_review_listing_image(uuid, bigint, text, text, text, text) to service_role;
grant execute on function public.ops_product_counts(uuid[], uuid, text, boolean, text) to service_role;
grant execute on function public.ops_product_insights(uuid[], uuid, timestamptz, timestamptz, integer) to service_role;

revoke execute on function public.ops_product_sales(uuid[], timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.ops_product_daily(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.ops_product_sales(uuid[], timestamptz, timestamptz, uuid) to service_role;
grant execute on function public.ops_product_daily(uuid, timestamptz, timestamptz) to service_role;

revoke execute on function public.ops_flag_listing(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_set_listing_hidden(uuid, uuid, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.ops_decide_listing(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_resolve_listing_flag(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_adjust_stock(uuid, uuid, integer, integer, text, text) from public, anon, authenticated;
revoke execute on function public.ops_set_restricted_category(uuid, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.ops_flag_listing(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_set_listing_hidden(uuid, uuid, boolean, text, text) to service_role;
grant execute on function public.ops_decide_listing(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_resolve_listing_flag(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_adjust_stock(uuid, uuid, integer, integer, text, text) to service_role;
grant execute on function public.ops_set_restricted_category(uuid, text, boolean, text, text) to service_role;

commit;
