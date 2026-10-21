-- 0141 — Manager app foundation: cities and delivery zones, zone-scoped
-- manager access, an append-only operations audit log, server-side
-- notification preferences, "my sessions", and a release track for the
-- Manager app.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0141.mjs); run it on staging first.
-- Depends on 0061 (re-declares guard_order_update() with 0061's column list)
-- and runs after 0081 (re-scopes the rider tables' manager read policies;
-- skipped where 0081 is absent).
-- Design: docs/superpowers/specs/2026-10-21-manager-app-design.md.
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * 0023 let every manager read and work every order in the system. A
--     manager now sees the orders, order items, deliveries and cash records of
--     the zones they are assigned to (staff_zones), and nothing else. A manager
--     with no zones sees nothing — fail closed. Every existing manager is
--     seeded into the one existing zone, so nobody loses their board on deploy.
--   * New columns `orders.zone_id` and `restaurants.zone_id`, each granted
--     per column (0022 / 0058 rule). `orders.zone_id` is derived from the
--     restaurant by trigger and locked against non-admin writes.
--   * 0081 let every manager read every rider's status, shifts, profile and
--     delivery events. A manager now reads riders who share one of their zones
--     (staff_zones holds riders too; every existing rider is seeded into the
--     default zone) and the delivery events of orders in their zones.
--   * `ops_audit_log` cannot be updated, deleted or truncated by anyone,
--     service role included. Rows are written only through log_ops_action().
--   * my_sessions() / revoke_my_session() read and delete rows of
--     auth.sessions, always filtered to auth.uid().
--
-- Rollback:
--   drop function if exists public.revoke_my_session(uuid);
--   drop function if exists public.my_sessions();
--   drop table if exists public.notification_preferences;
--   drop function if exists public.log_ops_action(uuid, text, text, text, uuid, text, jsonb, jsonb, text);
--   drop table if exists public.ops_audit_log;
--   drop function if exists public.ops_audit_log_immutable();
--   -- restore 0023's manager policies and 0047's staff read policies:
--   --   orders/order_items/deliveries using (public.is_manager());
--   --   cod_handovers/operational_expenses using (is_admin() or current_role() = 'manager')
--   -- restore 0081's rider read policies (driver_id = auth.uid() or is_admin()
--   --   or current_role() = 'manager') on rider_status, rider_shifts,
--   --   rider_profiles, delivery_events
--   drop function if exists public.manager_can_see_rider(uuid);
--   drop function if exists public.manager_can_see_order(uuid);
--   drop function if exists public.manager_can_see_zone(uuid);
--   drop trigger if exists stamp_cash_zone on public.cod_handovers;
--   drop trigger if exists stamp_cash_zone on public.operational_expenses;
--   drop function if exists public.stamp_cash_zone();
--   alter table public.cod_handovers drop column if exists zone_id;
--   alter table public.operational_expenses drop column if exists zone_id;
--   drop trigger if exists stamp_order_zone on public.orders;
--   drop function if exists public.stamp_order_zone();
--   -- re-run guard_order_update() from 0061_vendor_app_foundation.sql
--   alter table public.orders drop column if exists zone_id;
--   drop trigger if exists stamp_restaurant_zone on public.restaurants;
--   drop function if exists public.stamp_restaurant_zone();
--   alter table public.restaurants drop column if exists zone_id;
--   drop table if exists public.staff_zones;
--   drop function if exists public.default_zone_id();
--   drop table if exists public.delivery_zones;
--   drop table if exists public.cities;
--   alter table public.platform_settings drop constraint if exists platform_settings_manager_apk_versions,
--     drop column if exists manager_apk_version_code, drop column if exists manager_apk_min_version_code,
--     drop column if exists manager_apk_url, drop column if exists manager_apk_notes;

-- 1. Cities and delivery zones ----------------------------------------------
create table if not exists public.cities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 2 and 60),
  slug       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.delivery_zones (
  id         uuid primary key default gen_random_uuid(),
  city_id    uuid not null references public.cities (id) on delete restrict,
  name       text not null check (char_length(name) between 2 and 60),
  slug       text not null,
  center_lat double precision not null check (center_lat between -90 and 90),
  center_lng double precision not null check (center_lng between -180 and 180),
  radius_km  numeric(5,1) not null default 8 check (radius_km between 0.5 and 50),
  -- Optional outline as [[lat, lng], ...]; the circle is the fallback.
  polygon    jsonb,
  is_active  boolean not null default true,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (city_id, slug)
);

-- At most one default zone: where a shop or an order lands when nothing
-- else says which zone it belongs to.
create unique index if not exists delivery_zones_one_default
  on public.delivery_zones (is_default) where is_default;

comment on table public.delivery_zones is
  'An operating area inside a city. Managers are scoped to zones (staff_zones); shops and orders carry a zone_id.';

-- Seed: the one city Deligro runs today. Centre from src/lib/location/pinned.ts,
-- radius from the existing service-area setting.
insert into public.cities (name, slug)
values ('Bemetara', 'bemetara')
on conflict (slug) do nothing;

insert into public.delivery_zones (city_id, name, slug, center_lat, center_lng, radius_km, is_default)
select c.id, 'Bemetara', 'bemetara', 21.7157, 81.5335,
       coalesce((select delivery_radius_km from public.platform_settings limit 1), 8),
       not exists (select 1 from public.delivery_zones where is_default)
  from public.cities c
 where c.slug = 'bemetara'
on conflict (city_id, slug) do nothing;

create or replace function public.default_zone_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.delivery_zones where is_default limit 1;
$$;

-- 2. Who works which zone ----------------------------------------------------
create table if not exists public.staff_zones (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  zone_id     uuid not null references public.delivery_zones (id) on delete cascade,
  assigned_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (user_id, zone_id)
);

create index if not exists staff_zones_zone_idx on public.staff_zones (zone_id);

comment on table public.staff_zones is
  'Managers (and riders) assigned to delivery zones. A manager with no rows here sees no orders.';

insert into public.staff_zones (user_id, zone_id)
select p.id, public.default_zone_id()
  from public.profiles p
 where p.role in ('manager', 'driver') and public.default_zone_id() is not null
on conflict do nothing;

-- 3. Shops and orders carry their zone --------------------------------------
alter table public.restaurants
  add column if not exists zone_id uuid references public.delivery_zones (id) on delete restrict;
update public.restaurants set zone_id = public.default_zone_id() where zone_id is null;

create or replace function public.stamp_restaurant_zone()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.zone_id is null then
    new.zone_id := public.default_zone_id();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_restaurant_zone on public.restaurants;
create trigger stamp_restaurant_zone
  before insert on public.restaurants
  for each row execute function public.stamp_restaurant_zone();

do $$
begin
  if public.default_zone_id() is not null
     and not exists (select 1 from public.restaurants where zone_id is null) then
    alter table public.restaurants alter column zone_id set not null;
  end if;
end $$;

grant select (zone_id) on public.restaurants to authenticated;

alter table public.orders
  add column if not exists zone_id uuid references public.delivery_zones (id) on delete restrict;
update public.orders o
   set zone_id = coalesce(r.zone_id, public.default_zone_id())
  from public.restaurants r
 where r.id = o.restaurant_id and o.zone_id is null;
update public.orders set zone_id = public.default_zone_id() where zone_id is null;

create index if not exists orders_zone_created_idx on public.orders (zone_id, created_at desc);
grant select (zone_id) on public.orders to authenticated;

comment on column public.orders.zone_id is
  'Zone of the restaurant at the moment the order was placed. Set by stamp_order_zone, never by a client.';

-- Always from the restaurant: a client-supplied zone is overwritten, so an
-- order cannot be steered into (or out of) a manager's view.
create or replace function public.stamp_order_zone()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select r.zone_id into new.zone_id from public.restaurants r where r.id = new.restaurant_id;
  if new.zone_id is null then
    new.zone_id := public.default_zone_id();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_order_zone on public.orders;
create trigger stamp_order_zone
  before insert on public.orders
  for each row execute function public.stamp_order_zone();

-- 0061's guard with zone_id added to the locked list.
create or replace function public.guard_order_update()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  locked constant text[] := array[
    'id', 'customer_id', 'restaurant_id',
    'total', 'delivery_fee', 'tax_amount', 'tip',
    'address', 'created_at',
    'payment_method', 'payment_status',
    'accepted_at', 'ready_at', 'cancelled_at',
    'channel', 'placed_by',
    'coupon_code', 'discount',
    'discount_funded_by',
    'cancelled_by',
    -- 0055: the handover proof and the import / dedup keys.
    'pickup_otp', 'delivery_otp',
    'external_id', 'idempotency_key',
    -- 0061: stamped only by start_preparing().
    'preparing_at',
    -- 0141: derived from the restaurant at insert.
    'zone_id'
  ];
  col     text;
  old_row jsonb := to_jsonb(old);
  new_row jsonb := to_jsonb(new);
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  foreach col in array locked loop
    if (old_row -> col) is distinct from (new_row -> col) then
      raise exception
        'only order status may be changed by this role (attempted: %)', col;
    end if;
  end loop;

  return new;
end;
$$;

-- Cash records: the zone the money moved in.
alter table public.cod_handovers
  add column if not exists zone_id uuid references public.delivery_zones (id) on delete restrict;
alter table public.operational_expenses
  add column if not exists zone_id uuid references public.delivery_zones (id) on delete restrict;
update public.cod_handovers set zone_id = public.default_zone_id() where zone_id is null;
update public.operational_expenses set zone_id = public.default_zone_id() where zone_id is null;

-- Given zone, else the recorder's only zone, else the default.
create or replace function public.stamp_cash_zone()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  only_zone uuid;
begin
  if new.zone_id is null then
    select min(sz.zone_id::text)::uuid into only_zone
      from public.staff_zones sz
     where sz.user_id = new.recorded_by
    having count(*) = 1;
    new.zone_id := coalesce(only_zone, public.default_zone_id());
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_cash_zone on public.cod_handovers;
create trigger stamp_cash_zone
  before insert on public.cod_handovers
  for each row execute function public.stamp_cash_zone();
drop trigger if exists stamp_cash_zone on public.operational_expenses;
create trigger stamp_cash_zone
  before insert on public.operational_expenses
  for each row execute function public.stamp_cash_zone();

-- 4. Zone-scoped manager access ----------------------------------------------
create or replace function public.manager_can_see_zone(zid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (
        zid is not null
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'manager')
        and exists (select 1 from public.staff_zones sz where sz.user_id = auth.uid() and sz.zone_id = zid)
      );
$$;

create or replace function public.manager_can_see_order(oid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.manager_can_see_zone((select o.zone_id from public.orders o where o.id = oid));
$$;

-- A rider is visible to a manager who shares one of the rider's zones.
create or replace function public.manager_can_see_rider(rid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (
        rid is not null
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'manager')
        and exists (
          select 1
            from public.staff_zones mine
            join public.staff_zones theirs on theirs.zone_id = mine.zone_id
           where mine.user_id = auth.uid() and theirs.user_id = rid
        )
      );
$$;
revoke execute on function public.manager_can_see_rider(uuid) from public, anon;
grant execute on function public.manager_can_see_rider(uuid) to authenticated, service_role;

revoke execute on function public.manager_can_see_zone(uuid), public.manager_can_see_order(uuid) from public, anon;
grant execute on function public.manager_can_see_zone(uuid), public.manager_can_see_order(uuid) to authenticated, service_role;

drop policy if exists "orders — manager read" on public.orders;
create policy "orders — manager read" on public.orders for select
  using (public.manager_can_see_zone(zone_id));

drop policy if exists "orders — manager update" on public.orders;
create policy "orders — manager update" on public.orders for update
  using (public.manager_can_see_zone(zone_id)) with check (public.manager_can_see_zone(zone_id));

drop policy if exists "order_items — manager read" on public.order_items;
create policy "order_items — manager read" on public.order_items for select
  using (public.manager_can_see_order(order_id));

drop policy if exists "deliveries — manager read" on public.deliveries;
create policy "deliveries — manager read" on public.deliveries for select
  using (public.manager_can_see_order(order_id));

drop policy if exists "deliveries — manager manage" on public.deliveries;
create policy "deliveries — manager manage" on public.deliveries for all
  using (public.manager_can_see_order(order_id)) with check (public.manager_can_see_order(order_id));

drop policy if exists "cod_handovers — staff read" on public.cod_handovers;
create policy "cod_handovers — staff read" on public.cod_handovers for select
  using (public.is_admin() or public.manager_can_see_zone(zone_id));

drop policy if exists "operational_expenses — staff read" on public.operational_expenses;
create policy "operational_expenses — staff read" on public.operational_expenses for select
  using (public.is_admin() or public.manager_can_see_zone(zone_id));

-- 0081's rider tables: same narrowing. Guarded, so 0141 still applies on a
-- database where the Rider app's migration has not run yet.
do $$
declare t text;
begin
  foreach t in array array['rider_status', 'rider_shifts', 'rider_profiles'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || ' — read', t);
      execute format(
        'create policy %I on public.%I for select using (driver_id = auth.uid() or public.manager_can_see_rider(driver_id))',
        t || ' — read', t);
    end if;
  end loop;
  if to_regclass('public.delivery_events') is not null then
    drop policy if exists "delivery_events — read" on public.delivery_events;
    create policy "delivery_events — read" on public.delivery_events for select
      using (driver_id = auth.uid() or public.manager_can_see_order(order_id));
  end if;
end;
$$;

-- Zones are configuration: staff read them, only the server (behind an admin
-- check) writes them.
alter table public.cities enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.staff_zones enable row level security;

drop policy if exists "cities — staff read" on public.cities;
create policy "cities — staff read" on public.cities for select
  using (public.is_admin() or public.is_manager());
drop policy if exists "delivery_zones — staff read" on public.delivery_zones;
create policy "delivery_zones — staff read" on public.delivery_zones for select
  using (public.is_admin() or public.is_manager());
drop policy if exists "staff_zones — own or admin read" on public.staff_zones;
create policy "staff_zones — own or admin read" on public.staff_zones for select
  using (user_id = auth.uid() or public.is_admin());

revoke insert, update, delete, truncate on public.cities, public.delivery_zones, public.staff_zones from anon, authenticated;
revoke select on public.cities, public.delivery_zones, public.staff_zones from anon;
grant select on public.cities, public.delivery_zones, public.staff_zones to authenticated;
grant all on public.cities, public.delivery_zones, public.staff_zones to service_role;

-- 5. The operations audit log ------------------------------------------------
create table if not exists public.ops_audit_log (
  id               bigint generated always as identity primary key,
  actor_id         uuid not null,
  actor_role       text not null,
  action           text not null check (char_length(action) between 3 and 80),
  entity_type      text not null check (char_length(entity_type) between 2 and 40),
  entity_id        text,
  zone_id          uuid,
  reason           text check (reason is null or char_length(reason) <= 1000),
  before           jsonb,
  after            jsonb,
  client_action_id text unique,
  created_at       timestamptz not null default now()
);

create index if not exists ops_audit_log_actor_idx on public.ops_audit_log (actor_id, created_at desc);
create index if not exists ops_audit_log_zone_idx on public.ops_audit_log (zone_id, created_at desc);
create index if not exists ops_audit_log_entity_idx on public.ops_audit_log (entity_type, entity_id);

comment on table public.ops_audit_log is
  'Who did what in operations, when, and why. Append-only for every role: written through log_ops_action(), never updated or deleted.';

create or replace function public.ops_audit_log_immutable()
returns trigger
language plpgsql as $$
begin
  raise exception 'ops_audit_log is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists ops_audit_log_immutable on public.ops_audit_log;
create trigger ops_audit_log_immutable
  before update or delete on public.ops_audit_log
  for each row execute function public.ops_audit_log_immutable();
drop trigger if exists ops_audit_log_no_truncate on public.ops_audit_log;
create trigger ops_audit_log_no_truncate
  before truncate on public.ops_audit_log
  for each statement execute function public.ops_audit_log_immutable();

alter table public.ops_audit_log enable row level security;
drop policy if exists "ops_audit_log — own or admin read" on public.ops_audit_log;
create policy "ops_audit_log — own or admin read" on public.ops_audit_log for select
  using (actor_id = auth.uid() or public.is_admin());

revoke all on public.ops_audit_log from anon, authenticated;
grant select on public.ops_audit_log to authenticated;
-- Even the server writes only through log_ops_action(), so every row has a
-- real actor and a role read from profiles.
revoke insert, update, delete, truncate on public.ops_audit_log from service_role;
grant select on public.ops_audit_log to service_role;

create or replace function public.log_ops_action(
  p_actor            uuid,
  p_action           text,
  p_entity_type      text,
  p_entity_id        text,
  p_zone             uuid,
  p_reason           text,
  p_before           jsonb,
  p_after            jsonb,
  p_client_action_id text
)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  -- From the request's JWT only. Inside a security definer function
  -- current_user is the owner, so it would vouch for every caller.
  is_service boolean := coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin');
  role_name  text;
  existing   bigint;
  new_id     bigint;
begin
  if p_client_action_id is not null then
    select id into existing from public.ops_audit_log where client_action_id = p_client_action_id;
    if existing is not null then
      return existing;
    end if;
  end if;

  select p.role::text into role_name from public.profiles p where p.id = p_actor;
  if role_name is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not is_service then
    if p_actor is distinct from auth.uid() or role_name not in ('manager', 'admin') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  insert into public.ops_audit_log
    (actor_id, actor_role, action, entity_type, entity_id, zone_id, reason, before, after, client_action_id)
  values
    (p_actor, role_name, p_action, p_entity_type, p_entity_id, p_zone, nullif(trim(p_reason), ''), p_before, p_after, p_client_action_id)
  on conflict (client_action_id) do nothing
  returning id into new_id;

  if new_id is null then
    select id into new_id from public.ops_audit_log where client_action_id = p_client_action_id;
  end if;
  return new_id;
end;
$$;

revoke execute on function public.log_ops_action(uuid, text, text, text, uuid, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.log_ops_action(uuid, text, text, text, uuid, text, jsonb, jsonb, text) to authenticated, service_role;

-- 6. Notification preferences (role-generic) ---------------------------------
create table if not exists public.notification_preferences (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (char_length(kind) between 2 and 60),
  push       boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

comment on table public.notification_preferences is
  'Per-person switches for push categories. No row = on. Written by the server only.';

alter table public.notification_preferences enable row level security;
drop policy if exists "notification_preferences — own read" on public.notification_preferences;
create policy "notification_preferences — own read" on public.notification_preferences for select
  using (user_id = auth.uid());
revoke all on public.notification_preferences from anon, authenticated;
grant select on public.notification_preferences to authenticated;
grant all on public.notification_preferences to service_role;

-- 7. My sessions ---------------------------------------------------------------
create or replace function public.my_sessions()
returns table (
  id          uuid,
  created_at  timestamptz,
  updated_at  timestamptz,
  user_agent  text,
  ip          text,
  is_current  boolean
)
language sql stable security definer set search_path = public as $$
  select s.id, s.created_at, s.updated_at, s.user_agent::text, s.ip::text,
         s.id::text = coalesce(auth.jwt() ->> 'session_id', '')
    from auth.sessions s
   where s.user_id = auth.uid()
   order by coalesce(s.updated_at, s.created_at) desc;
$$;

-- Ends one OTHER session of the caller. The current one ends with a normal
-- sign-out (the app also has to drop its tokens), so it is refused here.
create or replace function public.revoke_my_session(p_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_id::text = coalesce(auth.jwt() ->> 'session_id', '') then
    raise exception 'use_sign_out' using errcode = '22023';
  end if;
  delete from auth.sessions where id = p_id and user_id = auth.uid();
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke execute on function public.my_sessions(), public.revoke_my_session(uuid) from public, anon;
grant execute on function public.my_sessions(), public.revoke_my_session(uuid) to authenticated;

-- 8. Manager app release track -------------------------------------------------
alter table public.platform_settings
  add column if not exists manager_apk_version_code integer not null default 1,
  add column if not exists manager_apk_min_version_code integer not null default 1,
  add column if not exists manager_apk_url text not null default '',
  add column if not exists manager_apk_notes text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.platform_settings'::regclass
       and conname  = 'platform_settings_manager_apk_versions'
  ) then
    alter table public.platform_settings
      add constraint platform_settings_manager_apk_versions
      check (manager_apk_min_version_code >= 1
             and manager_apk_version_code >= 1
             and manager_apk_min_version_code <= manager_apk_version_code);
  end if;
end $$;
