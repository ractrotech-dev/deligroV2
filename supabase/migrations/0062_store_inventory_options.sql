-- 0062 — Partner app: shop hours that actually close the shop, holidays and
-- temporary closing, menu stock and availability schedules, and dish variants
-- and add-ons priced by the database.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0062.mjs); run it on staging first.
-- Design: docs/superpowers/specs/2026-10-21-vendor-app-design.md.
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * New public columns on restaurants (shop_phone, closed_until), granted
--     per column as 0024 requires. shop_phone is a business number the shop
--     chooses to publish; owner_mobile stays private.
--   * New tables store_holidays, menu_item_variants, menu_item_addon_groups,
--     menu_item_addons: readable like the menu (approved shop, owner, admin),
--     written only by the shop's owner or an admin. No `for all` policies.
--   * guard_order_item_insert now also enforces shop hours / holidays /
--     temporary closing, item schedules, stock, and prices variants and
--     add-ons itself; the client's price is still never trusted.
--   * Stock moves only through two SECURITY DEFINER triggers (order placed,
--     order cancelled) and the owner's own menu edits.
--
-- Rollback:
--   drop trigger if exists order_items_take_stock on public.order_items;
--   drop trigger if exists orders_return_stock on public.orders;
--   drop trigger if exists menu_items_stock_rules on public.menu_items;
--   drop function if exists public.take_stock(), public.return_stock(), public.menu_stock_rules();
--   -- re-run guard_order_item_insert() from 0055_order_delivery_integrity.sql
--   drop function if exists public.restaurant_open_statuses(uuid[]);
--   drop function if exists public.restaurant_status_now(uuid, timestamptz);
--   drop table if exists public.menu_item_addons, public.menu_item_addon_groups, public.menu_item_variants, public.store_holidays;
--   alter table public.order_items drop column if exists options;
--   alter table public.menu_items drop column if exists stock_qty, drop column if exists low_stock_at,
--     drop column if exists sold_out_by_stock, drop column if exists available_days,
--     drop column if exists available_from, drop column if exists available_to;
--   alter table public.restaurants drop column if exists shop_phone, drop column if exists closed_until;

-- 1. Shop: phone and temporary closing ---------------------------------------
-- `is_open` stays the owner's master switch ("Close until I reopen").
-- `closed_until` is "close for a while": the shop counts as open again by
-- itself once it passes, with no job needed to flip anything back.
alter table public.restaurants
  add column if not exists shop_phone   text,
  add column if not exists closed_until timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.restaurants'::regclass and conname = 'restaurants_shop_phone_shape') then
    alter table public.restaurants add constraint restaurants_shop_phone_shape
      check (shop_phone is null or shop_phone ~ '^\+?[0-9 -]{6,20}$');
  end if;
end $$;

grant select (shop_phone, closed_until) on public.restaurants to anon, authenticated;

-- 2. Holidays -----------------------------------------------------------------
create table if not exists public.store_holidays (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  starts_on     date not null,
  ends_on       date not null,
  note          text check (note is null or char_length(note) <= 120),
  created_at    timestamptz not null default now(),
  constraint store_holidays_range check (ends_on >= starts_on)
);

create index if not exists store_holidays_restaurant_idx on public.store_holidays (restaurant_id, ends_on);

alter table public.store_holidays enable row level security;

drop policy if exists "store_holidays — read" on public.store_holidays;
create policy "store_holidays — read" on public.store_holidays for select using (
  exists (select 1 from public.restaurants r where r.id = restaurant_id and (r.approved or r.owner_id = auth.uid()))
  or public.is_admin()
);
drop policy if exists "store_holidays — owner insert" on public.store_holidays;
create policy "store_holidays — owner insert" on public.store_holidays for insert
  with check (public.owns_restaurant(restaurant_id) or public.is_admin());
drop policy if exists "store_holidays — owner update" on public.store_holidays;
create policy "store_holidays — owner update" on public.store_holidays for update
  using (public.owns_restaurant(restaurant_id) or public.is_admin())
  with check (public.owns_restaurant(restaurant_id) or public.is_admin());
drop policy if exists "store_holidays — owner delete" on public.store_holidays;
create policy "store_holidays — owner delete" on public.store_holidays for delete
  using (public.owns_restaurant(restaurant_id) or public.is_admin());

grant select on public.store_holidays to anon, authenticated;
grant insert, update, delete on public.store_holidays to authenticated;

-- 3. Is the shop open right now? ---------------------------------------------
-- One definition, used by order placement (the guard below) and by every
-- storefront (restaurant_open_statuses). IST throughout: India has no DST.
--   closed              the owner switched it off
--   temporarily_closed  closed_until is still ahead
--   holiday             a store_holidays range covers today
--   weekly_off          today's day name is in weekly_off
--   outside_hours       opening/closing set and now is outside them
--                       (closing before opening = open past midnight)
--   open
create or replace function public.restaurant_status_now(p_restaurant uuid, p_at timestamptz default now())
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  r     record;
  local timestamp := p_at at time zone 'Asia/Kolkata';
  t     time := local::time;
begin
  select is_open, closed_until, opening_time, closing_time, weekly_off
    into r from public.restaurants where id = p_restaurant;
  if not found or not r.is_open then
    return 'closed';
  end if;
  if r.closed_until is not null and r.closed_until > p_at then
    return 'temporarily_closed';
  end if;
  if exists (
    select 1 from public.store_holidays h
     where h.restaurant_id = p_restaurant and local::date between h.starts_on and h.ends_on
  ) then
    return 'holiday';
  end if;
  if to_char(local, 'FMDay') = any (coalesce(r.weekly_off, '{}')) then
    return 'weekly_off';
  end if;
  if r.opening_time is not null and r.closing_time is not null and r.opening_time <> r.closing_time then
    if r.opening_time < r.closing_time then
      if t < r.opening_time or t >= r.closing_time then return 'outside_hours'; end if;
    elsif t < r.opening_time and t >= r.closing_time then
      return 'outside_hours';
    end if;
  end if;
  return 'open';
end;
$$;

revoke all on function public.restaurant_status_now(uuid, timestamptz) from public;
grant execute on function public.restaurant_status_now(uuid, timestamptz) to anon, authenticated, service_role;

-- Many shops at once, for storefront lists. Only approved shops (or the
-- caller's own) are answered, like the restaurants read policy.
create or replace function public.restaurant_open_statuses(p_ids uuid[])
returns table (restaurant_id uuid, status text)
language sql stable security definer set search_path = public as $$
  select r.id, public.restaurant_status_now(r.id)
    from public.restaurants r
   where r.id = any (p_ids)
     and (r.approved or r.owner_id = auth.uid() or public.is_admin());
$$;

revoke all on function public.restaurant_open_statuses(uuid[]) from public;
grant execute on function public.restaurant_open_statuses(uuid[]) to anon, authenticated, service_role;

-- 4. Menu: stock and availability schedule ------------------------------------
alter table public.menu_items
  add column if not exists stock_qty         integer,
  add column if not exists low_stock_at      integer,
  add column if not exists sold_out_by_stock boolean not null default false,
  add column if not exists available_days    smallint[],
  add column if not exists available_from    time,
  add column if not exists available_to      time;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_stock_nonneg') then
    alter table public.menu_items add constraint menu_items_stock_nonneg
      check ((stock_qty is null or stock_qty >= 0) and (low_stock_at is null or low_stock_at >= 0));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_days_valid') then
    alter table public.menu_items add constraint menu_items_days_valid
      check (available_days is null or available_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]);
  end if;
end $$;

comment on column public.menu_items.stock_qty is 'Units left; null = not tracked. At 0 the dish turns sold out by itself.';
comment on column public.menu_items.sold_out_by_stock is 'Set when stock reached 0, so restocking puts the dish back on — but never undoes a manual sold-out.';
comment on column public.menu_items.available_days is 'IST weekdays the dish is offered (0 = Sunday); null = every day.';

-- Stock drives availability, in one place: reaching 0 marks the dish sold
-- out; restocking a dish that stock marked sold out puts it back on.
create or replace function public.menu_stock_rules()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.stock_qty is not null and new.stock_qty = 0 then
    if new.available then
      new.available := false;
      new.sold_out_by_stock := true;
    end if;
  elsif tg_op = 'UPDATE' and old.sold_out_by_stock then
    new.available := true;
    new.sold_out_by_stock := false;
  end if;
  return new;
end;
$$;

drop trigger if exists menu_items_stock_rules on public.menu_items;
create trigger menu_items_stock_rules
  before insert or update of stock_qty on public.menu_items
  for each row execute function public.menu_stock_rules();

-- 5. Variants and add-ons -----------------------------------------------------
create table if not exists public.menu_item_variants (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 60),
  price        integer not null check (price >= 0),
  available    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists public.menu_item_addon_groups (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 60),
  min_select   integer not null default 0 check (min_select >= 0),
  max_select   integer not null default 1,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint menu_item_addon_groups_range check (max_select >= 1 and max_select >= min_select)
);

create table if not exists public.menu_item_addons (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.menu_item_addon_groups (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  price      integer not null default 0 check (price >= 0),
  available  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists menu_item_variants_item_idx on public.menu_item_variants (menu_item_id, sort_order);
create index if not exists menu_item_addon_groups_item_idx on public.menu_item_addon_groups (menu_item_id, sort_order);
create index if not exists menu_item_addons_group_idx on public.menu_item_addons (group_id, sort_order);

alter table public.menu_item_variants enable row level security;
alter table public.menu_item_addon_groups enable row level security;
alter table public.menu_item_addons enable row level security;

-- Read: like the menu. Write: the dish's shop owner, or an admin. Each rule
-- names the shop directly (L-1) rather than leaning on menu_items' policies.
do $$
declare
  t text;
  item_expr text;
begin
  foreach t in array array['menu_item_variants', 'menu_item_addon_groups', 'menu_item_addons'] loop
    item_expr := case t
      when 'menu_item_addons' then
        '(select g.menu_item_id from public.menu_item_addon_groups g where g.id = group_id)'
      else 'menu_item_id'
    end;

    execute format('drop policy if exists %I on public.%I', t || ' — read', t);
    execute format($p$create policy %I on public.%I for select using (
      exists (select 1 from public.menu_items mi join public.restaurants r on r.id = mi.restaurant_id
               where mi.id = %s and (r.approved or r.owner_id = auth.uid()))
      or public.is_admin())$p$, t || ' — read', t, item_expr);

    execute format('drop policy if exists %I on public.%I', t || ' — owner insert', t);
    execute format($p$create policy %I on public.%I for insert with check (
      exists (select 1 from public.menu_items mi where mi.id = %s and public.owns_restaurant(mi.restaurant_id))
      or public.is_admin())$p$, t || ' — owner insert', t, item_expr);

    execute format('drop policy if exists %I on public.%I', t || ' — owner update', t);
    execute format($p$create policy %I on public.%I for update using (
      exists (select 1 from public.menu_items mi where mi.id = %s and public.owns_restaurant(mi.restaurant_id))
      or public.is_admin()) with check (
      exists (select 1 from public.menu_items mi where mi.id = %s and public.owns_restaurant(mi.restaurant_id))
      or public.is_admin())$p$, t || ' — owner update', t, item_expr, item_expr);

    execute format('drop policy if exists %I on public.%I', t || ' — owner delete', t);
    execute format($p$create policy %I on public.%I for delete using (
      exists (select 1 from public.menu_items mi where mi.id = %s and public.owns_restaurant(mi.restaurant_id))
      or public.is_admin())$p$, t || ' — owner delete', t, item_expr);

    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('grant insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- What the customer chose, as it was when they ordered (names and prices
-- copied in by the guard). Null for a dish ordered without options.
alter table public.order_items add column if not exists options jsonb;

-- 6. The order-line guard ----------------------------------------------------
-- 0055's checks, plus: the shop must be open now; the dish must be offered
-- today and at this hour; there must be enough stock; and the unit price is
-- the database's — the chosen variant's price (or the dish's effective price)
-- plus the chosen add-ons. The client sends `options` as
-- {"variantId": uuid, "addonIds": [uuid, …]}; the guard replaces it with a
-- snapshot of names and prices.
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

  select name, price, discount_price, available, stock_qty, available_days, available_from, available_to into m
    from public.menu_items
   where id = new.menu_item_id and restaurant_id = o.restaurant_id;
  if not found then
    raise exception 'order_items: item is not on this restaurant''s menu';
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

-- 7. Stock moves with orders --------------------------------------------------
-- SECURITY DEFINER: the customer placing the order may not write menu_items.
-- menu_stock_rules (above) turns a dish sold out at 0 and back on when the
-- stock returns.
create or replace function public.take_stock()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.menu_items
     set stock_qty = greatest(0, stock_qty - new.qty)
   where id = new.menu_item_id and stock_qty is not null;
  return null;
end;
$$;

revoke all on function public.take_stock() from public;

drop trigger if exists order_items_take_stock on public.order_items;
create trigger order_items_take_stock
  after insert on public.order_items
  for each row execute function public.take_stock();

create or replace function public.return_stock()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update public.menu_items mi
       set stock_qty = mi.stock_qty + s.qty
      from (select menu_item_id, sum(qty)::integer as qty
              from public.order_items where order_id = new.id group by menu_item_id) s
     where mi.id = s.menu_item_id and mi.stock_qty is not null;
  end if;
  return null;
end;
$$;

revoke all on function public.return_stock() from public;

drop trigger if exists orders_return_stock on public.orders;
create trigger orders_return_stock
  after update of status on public.orders
  for each row execute function public.return_stock();
