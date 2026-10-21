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
ok("existing managers are seeded into Bemetara", JSON.stringify(r.rows.map((x) => x.user_id)) === JSON.stringify([M1, U]));
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

console.log("\n── managers see their zones only ──");
const orderIds = (r) => (r.rows ?? []).map((x) => x.id ?? x.order_id).sort();
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
r = await as("authenticated", M1, `select public.log_ops_action('${M1}','order.status_change','order','${O1}','${Z1}','Kitchen phoned', null, '{"to":"kitchen"}', 'act-1') as id`);
ok("a manager logs their own action", r.ok && Number(r.rows[0].id) > 0);
const firstId = r.rows?.[0]?.id;
r = await as("authenticated", M1, `select public.log_ops_action('${M1}','order.status_change','order','${O1}','${Z1}','again', null, null, 'act-1') as id`);
ok("a replayed client action id returns the same row", r.ok && r.rows[0].id === firstId);
r = await db.query(`select count(*)::int as n from public.ops_audit_log where client_action_id = 'act-1'`);
ok("...and stores it once", r.rows[0].n === 1);
ok("a manager cannot log as someone else",
  fails(await as("authenticated", M1, `select public.log_ops_action('${A}','x.y','order', null, null, null, null, null, null)`), /forbidden/));
ok("a customer cannot log at all",
  fails(await as("authenticated", C, `select public.log_ops_action('${C}','x.y','order', null, null, null, null, null, null)`), /forbidden/));
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
