// Shared base for the manager-phase PGlite proofs (0142+): an abridged 0001–0061
// schema, then the real 0081 and 0141, then two zones, managers, a vendor with a
// shop in each zone, and five riders. Each proof applies its own migration(s)
// on top. Needs: npm i --no-save @electric-sql/pglite@0.2.17
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

export const readMigration = (f) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), "utf8");
export const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
export const IDS = {
  A: id(1), M: id(2), MB: id(3), C: id(4), V: id(5), D1: id(6), D2: id(7), D3: id(8), D4: id(9), D5: id(10),
  R1: id(101), R2: id(102),
};

export async function managerBase() {
  const M0081 = readMigration("0081_rider_app_foundation.sql");
  const M0141 = readMigration("0141_manager_foundation.sql");
  const db = new PGlite();

  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
    create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

    create table auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz default now(),
      updated_at timestamptz default now(), user_agent text, ip text);

    create type public.order_status as enum ('placed', 'kitchen', 'ready', 'on_the_way', 'delivered', 'cancelled');
    create type public.delivery_status as enum ('unassigned', 'assigned', 'picked_up', 'delivered', 'cancelled');
    create type public.refund_status as enum ('pending', 'approved', 'denied');
    create type public.cash_handover_leg as enum ('rider_to_manager', 'manager_to_owner');

    create table public.profiles (id uuid primary key, role text not null, full_name text, created_at timestamptz not null default now());
    create table public.platform_settings (id boolean primary key default true, delivery_radius_km numeric(5,1) not null default 6.5,
      vendor_apk_version_code integer not null default 1, vendor_apk_min_version_code integer not null default 1,
      vendor_apk_url text not null default '', vendor_apk_notes text not null default '');
    insert into public.platform_settings default values;
    create table public.restaurants (id uuid primary key, owner_id uuid, name text,
      lat double precision, lng double precision, eta_min integer, eta_max integer);
    create table public.orders (id uuid primary key default gen_random_uuid(), customer_id uuid, restaurant_id uuid references public.restaurants,
      status public.order_status not null default 'placed', total integer not null default 0, preparing_at timestamptz,
      cancelled_by text, cancellation_reason text, created_at timestamptz default now(),
      payment_method text not null default 'cod', payment_status text not null default 'pending',
      accepted_at timestamptz, ready_at timestamptz, prep_minutes smallint, address jsonb);
    create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders,
      name text not null, qty integer not null, price integer not null);
    create table public.deliveries (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null unique references public.orders (id) on delete cascade,
      driver_id uuid references public.profiles (id) on delete set null,
      status public.delivery_status not null default 'unassigned',
      assigned_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz,
      driver_lat double precision, driver_lng double precision, driver_location_at timestamptz, driver_location_source text,
      offered_driver_id uuid references public.profiles (id) on delete set null, offered_at timestamptz,
      cod_collected_amount integer, cod_collected_at timestamptz);
    create table public.refunds (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders,
      amount integer not null, reason text, status public.refund_status not null default 'pending', decided_by uuid,
      requested_by uuid, origin text not null default 'customer', created_at timestamptz not null default now());
    create unique index refunds_one_open_per_order on public.refunds (order_id) where status = 'pending';
    create unique index refunds_one_approved_per_order on public.refunds (order_id) where status = 'approved';
    create table public.vendor_settlement_orders (id uuid primary key default gen_random_uuid(), order_id uuid unique not null);
    create table public.cod_handovers (id uuid primary key default gen_random_uuid(), leg public.cash_handover_leg not null,
      amount integer not null, recorded_by uuid not null, created_at timestamptz default now());
    create table public.operational_expenses (id uuid primary key default gen_random_uuid(), amount integer not null,
      recorded_by uuid not null, created_at timestamptz default now());
    create table public.role_feature_flags (id uuid primary key default gen_random_uuid(),
      role text not null, feature text not null check (feature ~ '^[a-z_]+\\.[a-z_]+$'), enabled boolean not null default true,
      subject_kind text not null default 'role', subject_id uuid, updated_at timestamptz not null default now(), updated_by uuid);

    create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
      select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
    create function public.is_manager() returns boolean language sql stable security definer set search_path = public as $$
      select coalesce((select role = 'manager' from public.profiles where id = auth.uid()), false) $$;
    create function public.current_role() returns text language sql stable security definer set search_path = public as $$
      select role from public.profiles where id = auth.uid() $$;
    create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;

    alter table public.orders enable row level security;
    create policy "orders — read" on public.orders for select
      using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());
    create policy "orders — update" on public.orders for update using (public.owns_restaurant(restaurant_id) or public.is_admin());
    create policy "orders — manager read" on public.orders for select using (public.is_manager());
    create policy "orders — manager update" on public.orders for update using (public.is_manager()) with check (public.is_manager());
    alter table public.order_items enable row level security;
    create policy "order_items — manager read" on public.order_items for select using (public.is_manager());
    alter table public.deliveries enable row level security;
    create policy "deliveries — manager read" on public.deliveries for select using (public.is_manager());
    create policy "deliveries — manager manage" on public.deliveries for all using (public.is_manager()) with check (public.is_manager());
    alter table public.cod_handovers enable row level security;
    alter table public.operational_expenses enable row level security;

    -- 0055's status guard and 0061's column guard (abridged list, same shape).
    create function public.guard_order_status() returns trigger language plpgsql security invoker set search_path = public as $$
    declare pair constant text := old.status::text || '>' || new.status::text;
    begin
      if new.status is not distinct from old.status then return new; end if;
      if public.is_admin() or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
         or current_user in ('postgres', 'supabase_admin') then return new; end if;
      if public.owns_restaurant(old.restaurant_id) and pair in ('placed>kitchen','placed>cancelled','kitchen>ready','kitchen>cancelled','ready>cancelled') then return new; end if;
      if public.is_manager() and pair in ('placed>kitchen','kitchen>ready','ready>on_the_way','on_the_way>delivered') then return new; end if;
      raise exception 'illegal order status change % for this role', pair using errcode = '42501';
    end; $$;
    create trigger orders_guard_status before update on public.orders for each row
      when (old.status is distinct from new.status) execute function public.guard_order_status();
    create function public.guard_order_update() returns trigger language plpgsql security invoker set search_path = public as $$
    begin return new; end; $$;
    create trigger guard_order_update before update on public.orders for each row execute function public.guard_order_update();

    -- 0056's restaurant lock (abridged).
    create function public.lock_restaurant_privileged_fields() returns trigger language plpgsql as $$ begin return new; end; $$;
    create trigger lock_restaurant_privileged_fields before update on public.restaurants
      for each row execute function public.lock_restaurant_privileged_fields();

    -- 0061's status trail.
    create table public.order_status_events (id bigint generated always as identity primary key,
      order_id uuid not null references public.orders on delete cascade, restaurant_id uuid not null,
      kind text not null check (kind in ('status','preparing')), from_status public.order_status, to_status public.order_status,
      actor_id uuid, reason text, created_at timestamptz not null default now());
    create function public.log_order_status_event() returns trigger language plpgsql security definer set search_path = public as $$
    begin
      if tg_op = 'INSERT' then
        insert into public.order_status_events (order_id, restaurant_id, kind, from_status, to_status, actor_id)
        values (new.id, new.restaurant_id, 'status', null, new.status, auth.uid());
      elsif new.status is distinct from old.status then
        insert into public.order_status_events (order_id, restaurant_id, kind, from_status, to_status, actor_id, reason)
        values (new.id, new.restaurant_id, 'status', old.status, new.status, auth.uid(),
                case when new.status = 'cancelled' then new.cancellation_reason end);
      end if;
      return null;
    end; $$;
    create trigger log_order_status_event after insert or update of status on public.orders
      for each row execute function public.log_order_status_event();

    grant usage on schema public, auth to anon, authenticated, service_role;
    grant all on all tables in schema public to anon, authenticated, service_role;
    grant execute on all functions in schema public to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    revoke select on public.platform_settings from anon, authenticated;
    grant select (id, delivery_radius_km) on public.platform_settings to anon, authenticated;
    revoke select on public.orders from anon, authenticated;
    grant select (id, customer_id, restaurant_id, status, total, preparing_at, cancelled_by, cancellation_reason, created_at)
      on public.orders to authenticated;
  `);

  const { A, M, MB, C, V, D1, D2, D3, D4, D5, R1, R2 } = IDS;
  await db.exec(`
    insert into public.profiles (id, role, full_name) values ('${A}','admin','Admin'),('${M}','manager','Mona'),
      ('${MB}','manager','Bina'),('${C}','customer','Asha'),('${V}','restaurant','Vik');
    insert into public.restaurants (id, owner_id, name) values ('${R1}','${V}','Spice Hub');
  `);
  await db.exec(M0081);
  await db.exec(M0141);

  const zone = async (slug) => (await db.query(`select id from public.delivery_zones where slug = '${slug}'`)).rows[0]?.id;
  const ZA = await zone("bemetara");
  await db.exec(`
    insert into public.delivery_zones (city_id, name, slug, center_lat, center_lng, radius_km)
      select city_id, 'Saja', 'saja', 21.6, 81.4, 5 from public.delivery_zones where slug = 'bemetara';
  `);
  const ZB = await zone("saja");
  await db.exec(`
    delete from public.staff_zones where user_id = '${MB}';
    insert into public.staff_zones (user_id, zone_id) values ('${MB}','${ZB}');
    insert into public.restaurants (id, owner_id, name, zone_id) values ('${R2}','${V}','Saja Dhaba','${ZB}');
    insert into public.profiles (id, role, full_name) values ('${D1}','driver','Ravi'),('${D2}','driver','Sunil'),
      ('${D3}','driver','Off Line'),('${D4}','driver','Stale Fix'),('${D5}','driver','Far Away');
    -- 0141 puts every new driver in the default zone; set each one's zones exactly.
    delete from public.staff_zones where user_id in ('${D1}','${D2}','${D3}','${D4}','${D5}');
    insert into public.staff_zones (user_id, zone_id) values ('${D1}','${ZA}'),('${D2}','${ZA}'),('${D3}','${ZA}'),('${D4}','${ZA}'),('${D5}','${ZB}');
    insert into public.rider_status (driver_id, is_online, last_fix_at, last_lat, last_lng) values
      ('${D1}', true, now(), 21.7, 81.5), ('${D2}', true, now(), 21.71, 81.51), ('${D3}', false, now(), null, null),
      ('${D4}', true, now() - interval '6 minutes', 21.7, 81.5), ('${D5}', true, now(), 21.6, 81.4);
  `);
  return { db, ZA, ZB };
}
