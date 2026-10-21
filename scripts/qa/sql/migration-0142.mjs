// Runs migration 0142 in an in-process Postgres (PGlite) with stubbed Supabase auth helpers,
// on top of the real 0081 and 0141 (an abridged base schema stands in for 0001–0061).
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0142.mjs
// Proves the intervention RPCs, replay, zone and eligibility checks; it does not replace staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), "utf8");
const M0081 = read("0081_rider_app_foundation.sql");
const M0141 = read("0141_manager_foundation.sql");
const MIGRATION = read("0142_manager_orders_live.sql");
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
  create table public.restaurants (id uuid primary key, owner_id uuid, name text);
  create table public.orders (id uuid primary key default gen_random_uuid(), customer_id uuid, restaurant_id uuid references public.restaurants,
    status public.order_status not null default 'placed', total integer not null default 0, preparing_at timestamptz,
    cancelled_by text, cancellation_reason text, created_at timestamptz default now());
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

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const A = id(1), M = id(2), MB = id(3), C = id(4), V = id(5), D1 = id(6), D2 = id(7), D3 = id(8), D4 = id(9), D5 = id(10);
const R1 = id(101), R2 = id(102);
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
  insert into public.staff_zones (user_id, zone_id) values ('${D1}','${ZA}'),('${D2}','${ZA}'),('${D3}','${ZA}'),('${D4}','${ZA}'),('${D5}','${ZB}');
  insert into public.rider_status (driver_id, is_online, last_fix_at, last_lat, last_lng) values
    ('${D1}', true, now(), 21.7, 81.5), ('${D2}', true, now(), 21.71, 81.51), ('${D3}', false, now(), null, null),
    ('${D4}', true, now() - interval '6 minutes', 21.7, 81.5), ('${D5}', true, now(), 21.6, 81.4);
`);

await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
async function as(role, uid, sql) {
  const claims = role === "service_role" ? { role: "service_role" } : {};
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message), detail: e.detail }; }
  finally { await db.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
}
const fails = (r, re) => !r.ok && re.test(r.msg);
const srv = (sql) => as("service_role", null, sql);
const one = async (sql) => (await db.query(sql)).rows[0];
let n = 0;
const newOrder = async (rid = R1, status = "placed") => {
  const oid = id(1000 + ++n);
  await db.exec(`insert into public.orders (id, customer_id, restaurant_id, total) values ('${oid}','${C}','${rid}', 420);
    insert into public.order_items (order_id, name, qty, price) values ('${oid}','Paneer', 2, 180);`);
  if (status !== "placed") await db.exec(`update public.orders set status = '${status}' where id = '${oid}'`);
  return oid;
};
const audits = async (action, oid) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}' and entity_id = '${oid}'`)).n;

console.log("\n── the short code ──");
const O1 = await newOrder();
let r = await one(`select short_code from public.orders where id = '${O1}'`);
ok("short_code is the first 8 characters, upper-cased", r.short_code === O1.slice(0, 8).toUpperCase());
r = await as("authenticated", C, `select short_code from public.orders where id = '${O1}'`);
ok("authenticated can read it through the column grant", r.ok && r.rows.length === 1);

console.log("\n── advance ──");
r = await srv(`select public.ops_advance_order('${M}','${O1}','placed', null, 'c1') as s`);
ok("a manager advances placed → kitchen", r.ok && r.rows[0].s.status === "kitchen");
r = await one(`select actor_id from public.order_status_events where order_id = '${O1}' and to_status = 'kitchen'`);
ok("...the status event names the manager", r?.actor_id === M);
ok("...one audit row", (await audits("order.advance", O1)) === 1);
r = await srv(`select public.ops_advance_order('${M}','${O1}','placed', null, 'c1') as s`);
ok("replaying the same client action returns the current state", r.ok && r.rows[0].s.status === "kitchen");
ok("...still one event and one audit row",
  (await one(`select count(*)::int as n from public.order_status_events where order_id = '${O1}' and to_status = 'kitchen'`)).n === 1
  && (await audits("order.advance", O1)) === 1);
ok("advancing from a status that has moved is stale",
  fails(await srv(`select public.ops_advance_order('${M}','${O1}','placed', null, 'c2')`), /stale/));
ok("someone else's client action id is a conflict, not a replay",
  fails(await srv(`select public.ops_advance_order('${A}','${O1}','kitchen', null, 'c1')`), /client_action_id_conflict/));
const OB = await newOrder(R2);
ok("a manager cannot touch another zone's order",
  fails(await srv(`select public.ops_advance_order('${M}','${OB}','placed', null, 'c3')`), /forbidden/));
ok("an admin can", (await srv(`select public.ops_advance_order('${A}','${OB}','placed', null, 'c4') as s`)).ok);
ok("a signed-in user cannot call the RPC directly",
  fails(await as("authenticated", M, `select public.ops_advance_order('${M}','${O1}','kitchen', null, 'c5')`), /permission denied/));
ok("the zone is checked in the database even for the service role with a forged actor",
  fails(await srv(`select public.ops_advance_order('${C}','${O1}','kitchen', null, 'c6')`), /forbidden/));

console.log("\n── cancel ──");
const O2 = await newOrder();
await db.exec(`insert into public.deliveries (order_id) values ('${O2}')`);
ok("cancel without a reason is refused",
  fails(await srv(`select public.ops_cancel_order('${M}','${O2}','', 'k1')`), /reason_required/));
r = await srv(`select public.ops_cancel_order('${M}','${O2}','Customer called to cancel', 'k2') as s`);
ok("cancel with a reason", r.ok && r.rows[0].s.status === "cancelled" && r.rows[0].s.delivery_status === "cancelled");
r = await one(`select cancelled_by, cancellation_reason from public.orders where id = '${O2}'`);
ok("...cancelled_by is the actor's role, the reason kept", r.cancelled_by === "manager" && r.cancellation_reason === "Customer called to cancel");
r = await one(`select reason, actor_id from public.delivery_events where order_id = '${O2}' and kind = 'cancelled'`);
ok("...the delivery's cancelled event carries the reason and the manager", r?.reason === "Customer called to cancel" && r?.actor_id === M);
ok("a cancelled order cannot be cancelled again",
  fails(await srv(`select public.ops_cancel_order('${M}','${O2}','Again', 'k3')`), /terminal/));

console.log("\n── assign ──");
const O3 = await newOrder(R1, "ready");
const assignErr = async (rider, cid) => {
  const x = await srv(`select public.ops_assign_rider('${M}','${O3}','${rider}', null, '${cid}')`);
  return x.ok ? "ok" : `${x.msg}:${x.detail ?? ""}`;
};
ok("an offline rider is ineligible (offline)", (await assignErr(D3, "a1")) === "rider_ineligible:offline");
ok("a stale fix is ineligible (stale_fix)", (await assignErr(D4, "a2")) === "rider_ineligible:stale_fix");
ok("a rider of another zone is ineligible (out_of_zone)", (await assignErr(D5, "a3")) === "rider_ineligible:out_of_zone");
await db.exec(`update public.rider_status set break_until = now() + interval '10 minutes' where driver_id = '${D2}'`);
ok("a rider on a break is ineligible (on_break)", (await assignErr(D2, "a4")) === "rider_ineligible:on_break");
await db.exec(`update public.rider_status set break_until = null where driver_id = '${D2}'`);
r = await srv(`select public.ops_assign_rider('${M}','${O3}','${D1}', null, 'a5') as s`);
ok("an eligible rider is assigned", r.ok && r.rows[0].s.delivery_status === "assigned");
r = await one(`select driver_id, driver_location_source from public.deliveries where order_id = '${O3}'`);
ok("...on a new delivery row, location source none", r.driver_id === D1 && r.driver_location_source === "none");
r = await one(`select actor_id from public.delivery_events where order_id = '${O3}' and kind = 'accepted'`);
ok("...the accepted event names the manager", r?.actor_id === M);
ok("assigning again is already_assigned", (await assignErr(D2, "a6")).startsWith("already_assigned"));

console.log("\n── reassign ──");
ok("reassign needs a reason",
  fails(await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D2}','', false, 'r1')`), /reason_required/));
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D1}','Same rider', false, 'r2')`);
ok("reassigning to the current rider is refused (current_rider)", !r.ok && r.msg === "rider_ineligible" && r.detail === "current_rider");
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D2}','Ravi has a flat tyre', false, 'r3') as s`);
ok("reassign moves the delivery to the new rider", r.ok && (await one(`select driver_id from public.deliveries where order_id = '${O3}'`)).driver_id === D2);
r = (await db.query(`select driver_id, reason, actor_id from public.delivery_events where order_id = '${O3}' and kind = 'reassigned'`)).rows;
ok("...exactly one reassigned event, naming the old rider, with the reason and the manager",
  r.length === 1 && r[0].driver_id === D1 && r[0].reason === "Ravi has a flat tyre" && r[0].actor_id === M);
r = await one(`select before ->> 'riderId' as b, after ->> 'riderId' as a from public.ops_audit_log where action = 'delivery.reassign' and entity_id = '${O3}'`);
ok("...the audit row carries both riders", r?.b === D1 && r?.a === D2);
await db.exec(`update public.deliveries set status = 'picked_up' where order_id = '${O3}'`);
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D1}','Bike broke down', false, 'r4')`);
ok("a picked-up delivery needs afterPickup", !r.ok && r.msg === "picked_up");
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D1}','Bike broke down', true, 'r5') as s`);
ok("...and moves with it", r.ok && (await one(`select driver_id from public.deliveries where order_id = '${O3}'`)).driver_id === D1);
await db.exec(`update public.deliveries set status = 'delivered' where order_id = '${O3}'`);
ok("a delivered delivery cannot be reassigned",
  fails(await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D2}','Too late', true, 'r6')`), /terminal/));

console.log("\n── corrections ──");
const O4 = await newOrder(R1, "ready");
r = await srv(`select public.ops_correct_order('${M}','${O4}','status','kitchen', null, 'Marked ready by mistake', 'x1') as s`);
ok("a status correction ready → kitchen", r.ok && r.rows[0].s.status === "kitchen");
r = await one(`select actor_id, reason from public.order_status_events where order_id = '${O4}' and to_status = 'kitchen' order by id desc limit 1`);
ok("...logged with the manager and the reason", r?.actor_id === M && r?.reason === "Marked ready by mistake");
ok("...audited", (await audits("order.correct.status", O4)) === 1);
ok("a correction needs a reason",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','status','ready', null, ' ', 'x2')`), /reason_required/));
ok("a correction into cancelled is refused (use cancel)",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','status','cancelled', null, 'Oops', 'x3')`), /invalid_transition/));
const O5 = await newOrder(R1, "delivered");
await db.exec(`insert into public.deliveries (order_id, driver_id, status, picked_up_at, cod_collected_at, cod_collected_amount)
  values ('${O5}','${D1}','delivered', now(), now(), 420)`);
ok("a delivered order with cash collected is financially closed",
  fails(await srv(`select public.ops_correct_order('${M}','${O5}','status','on_the_way', null, 'Not delivered', 'x4')`), /financially_closed/));
const O6 = await newOrder(R1, "delivered");
await db.exec(`insert into public.vendor_settlement_orders (order_id) values ('${O6}')`);
ok("...and so is one in a settlement",
  fails(await srv(`select public.ops_correct_order('${M}','${O6}','status','on_the_way', null, 'Not delivered', 'x5')`), /financially_closed/));
r = await srv(`select public.ops_correct_order('${M}','${O4}','item_unavailable', null,
  (select id from public.order_items where order_id = '${O4}'), 'Paneer ran out', 'x6') as s`);
ok("item unavailable queues a pending refund", r.ok);
r = await one(`select amount, status, origin, requested_by from public.refunds where order_id = '${O4}'`);
ok("...for the line value, origin manager", r?.amount === 360 && r?.status === "pending" && r?.origin === "manager" && r?.requested_by === M);
ok("...and the order total is untouched", (await one(`select total from public.orders where id = '${O4}'`)).total === 420);
ok("a second pending refund on the order is refused",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','item_unavailable', null,
    (select id from public.order_items where order_id = '${O4}'), 'Again', 'x7')`), /invalid_transition/));
const O7 = await newOrder(R1, "on_the_way");
await db.exec(`insert into public.deliveries (order_id, driver_id, status, assigned_at) values ('${O7}','${D1}','assigned', now())`);
r = await srv(`select public.ops_correct_order('${M}','${O7}','delivery_status','picked_up', null, 'Rider forgot to tap', 'x8') as s`);
ok("a delivery status correction", r.ok && r.rows[0].s.delivery_status === "picked_up");
r = await one(`select reason from public.delivery_events where order_id = '${O7}' and kind = 'corrected'`);
ok("...logged as a corrected event with the reason", r?.reason === "Rider forgot to tap");
ok("the manager's own JWT still cannot change a locked column",
  fails(await as("authenticated", M, `update public.orders set zone_id = '${ZB}' where id = '${O4}'`), /only order status may be changed/));

console.log("\n── notes ──");
r = await srv(`select public.ops_add_order_note('${M}','${O4}','Customer asked for extra napkins', 'n1') as s`);
ok("a manager adds a note", r.ok);
r = await as("authenticated", M, `select body from public.order_ops_notes where order_id = '${O4}'`);
ok("...readable by a manager of the zone", r.ok && r.rows.length === 1);
r = await as("authenticated", MB, `select body from public.order_ops_notes where order_id = '${O4}'`);
ok("...not by a manager of another zone", r.ok && r.rows.length === 0);
r = await as("authenticated", C, `select body from public.order_ops_notes`);
ok("...nor by the customer", r.ok && r.rows.length === 0);
ok("notes cannot be written directly",
  fails(await as("authenticated", M, `insert into public.order_ops_notes (order_id, author_id, body) values ('${O4}','${M}','sneaky')`), /permission denied/));
ok("nobody can edit the audit log",
  fails(await srv(`update public.ops_audit_log set reason = 'nicer'`), /append-only|permission denied/));

console.log("\n── the vendor's own changes still log the vendor ──");
const O8 = await newOrder();
r = await as("authenticated", V, `update public.orders set status = 'kitchen' where id = '${O8}' returning id`);
ok("the vendor accepts their order", r.ok && r.rows.length === 1);
r = await one(`select actor_id from public.order_status_events where order_id = '${O8}' and to_status = 'kitchen'`);
ok("...and the event names the vendor, not a leftover ops actor", r?.actor_id === V);

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
