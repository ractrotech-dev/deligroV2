// Runs migration 0141 in an in-process Postgres (PGlite) with stubbed Supabase auth helpers.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0141.mjs
// Proves the zone scoping, audit log and session logic; it does not replace running the migration on staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0141_manager_foundation.sql", import.meta.url), "utf8");
const db = new PGlite();

// The schema as 0141 finds it: 0023's manager policies, 0047's cash tables,
// 0061's order guard and column grants.
await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  create table auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz default now(),
    updated_at timestamptz default now(), user_agent text, ip text);

  create type public.order_status as enum ('placed', 'kitchen', 'ready', 'on_the_way', 'delivered', 'cancelled');
  create type public.cash_handover_leg as enum ('rider_to_manager', 'manager_to_owner');

  create table public.profiles (id uuid primary key, role text not null);
  create table public.platform_settings (id boolean primary key default true, delivery_radius_km numeric(5,1) not null default 6.5);
  insert into public.platform_settings default values;
  create table public.restaurants (id uuid primary key, owner_id uuid, name text);
  create table public.orders (id uuid primary key, customer_id uuid, restaurant_id uuid references public.restaurants,
    status public.order_status not null default 'placed', total numeric default 0, preparing_at timestamptz,
    cancellation_reason text, created_at timestamptz default now());
  create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid references public.orders, name text);
  create table public.deliveries (id uuid primary key default gen_random_uuid(), order_id uuid unique references public.orders, driver_id uuid);
  create table public.cod_handovers (id uuid primary key default gen_random_uuid(), leg public.cash_handover_leg not null,
    amount integer not null, recorded_by uuid not null, created_at timestamptz default now());
  create table public.operational_expenses (id uuid primary key default gen_random_uuid(), amount integer not null,
    recorded_by uuid not null, created_at timestamptz default now());

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
  create policy "orders — insert" on public.orders for insert with check (customer_id = auth.uid());
  create policy "orders — manager read" on public.orders for select using (public.is_manager());
  create policy "orders — manager update" on public.orders for update using (public.is_manager()) with check (public.is_manager());
  alter table public.order_items enable row level security;
  create policy "order_items — manager read" on public.order_items for select using (public.is_manager());
  alter table public.deliveries enable row level security;
  create policy "deliveries — manager read" on public.deliveries for select using (public.is_manager());
  create policy "deliveries — manager manage" on public.deliveries for all using (public.is_manager()) with check (public.is_manager());
  alter table public.cod_handovers enable row level security;
  create policy "cod_handovers — staff read" on public.cod_handovers for select using (public.is_admin() or public.current_role() = 'manager');
  alter table public.operational_expenses enable row level security;
  create policy "operational_expenses — staff read" on public.operational_expenses for select using (public.is_admin() or public.current_role() = 'manager');

  -- 0061's guard (abridged list, same shape).
  create function public.guard_order_update() returns trigger
  language plpgsql security invoker set search_path = public as $$
  declare locked constant text[] := array['id', 'customer_id', 'restaurant_id', 'total', 'preparing_at'];
    col text; old_row jsonb := to_jsonb(old); new_row jsonb := to_jsonb(new);
  begin
    if public.is_admin() or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin') then return new; end if;
    foreach col in array locked loop
      if (old_row -> col) is distinct from (new_row -> col) then
        raise exception 'only order status may be changed by this role (attempted: %)', col;
      end if;
    end loop;
    return new;
  end; $$;
  create trigger guard_order_update before update on public.orders for each row execute function public.guard_order_update();

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  revoke select on public.orders from anon, authenticated;
  grant select (id, customer_id, restaurant_id, status, total, preparing_at, cancellation_reason, created_at) on public.orders to authenticated;
  revoke all on public.cod_handovers, public.operational_expenses from anon, authenticated;
  grant select on public.cod_handovers, public.operational_expenses to authenticated;

  -- 0081's rider tables (abridged) with their unscoped manager read policies.
  create table public.rider_status (driver_id uuid primary key, is_online boolean not null default false);
  create table public.rider_shifts (id uuid primary key default gen_random_uuid(), driver_id uuid not null);
  create table public.rider_profiles (driver_id uuid primary key, rider_code text);
  create table public.delivery_events (id bigint generated always as identity primary key, order_id uuid not null, driver_id uuid, kind text);
  alter table public.rider_status enable row level security;
  alter table public.rider_shifts enable row level security;
  alter table public.rider_profiles enable row level security;
  alter table public.delivery_events enable row level security;
  create policy "rider_status — read" on public.rider_status for select using (driver_id = auth.uid() or public.is_admin() or public.current_role() = 'manager');
  create policy "rider_shifts — read" on public.rider_shifts for select using (driver_id = auth.uid() or public.is_admin() or public.current_role() = 'manager');
  create policy "rider_profiles — read" on public.rider_profiles for select using (driver_id = auth.uid() or public.is_admin() or public.current_role() = 'manager');
  create policy "delivery_events — read" on public.delivery_events for select using (driver_id = auth.uid() or public.is_admin() or public.current_role() = 'manager');
  revoke all on public.rider_status, public.rider_shifts, public.rider_profiles, public.delivery_events from anon, authenticated;
  grant select on public.rider_status, public.rider_shifts, public.rider_profiles, public.delivery_events to authenticated;

  -- 0052's switch table with its one-dot key check.
  create table public.role_feature_flags (id uuid primary key default gen_random_uuid(),
    role text not null, feature text not null check (feature ~ '^[a-z_]+\.[a-z_]+$'), enabled boolean not null default true,
    subject_kind text not null default 'role', subject_id uuid, updated_at timestamptz not null default now(), updated_by uuid);
  grant all on public.role_feature_flags to service_role;

  -- 0056's restaurant field lock (abridged columns, same shape).
  alter table public.restaurants add column approved boolean default true, add column status text default 'active',
    add column commission_pct numeric, add column accept_cod boolean default true, add column accept_online boolean default true,
    add column cod_max_order integer, add column other_charges_per_order integer default 0, add column settlement_cycle text,
    add column rating numeric, add column rating_count integer default 0, add column rating_sum integer default 0,
    add column promoted boolean default false, add column sort_position integer, add column owner_phone_verified boolean default false;
  create function public.lock_restaurant_privileged_fields() returns trigger
  language plpgsql security invoker set search_path = public as $$
  begin
    if public.is_admin() or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
       or current_user in ('postgres', 'supabase_admin') then return new; end if;
    if new.owner_id is distinct from old.owner_id then raise exception 'approval, ownership and commission are admin-only'; end if;
    return new;
  end; $$;
  create trigger lock_restaurant_privileged_fields before update on public.restaurants
    for each row execute function public.lock_restaurant_privileged_fields();

  -- 0045's column allowlist on platform_settings, and 0061's vendor track (ungranted).
  alter table public.platform_settings add column vendor_apk_version_code integer not null default 1,
    add column vendor_apk_min_version_code integer not null default 1, add column vendor_apk_url text not null default '',
    add column vendor_apk_notes text not null default '';
  revoke select on public.platform_settings from anon, authenticated;
  grant select (id, delivery_radius_km) on public.platform_settings to anon, authenticated;
`);

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const A = id(1), M1 = id(2), M3 = id(3), C = id(4), V = id(5), U = id(6), D = id(7);
const R1 = id(101), R2 = id(102), O1 = id(201), O2 = id(202), O_NEW = id(203);
const S1 = id(301), S2 = id(302), S_OTHER = id(303);

await db.exec(`
  insert into public.profiles values ('${A}','admin'),('${M1}','manager'),('${C}','customer'),('${V}','restaurant'),('${U}','manager'),('${D}','driver');
  insert into public.restaurants (id, owner_id, name) values ('${R1}','${V}','Shop one');
  insert into public.orders (id, customer_id, restaurant_id, status) values ('${O1}','${C}','${R1}','placed');
  insert into public.order_items (order_id, name) values ('${O1}','Dal');
  insert into public.deliveries (order_id) values ('${O1}');
  insert into public.cod_handovers (leg, amount, recorded_by) values ('rider_to_manager', 500, '${M1}');
  insert into public.operational_expenses (amount, recorded_by) values (120, '${M1}');
  insert into auth.sessions (id, user_id) values ('${S1}','${U}'),('${S2}','${U}'),('${S_OTHER}','${C}');
`);

await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
async function as(role, uid, sql, jwt = {}) {
  const claims = role === "service_role" ? { role: "service_role", ...jwt } : jwt;
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role; select set_config('test.jwt','',false);"); }
}
const fails = (r, re) => !r.ok && re.test(r.msg);
const zone = async (slug) => (await db.query(`select id from public.delivery_zones where slug = '${slug}'`)).rows[0]?.id;

console.log("\n── seeding ──");
const Z1 = await zone("bemetara");
let r = await db.query(`select radius_km::float as km, is_default from public.delivery_zones`);
ok("one default zone, Bemetara, radius from settings", r.rows.length === 1 && r.rows[0].is_default && r.rows[0].km === 6.5);
r = await db.query(`select user_id from public.staff_zones order by user_id`);
ok("existing managers and riders are seeded into Bemetara", JSON.stringify(r.rows.map((x) => x.user_id)) === JSON.stringify([M1, U, D]));
r = await db.query(`select (select zone_id from public.restaurants where id = '${R1}') as rz, (select zone_id from public.orders where id = '${O1}') as oz,
  (select zone_id from public.cod_handovers limit 1) as cz, (select zone_id from public.operational_expenses limit 1) as ez`);
ok("existing shop, order and cash rows are backfilled", [r.rows[0].rz, r.rows[0].oz, r.rows[0].cz, r.rows[0].ez].every((z) => z === Z1));

// A second zone with its own shop and order; a manager with no zones at all.
await db.exec(`
  insert into public.delivery_zones (city_id, name, slug, center_lat, center_lng, radius_km)
    select city_id, 'Saja', 'saja', 21.6, 81.4, 5 from public.delivery_zones where slug = 'bemetara';
  insert into public.profiles values ('${M3}','manager');
`);
const Z2 = await zone("saja");
await db.exec(`
  insert into public.restaurants (id, owner_id, name, zone_id) values ('${R2}','${V}','Shop two','${Z2}');
  insert into public.orders (id, customer_id, restaurant_id) values ('${O2}','${C}','${R2}');
  insert into public.order_items (order_id, name) values ('${O2}','Poha');
  insert into public.deliveries (order_id) values ('${O2}');
  insert into public.cod_handovers (leg, amount, recorded_by, zone_id) values ('rider_to_manager', 300, '${A}', '${Z2}');
`);

const orderIds = (r) => (r.rows ?? []).map((x) => x.id ?? x.order_id).sort();
console.log("\n-- riders are zone-scoped too (0081's tables) --");
const D2 = id(8);
await db.exec(`
  insert into public.profiles values ('${D2}','driver');
  insert into public.staff_zones (user_id, zone_id) values ('${D2}','${Z2}');
  insert into public.rider_status (driver_id, is_online) values ('${D}', true), ('${D2}', true);
  insert into public.rider_shifts (driver_id) values ('${D}'), ('${D2}');
  insert into public.rider_profiles (driver_id, rider_code) values ('${D}','DR-0001'), ('${D2}','DR-0002');
  insert into public.delivery_events (order_id, driver_id, kind) values ('${O1}','${D}','offered'), ('${O2}','${D2}','offered');
`);
const riders = (r) => (r.rows ?? []).map((x) => x.driver_id).sort();
for (const t of ["rider_status", "rider_shifts", "rider_profiles"]) {
  r = await as("authenticated", M1, `select driver_id from public.${t}`);
  ok(`Bemetara manager reads Bemetara riders only (${t})`, JSON.stringify(riders(r)) === JSON.stringify([D]));
  r = await as("authenticated", M3, `select driver_id from public.${t}`);
  ok(`a manager with no zones reads no riders (${t})`, r.ok && r.rows.length === 0);
}
r = await as("authenticated", A, `select driver_id from public.rider_status`);
ok("admin reads every rider", r.rows?.length === 2);
r = await as("authenticated", D2, `select driver_id from public.rider_status`);
ok("a rider still reads their own status", JSON.stringify(riders(r)) === JSON.stringify([D2]));
r = await as("authenticated", M1, `select order_id from public.delivery_events`);
ok("delivery events follow the order's zone", JSON.stringify(orderIds(r)) === JSON.stringify([O1]));
r = await as("authenticated", D2, `select order_id from public.delivery_events`);
ok("a rider still reads their own events", JSON.stringify(orderIds(r)) === JSON.stringify([O2]));

console.log("\n── managers see their zones only ──");
r = await as("authenticated", M1, `select id from public.orders`);
ok("Bemetara manager reads the Bemetara order only", JSON.stringify(orderIds(r)) === JSON.stringify([O1]));
r = await as("authenticated", M1, `select order_id from public.order_items`);
ok("...and only its items", JSON.stringify(orderIds(r)) === JSON.stringify([O1]));
r = await as("authenticated", M1, `select order_id from public.deliveries`);
ok("...and only its delivery", JSON.stringify(orderIds(r)) === JSON.stringify([O1]));
r = await as("authenticated", M1, `select amount from public.cod_handovers`);
ok("...and only Bemetara cash", r.rows?.length === 1 && r.rows[0].amount === 500);
r = await as("authenticated", M3, `select id from public.orders`);
ok("a manager with no zones reads no orders", r.ok && r.rows.length === 0);
r = await as("authenticated", M3, `select order_id from public.deliveries`);
ok("...no deliveries", r.ok && r.rows.length === 0);
r = await as("authenticated", M3, `select id from public.cod_handovers union all select id from public.operational_expenses`);
ok("...and no cash records", r.ok && r.rows.length === 0);
r = await as("authenticated", A, `select id from public.orders`);
ok("admin reads both zones", r.rows?.length === 2);
r = await as("authenticated", M1, `update public.orders set status = 'kitchen' where id = '${O2}' returning id`);
ok("Bemetara manager cannot move the other zone's order", r.ok && r.rows.length === 0);
r = await as("authenticated", M1, `update public.orders set status = 'kitchen' where id = '${O1}' returning id`);
ok("...but moves their own", r.ok && r.rows.length === 1);
r = await as("authenticated", M1, `update public.deliveries set driver_id = '${D}' where order_id = '${O2}' returning id`);
ok("...and cannot dispatch the other zone's delivery", r.ok && r.rows.length === 0);

console.log("\n── the zone is the restaurant's, never the client's ──");
await as("authenticated", C, `insert into public.orders (id, customer_id, restaurant_id, zone_id) values ('${O_NEW}','${C}','${R1}','${Z2}')`);
r = await db.query(`select zone_id from public.orders where id = '${O_NEW}'`);
ok("a client-supplied zone is replaced by the shop's", r.rows[0]?.zone_id === Z1);
ok("a vendor cannot move an order between zones",
  fails(await as("authenticated", V, `update public.orders set zone_id = '${Z2}' where id = '${O1}'`), /only order status may be changed/));
ok("nor can a manager",
  fails(await as("authenticated", M1, `update public.orders set zone_id = '${Z2}' where id = '${O1}'`), /only order status may be changed/));
r = await as("authenticated", M1, `select zone_id from public.orders where id = '${O1}'`);
ok("zone_id is readable through the column grant", r.ok && r.rows[0].zone_id === Z1);
await db.exec(`insert into public.restaurants (id, owner_id, name) values ('${id(103)}','${V}','Shop three')`);
r = await db.query(`select zone_id from public.restaurants where id = '${id(103)}'`);
ok("a new shop without a zone lands in the default zone", r.rows[0].zone_id === Z1);
await as("service_role", null, `insert into public.operational_expenses (amount, recorded_by) values (40, '${M1}')`);
r = await db.query(`select zone_id from public.operational_expenses where amount = 40`);
ok("an expense takes its recorder's only zone", r.rows[0].zone_id === Z1);

console.log("\n── zones are configuration ──");
r = await as("authenticated", M1, `select slug from public.delivery_zones order by slug`);
ok("managers read zones", r.rows?.length === 2);
r = await as("authenticated", C, `select slug from public.delivery_zones`);
ok("customers do not", r.ok && r.rows.length === 0);
ok("a manager cannot assign themselves a zone",
  fails(await as("authenticated", M1, `insert into public.staff_zones (user_id, zone_id) values ('${M1}','${Z2}')`), /permission denied/));
r = await as("authenticated", M1, `select zone_id from public.staff_zones`);
ok("a manager reads their own assignments only", r.rows?.length === 1 && r.rows[0].zone_id === Z1);

console.log("\n── the audit log ──");
r = await as("service_role", null, `select public.log_ops_action('${M1}','order.status_change','order','${O1}','${Z1}','Kitchen phoned', null, '{"to":"kitchen"}', 'act-1') as id`);
ok("the server logs a manager's action", r.ok && Number(r.rows[0].id) > 0);
const firstId = r.rows?.[0]?.id;
r = await as("service_role", null, `select public.log_ops_action('${M1}','order.status_change','order','${O1}','${Z1}','again', null, null, 'act-1') as id`);
ok("a replayed client action id returns the same row", r.ok && r.rows[0].id === firstId);
r = await db.query(`select count(*)::int as n from public.ops_audit_log where client_action_id = 'act-1'`);
ok("...and stores it once", r.rows[0].n === 1);
ok("another actor's client action id is not handed back",
  fails(await as("service_role", null, `select public.log_ops_action('${A}','x.y','order', null, null, null, null, null, 'act-1')`), /client_action_id_conflict/));
ok("a manager cannot call the logger directly (no forged entries)",
  fails(await as("authenticated", M1, `select public.log_ops_action('${M1}','x.y','order', null, null, null, null, null, null)`), /permission denied/));
ok("...nor probe client action ids",
  fails(await as("authenticated", M1, `select public.log_ops_action('${M1}','x.y','order', null, null, null, null, null, 'act-1')`), /permission denied/));
ok("a customer cannot call it",
  fails(await as("authenticated", C, `select public.log_ops_action('${C}','x.y','order', null, null, null, null, null, null)`), /permission denied/));
r = await as("service_role", null, `select public.log_ops_action('${A}','zone.create','zone','${Z2}', null, 'New area', null, null, null) as id`);
ok("the server logs for the actor it authorised", r.ok && Number(r.rows[0].id) > 0);
ok("anon cannot call it",
  fails(await as("anon", null, `select public.log_ops_action('${M1}','x.y','order', null, null, null, null, null, null)`), /permission denied/));
ok("an admin cannot edit an entry",
  fails(await as("authenticated", A, `update public.ops_audit_log set reason = 'nicer'`), /append-only|permission denied/));
ok("the service role cannot edit an entry",
  fails(await as("service_role", null, `update public.ops_audit_log set reason = 'nicer'`), /append-only|permission denied/));
ok("the service role cannot delete an entry",
  fails(await as("service_role", null, `delete from public.ops_audit_log`), /append-only|permission denied/));
ok("the owner cannot delete an entry either", fails(await as("postgres", null, `delete from public.ops_audit_log`), /append-only/));
ok("nor truncate the log", fails(await as("postgres", null, `truncate public.ops_audit_log`), /append-only/));
ok("the service role cannot insert around the function",
  fails(await as("service_role", null, `insert into public.ops_audit_log (actor_id, actor_role, action, entity_type) values ('${A}','admin','x.y','order')`), /permission denied/));
r = await as("authenticated", M1, `select actor_id from public.ops_audit_log`);
ok("a manager reads only their own entries", r.rows?.length === 1 && r.rows[0].actor_id === M1);
r = await as("authenticated", A, `select actor_id from public.ops_audit_log`);
ok("an admin reads all entries", r.rows?.length === 2);

console.log("\n-- audited admin changes write the change and the entry together --");
r = await as("service_role", null, `select public.ops_create_city('${A}', 'Raipur', 'raipur') as id`);
const RAIPUR = r.rows?.[0]?.id;
ok("an admin creates a city", r.ok && !!RAIPUR);
r = await db.query(`select count(*)::int as n from public.ops_audit_log where action = 'city.create' and entity_id = '${RAIPUR}' and actor_id = '${A}'`);
ok("...and the entry is written with it", r.rows[0].n === 1);
ok("a manager cannot create a city through the RPC",
  fails(await as("service_role", null, `select public.ops_create_city('${M1}', 'Durg', 'durg')`), /forbidden/));
r = await db.query(`select count(*)::int as n from public.cities where slug = 'durg'`);
ok("...and nothing was created", r.rows[0].n === 0);
r = await as("service_role", null, `select public.ops_create_zone('${A}', '${RAIPUR}', 'Raipur Central', 'raipur-central', 21.25, 81.63, 4) as id`);
const RZ = r.rows?.[0]?.id;
ok("an admin creates a zone, logged", r.ok && !!RZ &&
  (await db.query(`select count(*)::int as n from public.ops_audit_log where action = 'zone.create' and entity_id = '${RZ}'`)).rows[0].n === 1);
r = await as("service_role", null, `select public.ops_update_zone('${A}', '${RZ}', 'Raipur Centre', 21.25, 81.63, 5, true)`);
r = await db.query(`select name, radius_km::float as km from public.delivery_zones where id = '${RZ}'`);
ok("an admin updates a zone", r.rows[0].name === 'Raipur Centre' && r.rows[0].km === 5);
r = await db.query(`select before ->> 'name' as b, after ->> 'name' as a from public.ops_audit_log where action = 'zone.update' and entity_id = '${RZ}'`);
ok("...with before and after in the entry", r.rows[0]?.b === 'Raipur Central' && r.rows[0]?.a === 'Raipur Centre');
ok("the default zone cannot be switched off",
  fails(await as("service_role", null, `select public.ops_update_zone('${A}', '${Z1}', 'Bemetara', 21.7, 81.5, 6.5, false)`), /default_zone_required/));
r = await as("service_role", null, `select public.ops_set_staff_zones('${A}', '${D2}', array['${Z1}','${Z2}']::uuid[])`);
r = await db.query(`select zone_id from public.staff_zones where user_id = '${D2}' order by zone_id`);
ok("an admin sets a rider's zones", JSON.stringify(r.rows.map((x) => x.zone_id)) === JSON.stringify([Z1, Z2].sort()));
r = await db.query(`select jsonb_array_length(before -> 'zoneIds') as b, jsonb_array_length(after -> 'zoneIds') as a from public.ops_audit_log where action = 'staff.zones_set' and entity_id = '${D2}'`);
ok("...logged with before and after", r.rows[0]?.b === 1 && r.rows[0]?.a === 2);
ok("zones are for staff only",
  fails(await as("service_role", null, `select public.ops_set_staff_zones('${A}', '${C}', array['${Z1}']::uuid[])`), /not_staff/));
ok("the RPCs are the server's, not a signed-in user's",
  fails(await as("authenticated", A, `select public.ops_create_city('${A}', 'Bhilai', 'bhilai')`), /permission denied/));

console.log("\n-- feature switch keys --");
r = await as("service_role", null, `insert into public.role_feature_flags (role, feature) values ('manager', 'manager.finance.view') returning id`);
ok("a two-part manager key can be saved", r.ok && r.rows.length === 1);
r = await as("service_role", null, `insert into public.role_feature_flags (role, feature) values ('manager', 'manager.cash') returning id`);
ok("one-part keys still can", r.ok && r.rows.length === 1);
ok("a key without a dot is refused",
  fails(await as("service_role", null, `insert into public.role_feature_flags (role, feature) values ('manager', 'manager')`), /check constraint/));
ok("a four-part key is refused",
  fails(await as("service_role", null, `insert into public.role_feature_flags (role, feature) values ('manager', 'a.b.c.d')`), /check constraint/));

console.log("\n-- a permission switch and its entry are one change --");
const DEV = id(9);
await db.exec(`insert into public.profiles values ('${DEV}','developer')`);
r = await as("service_role", null, `select public.ops_set_feature_switch('${A}', 'manager', 'manager.finance.view', 'profile', '${M1}', true)`);
ok("an admin switches a power on for one manager", r.ok);
r = await db.query(`select enabled, updated_by from public.role_feature_flags where feature = 'manager.finance.view' and subject_id = '${M1}'`);
ok("...stored once, with who", r.rows.length === 1 && r.rows[0].enabled === true && r.rows[0].updated_by === A);
r = await db.query(`select (after ->> 'enabled')::boolean as e from public.ops_audit_log where action = 'feature.switch_set' and entity_id = 'manager.finance.view:profile:${M1}'`);
ok("...and logged in the same call", r.rows.length === 1 && r.rows[0].e === true);
r = await as("service_role", null, `select public.ops_set_feature_switch('${DEV}', 'manager', 'manager.finance.view', 'profile', '${M1}', false)`);
r = await db.query(`select enabled from public.role_feature_flags where feature = 'manager.finance.view' and subject_id = '${M1}'`);
ok("a developer may change it too, replacing the row", r.rows.length === 1 && r.rows[0].enabled === false);
r = await as("service_role", null, `select public.ops_set_feature_switch('${A}', 'manager', 'manager.finance.view', 'profile', '${M1}', null)`);
r = await db.query(`select count(*)::int as n from public.role_feature_flags where feature = 'manager.finance.view' and subject_id = '${M1}'`);
ok("clearing it back to inherit removes the row", r.rows[0].n === 0);
r = await db.query(`select count(*)::int as n from public.ops_audit_log where action = 'feature.switch_set' and entity_id = 'manager.finance.view:profile:${M1}'`);
ok("...every change is on the record", r.rows[0].n === 3);
r = await as("service_role", null, `select public.ops_set_feature_switch('${A}', 'manager', 'manager.cash', 'role', null, false)`);
r = await db.query(`select enabled from public.role_feature_flags where feature = 'manager.cash' and subject_kind = 'role'`);
ok("a role-wide switch replaces the earlier role-wide row", r.rows.length === 1 && r.rows[0].enabled === false);
ok("a manager cannot change switches",
  fails(await as("service_role", null, `select public.ops_set_feature_switch('${M1}', 'manager', 'manager.cash', 'role', null, true)`), /forbidden/));
ok("a signed-in user cannot call it",
  fails(await as("authenticated", A, `select public.ops_set_feature_switch('${A}', 'manager', 'manager.cash', 'role', null, true)`), /permission denied/));

console.log("\n-- a shop's zone is admin-only --");
ok("the owner cannot move their shop to another zone",
  fails(await as("authenticated", V, `update public.restaurants set zone_id = '${Z2}' where id = '${R1}'`), /admin-only/));
r = await as("authenticated", V, `update public.restaurants set name = 'Shop one!' where id = '${R1}' returning id`);
ok("...but still edits ordinary fields", r.ok && r.rows.length === 1);
r = await as("authenticated", A, `update public.restaurants set zone_id = '${Z2}' where id = '${id(103)}' returning zone_id`);
ok("an admin moves a shop", r.ok && r.rows[0]?.zone_id === Z2);

console.log("\n-- release tracks are readable before sign-in --");
r = await as("anon", null, `select manager_apk_version_code, manager_apk_min_version_code, manager_apk_url, manager_apk_notes from public.platform_settings`);
ok("anon reads the Manager track", r.ok && r.rows[0].manager_apk_version_code === 1);
r = await as("anon", null, `select vendor_apk_version_code, vendor_apk_url from public.platform_settings`);
ok("anon reads the Partner track (0061 never granted it)", r.ok && r.rows[0].vendor_apk_version_code === 1);
r = await as("authenticated", M1, `select manager_apk_url from public.platform_settings`);
ok("authenticated reads it too", r.ok && r.rows.length === 1);

console.log("\n── notification preferences ──");
await as("service_role", null, `insert into public.notification_preferences (user_id, kind, push) values ('${M1}','order_unassigned', false)`);
r = await as("authenticated", M1, `select kind from public.notification_preferences`);
ok("a person reads their own preferences", r.rows?.length === 1);
r = await as("authenticated", M3, `select kind from public.notification_preferences`);
ok("...and nobody else's", r.ok && r.rows.length === 0);
ok("preferences are written by the server only",
  fails(await as("authenticated", M1, `update public.notification_preferences set push = true`), /permission denied/));

console.log("\n── my sessions ──");
r = await as("authenticated", U, `select id, is_current from public.my_sessions() order by id`, { session_id: S1 });
ok("a user lists their two sessions", r.rows?.length === 2);
ok("...exactly one marked current", r.rows?.filter((x) => x.is_current).length === 1 && r.rows.find((x) => x.is_current)?.id === S1);
ok("revoking the current session is refused",
  fails(await as("authenticated", U, `select public.revoke_my_session('${S1}')`, { session_id: S1 }), /use_sign_out/));
r = await as("authenticated", U, `select public.revoke_my_session('${S_OTHER}') as done`, { session_id: S1 });
ok("another user's session cannot be revoked", r.ok && r.rows[0].done === false);
r = await db.query(`select count(*)::int as n from auth.sessions where id = '${S_OTHER}'`);
ok("...and is still there", r.rows[0].n === 1);
r = await as("authenticated", U, `select public.revoke_my_session('${S2}') as done`, { session_id: S1 });
ok("revoking another own session works", r.ok && r.rows[0].done === true);
r = await db.query(`select count(*)::int as n from auth.sessions where user_id = '${U}'`);
ok("...and only that one is gone", r.rows[0].n === 1);
r = await db.query(`select count(*)::int as n from public.ops_audit_log where action = 'session.revoke' and actor_id = '${U}' and entity_id = '${S2}'`);
ok("revoking a session is logged in the same call", r.rows[0].n === 1);
await db.exec(`insert into auth.sessions (id, user_id) values ('${id(304)}','${U}'),('${id(305)}','${U}')`);
r = await as("authenticated", U, `select public.revoke_my_other_sessions() as n`, { session_id: S1 });
ok("signing out everywhere else ends the other sessions", r.ok && r.rows[0].n === 2);
r = await db.query(`select array_agg(id::text) as ids from auth.sessions where user_id = '${U}'`);
ok("...keeping this one", JSON.stringify(r.rows[0].ids) === JSON.stringify([S1]));
r = await db.query(`select (after ->> 'count')::int as c from public.ops_audit_log where action = 'session.revoke_others' and actor_id = '${U}'`);
ok("...logged with the count", r.rows[0]?.c === 2);
r = await db.query(`select count(*)::int as n from auth.sessions where id = '${S_OTHER}'`);
ok("...and nobody else's session is touched", r.rows[0].n === 1);
ok("anon cannot revoke", fails(await as("anon", null, `select public.revoke_my_other_sessions()`), /permission denied/));
ok("anon cannot list sessions", fails(await as("anon", null, `select * from public.my_sessions()`), /permission denied/));

console.log("\n── Manager app release track ──");
r = await as("service_role", null, `select manager_apk_version_code, manager_apk_url from public.platform_settings`);
ok("manager track columns exist with defaults", r.ok && r.rows[0].manager_apk_version_code === 1 && r.rows[0].manager_apk_url === "");
ok("minimum above latest is refused",
  fails(await as("service_role", null, `update public.platform_settings set manager_apk_min_version_code = 5, manager_apk_version_code = 3`), /platform_settings_manager_apk_versions/));

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);
r = await db.query(`select count(*)::int as n from public.delivery_zones where is_default`);
ok("...still one default zone", r.rows[0].n === 1);
r = await as("authenticated", M1, `select id from public.orders order by id`);
ok("...and the scoping still holds", JSON.stringify(orderIds(r)) === JSON.stringify([O1, O_NEW].sort()));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
