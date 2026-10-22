-- ============================================================
-- 0161 — Offers for managers: eligibility, a change log, audited writes
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database. Runs after 0160.
-- Builds on 0064's coupons.starts_at (not added again) and its price_coupon().
--
--   * coupons.updated_at (touched on every change) — the edit-conflict token.
--   * coupon_restaurants / coupon_zones / coupon_items: who and what a code is
--     for. coupons.restaurant_id keeps working: a trigger mirrors it into
--     coupon_restaurants, so a single-shop vendor code is one row there.
--   * coupon_changes: every insert, update and delete on coupons and the three
--     lists, written by trigger whoever made it (vendor in the Partner app,
--     admin, manager), with the actor and reason the server set. Insert-only.
--   * price_coupon(c, subtotal, rid, customer, p_zone, p_eligible_subtotal):
--     0064's body plus vendor-list, zone-list and item-list rules. With items
--     the discount is on the eligible lines only; min_order is the whole basket.
--     The old 4-argument form is dropped (it would be ambiguous with defaults);
--     every 4-argument call resolves to this one.
--   * apply_coupon_to_order: 0056's body (ownership, 'placed', the per-code
--     advisory lock, redemption row, funded_by) plus the zone and the eligible
--     subtotal from the order's own lines.
--   * preview_coupon(p_code, p_restaurant, p_items jsonb): prices the basket
--     from menu_items (server prices) so a preview agrees with the bill.
--   * manager_can_see_offer(code) + a manager read policy on coupons and lists.
--   * ops_upsert_offer / ops_offer_action (service role, audited) and the real
--     _ops_create_offer_internal that 0160's request decision calls.
--
-- Rollback:
--   drop function if exists public.ops_offer_action(uuid, text, text, text, text),
--     public.ops_upsert_offer(uuid, text, jsonb, timestamptz, text, text), public._ops_offer_write(uuid, text, jsonb, boolean),
--     public._ops_offer_state(text, boolean), public.preview_coupon(text, uuid, jsonb), public.manager_can_see_offer(text),
--     public.log_coupon_change(), public.mirror_coupon_restaurant(), public.touch_coupon(), public.refuse_coupon_change_edit(),
--     public.price_coupon(public.coupons, integer, uuid, uuid, uuid, integer);
--   -- re-run 0064's price_coupon(), 0056's apply_coupon_to_order() and 0160's _ops_create_offer_internal stub
--   drop table if exists public.coupon_changes, public.coupon_items, public.coupon_zones, public.coupon_restaurants;
--   alter table public.coupons drop column if exists updated_at;
-- ============================================================

begin;

-- 1. The edit-conflict token ------------------------------------------------------
alter table public.coupons add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_coupon()
returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists touch_coupon on public.coupons;
create trigger touch_coupon before update on public.coupons for each row execute function public.touch_coupon();

-- 2. Eligibility lists -----------------------------------------------------------
create table if not exists public.coupon_restaurants (
  code          text not null references public.coupons (code) on delete cascade on update cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  primary key (code, restaurant_id)
);
create index if not exists coupon_restaurants_restaurant_idx on public.coupon_restaurants (restaurant_id);

create table if not exists public.coupon_zones (
  code    text not null references public.coupons (code) on delete cascade on update cascade,
  zone_id uuid not null references public.delivery_zones (id) on delete cascade,
  primary key (code, zone_id)
);
create index if not exists coupon_zones_zone_idx on public.coupon_zones (zone_id);

create table if not exists public.coupon_items (
  code         text not null references public.coupons (code) on delete cascade on update cascade,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  primary key (code, menu_item_id)
);
create index if not exists coupon_items_item_idx on public.coupon_items (menu_item_id);

insert into public.coupon_restaurants (code, restaurant_id)
  select code, restaurant_id from public.coupons where restaurant_id is not null
  on conflict do nothing;

-- coupons.restaurant_id stays the vendor surfaces' field; keep the list in step.
create or replace function public.mirror_coupon_restaurant()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.restaurant_id is not null and old.restaurant_id is distinct from new.restaurant_id then
    delete from public.coupon_restaurants where code = new.code and restaurant_id = old.restaurant_id;
  end if;
  if new.restaurant_id is not null then
    insert into public.coupon_restaurants (code, restaurant_id) values (new.code, new.restaurant_id) on conflict do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists mirror_coupon_restaurant on public.coupons;
create trigger mirror_coupon_restaurant after insert or update of restaurant_id on public.coupons
  for each row execute function public.mirror_coupon_restaurant();

-- 3. The change log ---------------------------------------------------------------
create table if not exists public.coupon_changes (
  id         bigint generated always as identity primary key,
  code       text not null,
  target     text not null check (target in ('coupon', 'vendor', 'zone', 'item')),
  op         text not null check (op in ('insert', 'update', 'delete')),
  before     jsonb,
  after      jsonb,
  actor_id   uuid,
  reason     text,
  created_at timestamptz not null default now()
);
create index if not exists coupon_changes_code_idx on public.coupon_changes (code, created_at desc);

create or replace function public.log_coupon_change()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor  constant uuid := coalesce(auth.uid(), nullif(current_setting('deligro.actor_id', true), '')::uuid);
  reason constant text := nullif(current_setting('deligro.ops_reason', true), '');
  tgt    constant text := case tg_table_name when 'coupons' then 'coupon' when 'coupon_restaurants' then 'vendor'
                                             when 'coupon_zones' then 'zone' else 'item' end;
  b jsonb;
  a jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then b := to_jsonb(old) - 'updated_at' - 'created_at'; end if;
  if tg_op in ('UPDATE', 'INSERT') then a := to_jsonb(new) - 'updated_at' - 'created_at'; end if;
  if tg_op = 'UPDATE' and b = a then
    return null;
  end if;
  insert into public.coupon_changes (code, target, op, before, after, actor_id, reason)
  values (coalesce(a ->> 'code', b ->> 'code'), tgt, lower(tg_op), b, a, actor, reason);
  return null;
end;
$$;
revoke execute on function public.log_coupon_change() from public, anon, authenticated;

drop trigger if exists log_coupon_change on public.coupons;
create trigger log_coupon_change after insert or update or delete on public.coupons
  for each row execute function public.log_coupon_change();
drop trigger if exists log_coupon_change on public.coupon_restaurants;
create trigger log_coupon_change after insert or update or delete on public.coupon_restaurants
  for each row execute function public.log_coupon_change();
drop trigger if exists log_coupon_change on public.coupon_zones;
create trigger log_coupon_change after insert or update or delete on public.coupon_zones
  for each row execute function public.log_coupon_change();
drop trigger if exists log_coupon_change on public.coupon_items;
create trigger log_coupon_change after insert or update or delete on public.coupon_items
  for each row execute function public.log_coupon_change();

create or replace function public.refuse_coupon_change_edit()
returns trigger language plpgsql as $$
begin
  raise exception 'coupon_changes is append-only' using errcode = '42501';
end;
$$;
drop trigger if exists refuse_coupon_change_edit on public.coupon_changes;
create trigger refuse_coupon_change_edit before update or delete on public.coupon_changes
  for each row execute function public.refuse_coupon_change_edit();

-- 4. Who may see an offer -----------------------------------------------------------
-- Platform-wide (no shop, no zone): every manager may read it (read-only for
-- them). Otherwise a manager holding one of its shops' zones or one of its zones.
create or replace function public.manager_can_see_offer(p_code text)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (public.is_manager() and (
            (not exists (select 1 from public.coupon_restaurants cr where cr.code = p_code)
             and not exists (select 1 from public.coupon_zones cz where cz.code = p_code)
             and exists (select 1 from public.coupons c where c.code = p_code and c.restaurant_id is null))
         or exists (select 1 from public.coupon_restaurants cr where cr.code = p_code
                     and public.manager_can_see_restaurant(cr.restaurant_id))
         or exists (select 1 from public.coupon_zones cz where cz.code = p_code and public.manager_can_see_zone(cz.zone_id))));
$$;
revoke execute on function public.manager_can_see_offer(text) from public, anon;
grant execute on function public.manager_can_see_offer(text) to authenticated, service_role;

drop policy if exists "coupons — manager read" on public.coupons;
create policy "coupons — manager read" on public.coupons for select using (public.manager_can_see_offer(code));

alter table public.coupon_restaurants enable row level security;
alter table public.coupon_zones enable row level security;
alter table public.coupon_items enable row level security;
alter table public.coupon_changes enable row level security;
drop policy if exists "coupon_restaurants — read" on public.coupon_restaurants;
create policy "coupon_restaurants — read" on public.coupon_restaurants for select
  using (public.owns_restaurant(restaurant_id) or public.manager_can_see_offer(code));
drop policy if exists "coupon_zones — read" on public.coupon_zones;
create policy "coupon_zones — read" on public.coupon_zones for select using (public.manager_can_see_offer(code));
drop policy if exists "coupon_items — read" on public.coupon_items;
create policy "coupon_items — read" on public.coupon_items for select
  using (public.manager_can_see_offer(code)
         or exists (select 1 from public.menu_items mi where mi.id = menu_item_id and public.owns_restaurant(mi.restaurant_id)));
drop policy if exists "coupon_changes — read" on public.coupon_changes;
create policy "coupon_changes — read" on public.coupon_changes for select using (public.manager_can_see_offer(code));

revoke all on public.coupon_restaurants, public.coupon_zones, public.coupon_items, public.coupon_changes from anon, authenticated;
grant select on public.coupon_restaurants, public.coupon_zones, public.coupon_items, public.coupon_changes to authenticated;
grant select, insert, update, delete on public.coupon_restaurants, public.coupon_zones, public.coupon_items to service_role;
grant select, insert on public.coupon_changes to service_role;

-- 5. Pricing ----------------------------------------------------------------------
drop function if exists public.price_coupon(public.coupons, integer, uuid, uuid);

create or replace function public.price_coupon(
  c                   public.coupons,
  subtotal            integer,
  rid                 uuid,
  customer            uuid,
  p_zone              uuid    default null,
  p_eligible_subtotal integer default null
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  amount     integer;
  used_by_me integer;
  used_total integer;
  zone       uuid := p_zone;
  base       integer := subtotal;
begin
  if not c.active then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if c.starts_at is not null and c.starts_at > now() then
    return jsonb_build_object('ok', false, 'error', 'not_started');
  end if;
  if c.expires_at is not null and c.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  if c.restaurant_id is not null and c.restaurant_id is distinct from rid then
    return jsonb_build_object('ok', false, 'error', 'wrong_restaurant');
  end if;
  if exists (select 1 from public.coupon_restaurants cr where cr.code = c.code)
     and not exists (select 1 from public.coupon_restaurants cr where cr.code = c.code and cr.restaurant_id = rid) then
    return jsonb_build_object('ok', false, 'error', 'wrong_restaurant');
  end if;
  if exists (select 1 from public.coupon_zones cz where cz.code = c.code) then
    if zone is null then
      select r.zone_id into zone from public.restaurants r where r.id = rid;
    end if;
    if zone is null or not exists (select 1 from public.coupon_zones cz where cz.code = c.code and cz.zone_id = zone) then
      return jsonb_build_object('ok', false, 'error', 'wrong_zone');
    end if;
  end if;

  if subtotal < c.min_order then
    return jsonb_build_object('ok', false, 'error', 'min_order', 'minOrder', c.min_order::integer);
  end if;

  -- Dish-limited codes discount the eligible lines only.
  if exists (select 1 from public.coupon_items ci where ci.code = c.code) then
    base := coalesce(p_eligible_subtotal, 0);
    if base <= 0 then
      return jsonb_build_object('ok', false, 'error', 'no_eligible_items');
    end if;
  end if;

  if customer is not null and c.max_per_customer is not null then
    select count(*) into used_by_me from public.coupon_redemptions r where r.code = c.code and r.customer_id = customer;
    if used_by_me >= c.max_per_customer then
      return jsonb_build_object('ok', false, 'error', 'already_used');
    end if;
  end if;
  if c.max_redemptions is not null then
    select count(*) into used_total from public.coupon_redemptions r where r.code = c.code;
    if used_total >= c.max_redemptions then
      return jsonb_build_object('ok', false, 'error', 'exhausted');
    end if;
  end if;

  amount := case when c.kind = 'percent' then round(base * c.value / 100.0) else round(c.value) end;
  if c.max_discount is not null then
    amount := least(amount, round(c.max_discount));
  end if;
  amount := greatest(0, least(amount, base));

  return jsonb_build_object('ok', true, 'code', c.code, 'discount', amount, 'fundedBy', c.funded_by);
end;
$$;
revoke all on function public.price_coupon(public.coupons, integer, uuid, uuid, uuid, integer) from public, anon, authenticated;

-- 0056's redemption, plus the zone and the eligible lines.
create or replace function public.apply_coupon_to_order(oid uuid, coupon text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o          public.orders%rowtype;
  c          public.coupons%rowtype;
  normalized text := upper(trim(coalesce(coupon, '')));
  subtotal   integer;
  eligible   integer;
  priced     jsonb;
  amount     integer;
begin
  if normalized = '' then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  select * into o from public.orders where id = oid;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  if o.customer_id is distinct from auth.uid()
     and coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin')
     and not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  if o.status <> 'placed' then
    return jsonb_build_object('ok', false, 'error', 'order_not_open');
  end if;
  if o.coupon_code is not null then
    return jsonb_build_object('ok', false, 'error', 'already_applied');
  end if;

  select * into c from public.coupons where code = normalized;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- 0056: serialise redemptions of one code (count-then-insert).
  perform pg_advisory_xact_lock(hashtextextended('coupon:' || normalized, 0));

  select coalesce(sum(oi.qty * oi.price), 0) into subtotal from public.order_items oi where oi.order_id = oid;
  select coalesce(sum(oi.qty * oi.price), 0) into eligible
    from public.order_items oi
    join public.coupon_items ci on ci.menu_item_id = oi.menu_item_id and ci.code = normalized
   where oi.order_id = oid;

  priced := public.price_coupon(c, subtotal, o.restaurant_id, o.customer_id, o.zone_id, eligible);
  if not (priced ->> 'ok')::boolean then
    return priced;
  end if;
  amount := (priced ->> 'discount')::integer;

  begin
    insert into public.coupon_redemptions (code, order_id, customer_id, discount) values (normalized, oid, o.customer_id, amount);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_applied');
  end;

  update public.orders set coupon_code = normalized, discount = amount, discount_funded_by = c.funded_by where id = oid;
  perform public.recompute_order_total(oid);

  return jsonb_build_object('ok', true, 'discount', amount, 'code', normalized, 'fundedBy', c.funded_by);
end;
$$;
revoke all on function public.apply_coupon_to_order(uuid, text) from public, anon;
grant execute on function public.apply_coupon_to_order(uuid, text) to authenticated, service_role;

-- A basket-aware preview: server prices, available dishes only.
create or replace function public.preview_coupon(p_code text, p_restaurant uuid, p_items jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c          public.coupons%rowtype;
  normalized text := upper(trim(coalesce(p_code, '')));
  me         uuid := auth.uid();
  subtotal   integer;
  eligible   integer;
begin
  if me is null and coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if normalized = '' then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select * into c from public.coupons where code = normalized;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  with lines as (
    select (x ->> 'menuItemId')::uuid as item, greatest(1, least(50, coalesce((x ->> 'qty')::integer, 1))) as qty
      from jsonb_array_elements(p_items) x
  )
  select coalesce(sum(l.qty * mi.price), 0),
         coalesce(sum(l.qty * mi.price) filter (where exists (
           select 1 from public.coupon_items ci where ci.code = normalized and ci.menu_item_id = mi.id)), 0)
    into subtotal, eligible
    from lines l join public.menu_items mi on mi.id = l.item and mi.restaurant_id = p_restaurant and mi.available;

  return public.price_coupon(c, subtotal, p_restaurant, me, null, eligible);
end;
$$;
revoke all on function public.preview_coupon(text, uuid, jsonb) from public, anon;
grant execute on function public.preview_coupon(text, uuid, jsonb) to authenticated, service_role;

-- 6. Audited offer writes -------------------------------------------------------------
create or replace function public._ops_offer_state(p_code text, p_replayed boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('code', c.code, 'active', c.active, 'updated_at', c.updated_at, 'replayed', p_replayed)
    from public.coupons c where c.code = p_code;
$$;
revoke execute on function public._ops_offer_state(text, boolean) from public, anon, authenticated, service_role;

-- Validate the terms and write the coupon and its lists. p_create: insert vs
-- update (the caller has locked the row and checked staleness). Raises the
-- contract's codes.
create or replace function public._ops_offer_write(p_actor uuid, p_code text, p_t jsonb, p_create boolean)
returns text
language plpgsql security definer set search_path = public as $$
declare
  role_name  text;
  v_code     constant text := upper(trim(coalesce(p_code, '')));
  v_kind     constant text := p_t ->> 'kind';
  v_value    numeric := nullif(p_t ->> 'value', '')::numeric;
  v_min      numeric := coalesce(nullif(p_t ->> 'minOrder', '')::numeric, 0);
  v_cap      numeric := nullif(p_t ->> 'maxDiscount', '')::numeric;
  v_starts   timestamptz := nullif(p_t ->> 'startsAt', '')::timestamptz;
  v_expires  timestamptz := nullif(p_t ->> 'expiresAt', '')::timestamptz;
  v_per      integer := nullif(p_t ->> 'maxPerCustomer', '')::integer;
  v_total    integer := nullif(p_t ->> 'maxRedemptions', '')::integer;
  v_funded   constant text := coalesce(p_t ->> 'fundedBy', 'platform');
  v_req      constant uuid := nullif(p_t ->> 'requestId', '')::uuid;
  vendors    uuid[];
  zones      uuid[];
  items      uuid[];
  req        record;
begin
  select p.role::text into role_name from public.profiles p where p.id = p_actor;
  select coalesce(array_agg(distinct v::uuid), '{}') into vendors from jsonb_array_elements_text(coalesce(p_t -> 'vendorIds', '[]')) v;
  select coalesce(array_agg(distinct v::uuid), '{}') into zones from jsonb_array_elements_text(coalesce(p_t -> 'zoneIds', '[]')) v;
  select coalesce(array_agg(distinct v::uuid), '{}') into items from jsonb_array_elements_text(coalesce(p_t -> 'itemIds', '[]')) v;

  if v_code !~ '^[A-Z0-9]{3,20}$' then
    raise exception 'bad_request' using errcode = '22023', detail = 'code';
  end if;
  if v_kind is null or v_kind not in ('percent', 'flat') then
    raise exception 'bad_request' using errcode = '22023', detail = 'kind';
  end if;
  if v_value is null or v_value <= 0 or (v_kind = 'percent' and v_value > 90) or v_value > 100000 then
    raise exception 'bad_request' using errcode = '22023', detail = 'value';
  end if;
  if v_min < 0 or v_min > 100000 then
    raise exception 'bad_request' using errcode = '22023', detail = 'minOrder';
  end if;
  if v_cap is not null and (v_cap <= 0 or v_cap > 100000) then
    raise exception 'bad_request' using errcode = '22023', detail = 'maxDiscount';
  end if;
  if (role_name <> 'admin' and v_expires is null)
     or (v_expires is not null and (v_expires <= now() or v_expires > now() + interval '366 days')) then
    raise exception 'bad_request' using errcode = '22023', detail = 'expiresAt';
  end if;
  if v_starts is not null and v_expires is not null and v_starts >= v_expires then
    raise exception 'bad_request' using errcode = '22023', detail = 'startsAt';
  end if;
  if (v_per is not null and v_per < 1) then
    raise exception 'bad_request' using errcode = '22023', detail = 'maxPerCustomer';
  end if;
  if (v_total is not null and v_total < 1) then
    raise exception 'bad_request' using errcode = '22023', detail = 'maxRedemptions';
  end if;
  if v_funded not in ('platform', 'vendor') then
    raise exception 'bad_request' using errcode = '22023', detail = 'fundedBy';
  end if;
  if cardinality(items) > 0 and cardinality(vendors) = 0 then
    raise exception 'bad_request' using errcode = '22023', detail = 'vendorIds';
  end if;

  -- Scope: every shop, zone and dish must be the actor's.
  if role_name <> 'admin' then
    if cardinality(vendors) = 0 and cardinality(zones) = 0 then
      raise exception 'platform_wide_admin_only' using errcode = '42501';
    end if;
    if exists (select 1 from unnest(vendors) v
                where not exists (select 1 from public.restaurants r join public.staff_zones sz on sz.zone_id = r.zone_id
                                   where r.id = v and sz.user_id = p_actor))
       or exists (select 1 from unnest(zones) z
                   where not exists (select 1 from public.staff_zones sz where sz.zone_id = z and sz.user_id = p_actor)) then
      raise exception 'out_of_scope' using errcode = '42501';
    end if;
  end if;
  if exists (select 1 from unnest(items) i
              where not exists (select 1 from public.menu_items mi where mi.id = i and mi.restaurant_id = any (vendors))) then
    raise exception 'out_of_scope' using errcode = '42501', detail = 'itemIds';
  end if;

  -- A vendor pays for a discount only when it asked for it.
  if v_funded = 'vendor' then
    if cardinality(vendors) <> 1 or v_req is null then
      raise exception 'consent_required' using errcode = '42501';
    end if;
    select id, restaurant_id, kind, status into req from public.marketing_requests where id = v_req;
    if req.id is null or req.kind <> 'discount_offer' or req.restaurant_id <> vendors[1]
       or req.status not in ('approved', 'in_progress') then
      raise exception 'consent_required' using errcode = '42501';
    end if;
  end if;

  if p_create then
    if exists (select 1 from public.coupons where code = v_code) then
      raise exception 'code_taken' using errcode = '23505';
    end if;
    insert into public.coupons (code, kind, value, min_order, max_discount, active, starts_at, expires_at,
                                max_per_customer, max_redemptions, restaurant_id, funded_by, label, created_by)
    values (v_code, v_kind, v_value, v_min, v_cap, true, v_starts, v_expires, v_per, v_total,
            case when cardinality(vendors) = 1 then vendors[1] end, v_funded,
            nullif(btrim(coalesce(p_t ->> 'label', '')), ''), p_actor);
  else
    update public.coupons
       set kind = v_kind, value = v_value, min_order = v_min, max_discount = v_cap, starts_at = v_starts, expires_at = v_expires,
           max_per_customer = v_per, max_redemptions = v_total,
           restaurant_id = case when cardinality(vendors) = 1 then vendors[1] end,
           funded_by = v_funded, label = nullif(btrim(coalesce(p_t ->> 'label', '')), '')
     where code = v_code;
  end if;

  delete from public.coupon_restaurants where code = v_code and restaurant_id <> all (vendors);
  insert into public.coupon_restaurants (code, restaurant_id) select v_code, v from unnest(vendors) v on conflict do nothing;
  delete from public.coupon_zones where code = v_code and zone_id <> all (zones);
  insert into public.coupon_zones (code, zone_id) select v_code, z from unnest(zones) z on conflict do nothing;
  delete from public.coupon_items where code = v_code and menu_item_id <> all (items);
  insert into public.coupon_items (code, menu_item_id) select v_code, i from unnest(items) i on conflict do nothing;
  return v_code;
end;
$$;
revoke execute on function public._ops_offer_write(uuid, text, jsonb, boolean) from public, anon, authenticated, service_role;

-- The zone an offer is audited under: its first shop's, or its first zone.
create or replace function public._ops_offer_zone(p_code text)
returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select r.zone_id from public.coupon_restaurants cr join public.restaurants r on r.id = cr.restaurant_id
      where cr.code = p_code order by r.zone_id limit 1),
    (select cz.zone_id from public.coupon_zones cz where cz.code = p_code order by cz.zone_id limit 1));
$$;
revoke execute on function public._ops_offer_zone(text) from public, anon, authenticated, service_role;

-- Can this actor change this offer at all? Admin: anything. Manager: only
-- offers wholly inside their zones (never platform-wide ones).
create or replace function public._ops_offer_require(p_actor uuid, p_code text)
returns void
language plpgsql stable security definer set search_path = public as $$
declare
  role_name text;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.role::text into role_name from public.profiles p where p.id = p_actor;
  if role_name = 'admin' then return; end if;
  if role_name <> 'manager' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.coupon_restaurants where code = p_code)
     and not exists (select 1 from public.coupon_zones where code = p_code) then
    raise exception 'platform_wide_admin_only' using errcode = '42501';
  end if;
  if exists (select 1 from public.coupon_restaurants cr join public.restaurants r on r.id = cr.restaurant_id
              where cr.code = p_code
                and not exists (select 1 from public.staff_zones sz where sz.zone_id = r.zone_id and sz.user_id = p_actor))
     or exists (select 1 from public.coupon_zones cz where cz.code = p_code
                 and not exists (select 1 from public.staff_zones sz where sz.zone_id = cz.zone_id and sz.user_id = p_actor)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function public._ops_offer_require(uuid, text) from public, anon, authenticated, service_role;

-- 0160's decision calls this when approving a discount-offer request.
create or replace function public._ops_create_offer_internal(p_actor uuid, p_terms jsonb, p_request uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_code text;
begin
  v_code := public._ops_offer_write(p_actor, p_terms ->> 'code', p_terms || jsonb_build_object('requestId', p_request), true);
  perform public._ops_log(p_actor, 'offer.create', 'offer', v_code, public._ops_offer_zone(v_code), null, null,
    (select to_jsonb(c) - 'updated_at' - 'created_at' from public.coupons c where c.code = v_code), null);
  return v_code;
end;
$$;
revoke execute on function public._ops_create_offer_internal(uuid, jsonb, uuid) from public, anon, authenticated, service_role;

-- Create (p_expected_updated_at null) or edit an offer. A reason is required to edit.
create or replace function public.ops_upsert_offer(
  p_actor uuid, p_code text, p_terms jsonb, p_expected_updated_at timestamptz, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code   constant text := upper(trim(coalesce(p_code, '')));
  reason   constant text := nullif(trim(coalesce(p_reason, '')), '');
  cur      record;
  before_j jsonb;
  merged   jsonb;
  role_name text;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.role::text into role_name from public.profiles p where p.id = p_actor;
  if role_name not in ('admin', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['offer.create', 'offer.update'], v_code);
    return public._ops_offer_state(v_code, true);
  end if;

  if p_expected_updated_at is null then
    perform public._ops_set_actor(p_actor, reason);
    perform public._ops_offer_write(p_actor, v_code, p_terms, true);
    perform public._ops_log(p_actor, 'offer.create', 'offer', v_code, public._ops_offer_zone(v_code), reason, null,
      (select to_jsonb(c) - 'updated_at' - 'created_at' from public.coupons c where c.code = v_code), p_client_action_id);
    return public._ops_offer_state(v_code, false);
  end if;

  select * into cur from public.coupons where code = v_code for update;
  if cur.code is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._ops_offer_require(p_actor, v_code);
  if cur.updated_at <> p_expected_updated_at then
    raise exception 'stale' using errcode = '40001', detail = cur.updated_at::text;
  end if;
  if reason is null or char_length(reason) < 3 or char_length(reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_terms ? 'code' and upper(trim(p_terms ->> 'code')) <> v_code then
    raise exception 'locked_field' using errcode = '22023', detail = 'code';
  end if;

  before_j := to_jsonb(cur) - 'updated_at' - 'created_at';
  merged := jsonb_build_object(
    'kind', cur.kind, 'value', cur.value, 'minOrder', cur.min_order, 'maxDiscount', cur.max_discount,
    'startsAt', cur.starts_at, 'expiresAt', cur.expires_at, 'maxPerCustomer', cur.max_per_customer,
    'maxRedemptions', cur.max_redemptions, 'fundedBy', cur.funded_by, 'label', cur.label,
    'vendorIds', (select coalesce(jsonb_agg(restaurant_id), '[]') from public.coupon_restaurants where code = v_code),
    'zoneIds', (select coalesce(jsonb_agg(zone_id), '[]') from public.coupon_zones where code = v_code),
    'itemIds', (select coalesce(jsonb_agg(menu_item_id), '[]') from public.coupon_items where code = v_code),
    'requestId', (select m.id from public.marketing_requests m where m.offer_code = v_code limit 1)) || p_terms;
  -- An expired offer can be edited only to give it a future end.
  perform public._ops_set_actor(p_actor, reason);
  perform public._ops_offer_write(p_actor, v_code, merged, false);
  perform public._ops_log(p_actor, 'offer.update', 'offer', v_code, public._ops_offer_zone(v_code), reason, before_j,
    (select to_jsonb(c) - 'updated_at' - 'created_at' from public.coupons c where c.code = v_code), p_client_action_id);
  return public._ops_offer_state(v_code, false);
end;
$$;

-- Switch an offer on or off. An expired or used-up offer cannot be switched on.
create or replace function public.ops_offer_action(
  p_actor uuid, p_code text, p_action text, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code constant text := upper(trim(coalesce(p_code, '')));
  reason constant text := nullif(trim(coalesce(p_reason, '')), '');
  cur    record;
begin
  select * into cur from public.coupons where code = v_code for update;
  if cur.code is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._ops_offer_require(p_actor, v_code);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['offer.activate', 'offer.deactivate'], v_code);
    return public._ops_offer_state(v_code, true);
  end if;
  if reason is null or char_length(reason) < 3 or char_length(reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_action = 'activate' then
    if cur.expires_at is not null and cur.expires_at <= now() then
      raise exception 'expired' using errcode = '22023';
    end if;
    if cur.max_redemptions is not null
       and (select count(*) from public.coupon_redemptions r where r.code = v_code) >= cur.max_redemptions then
      raise exception 'exhausted' using errcode = '22023';
    end if;
  elsif p_action <> 'deactivate' then
    raise exception 'bad_request' using errcode = '22023', detail = 'action';
  end if;

  perform public._ops_set_actor(p_actor, reason);
  update public.coupons set active = (p_action = 'activate') where code = v_code;
  perform public._ops_log(p_actor, 'offer.' || p_action, 'offer', v_code, public._ops_offer_zone(v_code), reason,
    jsonb_build_object('active', cur.active), jsonb_build_object('active', p_action = 'activate'), p_client_action_id);
  return public._ops_offer_state(v_code, false);
end;
$$;

revoke execute on function public.ops_upsert_offer(uuid, text, jsonb, timestamptz, text, text),
  public.ops_offer_action(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ops_upsert_offer(uuid, text, jsonb, timestamptz, text, text),
  public.ops_offer_action(uuid, text, text, text, text) to service_role;

commit;
