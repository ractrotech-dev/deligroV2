// Runs migrations 0081 then 0082 in one in-process Postgres (PGlite) with stubbed Supabase auth,
// orders and storage. Needs: npm i --no-save @electric-sql/pglite@0.2.17
// Usage: node scripts/qa/sql/migration-0082.mjs
// Proves the trigger, constraint, privilege and RLS logic; it does not replace running the migration
// on staging. 0082 re-declares guard_delivery_transition and log_delivery_event, so the last section
// re-runs 0081's key assertions against the re-declared functions.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), "utf8");
const M0081 = read("0081_rider_app_foundation.sql");
const M0082 = read("0082_rider_jobs.sql");
const db = new PGlite();

await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  -- Supabase default: every table, sequence and function created later in public
  -- is granted to the API roles. The migrations have to take that back themselves.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  -- Storage, as a plain table: the migration only inserts a bucket row.
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;

  create table public.profiles (id uuid primary key, role text not null, full_name text,
    created_at timestamptz not null default now());
  create table public.restaurants (id uuid primary key, owner_id uuid);
  create table public.orders (id uuid primary key, status text not null default 'ready',
    customer_id uuid, restaurant_id uuid,
    pickup_otp text default '1111', delivery_otp text default '2222');
  create type public.delivery_status as enum ('unassigned', 'assigned', 'picked_up', 'delivered', 'cancelled');
  create table public.deliveries (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null unique references public.orders (id) on delete cascade,
    driver_id uuid references public.profiles (id) on delete set null,
    status public.delivery_status not null default 'unassigned',
    assigned_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz,
    driver_lat double precision, driver_lng double precision, driver_location_at timestamptz,
    offered_driver_id uuid references public.profiles (id) on delete set null, offered_at timestamptz,
    cod_collected_amount integer, cod_collected_at timestamptz);
  create table public.platform_settings (id boolean primary key default true check (id),
    business_name text not null default 'Deligro', vendor_commission_pct numeric);
  insert into public.platform_settings (id) values (true);

  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.current_role() returns text language sql stable security definer set search_path = public as $$
    select role from public.profiles where id = auth.uid() $$;
  create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;

  -- 0001/0023/0055: managers write deliveries with their own JWT; vendors and admins update orders.
  alter table public.deliveries enable row level security;
  create policy "deliveries — manager manage" on public.deliveries for all
    using (public.is_admin() or public.current_role() = 'manager')
    with check (public.is_admin() or public.current_role() = 'manager');
  alter table public.profiles enable row level security;
  create policy "profiles — read" on public.profiles for select using (true);
  create policy "profiles — admin update" on public.profiles for update using (public.is_admin()) with check (public.is_admin());
  alter table public.orders enable row level security;
  create policy "orders — read" on public.orders for select
    using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());
  create policy "orders — update" on public.orders for update
    using (public.owns_restaurant(restaurant_id) or public.is_admin())
    with check (public.owns_restaurant(restaurant_id) or public.is_admin());

  -- 0024/0053 attach orders_guard_update; 0082 replaces the function behind it in place.
  create function public.guard_order_update() returns trigger language plpgsql as $$ begin return new; end $$;
  create trigger orders_guard_update before update on public.orders
    for each row execute function public.guard_order_update();

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  -- 0032/0045: platform_settings is readable per column.
  revoke select on public.platform_settings from anon, authenticated;
  grant select (id, business_name) on public.platform_settings to anon, authenticated;
  -- 0058: orders is readable per column, everything except the two handover codes.
  revoke select on public.orders from anon, authenticated;
  grant select (id, status, customer_id, restaurant_id) on public.orders to authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`);

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const D1 = id(0xd1), D2 = id(0xd2), M = id(0xe1), A = id(0xa1), C = id(0xc1), V = id(0xb1), R = id(0xf1);
await db.exec(`
  insert into public.profiles (id, role, full_name, created_at) values
    ('${D1}','driver','First rider','2026-01-01'),
    ('${D2}','driver','Second rider','2026-02-01'),
    ('${M}','manager','Manager','2026-01-05'),
    ('${A}','admin','Admin','2026-01-06'),
    ('${C}','customer','Customer','2026-01-07'),
    ('${V}','vendor','Vendor','2026-01-08');
  insert into public.restaurants (id, owner_id) values ('${R}','${V}');
`);
const O = (i) => id(0x100 + i);
for (let i = 1; i <= 70; i++) {
  await db.exec(`insert into public.orders (id, customer_id, restaurant_id) values ('${O(i)}','${C}','${R}')`);
}

await db.exec(M0081);
let applied = true;
try { await db.exec(M0082); } catch (e) { applied = false; console.log(`0082 did not apply: ${e.message}`); }

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
ok("0082 applies on top of 0081", applied);

async function run(sql) {
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message), code: e.code, detail: e.detail }; }
}
async function as(role, uid, sql) {
  await db.exec(`set role ${role};
    select set_config('test.uid','${uid ?? ""}',false);
    select set_config('test.jwt','{"role":"${role}"}',false);`);
  try { return await run(sql); }
  finally { await db.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
}
const denied = (r) => !r.ok && /permission denied/.test(r.msg);
const refused = (r) => !r.ok && /invalid_delivery_transition/.test(r.msg) && r.code === "23514";
const checkFails = (r) => !r.ok && r.code === "23514";
const one = async (sql) => (await db.query(sql)).rows[0];
const count = async (sql) => Number((await one(`select count(*)::int as n from (${sql}) q`)).n);
const kinds = async (o) => (await db.query(`select kind from public.delivery_events where order_id = '${o}' order by id`)).rows.map((r) => r.kind);
const delivery = (o) => one(`select * from public.deliveries where order_id = '${o}'`);
const did = async (o) => (await delivery(o)).id;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function assigned(o, driver = D1) {
  await db.exec(`insert into public.deliveries (order_id, driver_id, status, assigned_at) values ('${o}','${driver}','assigned',now())`);
  return did(o);
}
async function pickedUp(o, driver = D1) {
  const d = await assigned(o, driver);
  await db.exec(`update public.deliveries set status = 'picked_up', pickup_method = 'code' where id = '${d}'`);
  return d;
}
async function exception(o, kind, status = "pending", driver = D1) {
  const d = await did(o);
  // A decided row carries its decision time (delivery_exceptions_decided_check).
  return (await one(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status, decided_at)
    values ('${d}','${o}','${driver}','${kind}','test','${status}', ${status === "pending" ? "null" : "now()"}) returning id`)).id;
}

console.log("\n── failed requires an approved failed_delivery / customer_unreachable / wrong_address ──");
let d = await pickedUp(O(20));
const fail = (o, extra = "") => run(`update public.deliveries set status = 'failed', failure_reason = 'customer_unreachable'${extra} where order_id = '${o}'`);
let r = await fail(O(20));
ok("picked_up -> failed with a reason but no exception is refused", refused(r));
ok("...and DETAIL names the rule", /approved/.test(r.detail ?? ""));
const pendingId = await exception(O(20), "customer_unreachable");
ok("...a pending customer_unreachable is not enough", refused(await fail(O(20))));
await assigned(O(21));
await exception(O(21), "customer_unreachable", "approved");
ok("...an approved one on ANOTHER delivery is not enough", refused(await fail(O(20))));
await db.exec(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status, decided_at)
  values ('${d}','${O(20)}','${D2}','failed_delivery','other rider','approved', now())`);
ok("...an approved one raised by ANOTHER rider is not enough", refused(await fail(O(20))));
await db.exec(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status, decided_at)
  values ('${d}','${O(20)}','${D1}','go_offline','x','approved', now())`);
ok("...an approved exception of an unrelated kind (go_offline) is not enough", refused(await fail(O(20))));
await db.exec(`update public.delivery_exceptions set status = 'rejected', decided_at = now() where id = '${pendingId}'`);
ok("...a rejected customer_unreachable is not enough", refused(await fail(O(20))));
await exception(O(20), "customer_unreachable", "approved");
ok("after an approved customer_unreachable, picked_up -> failed succeeds", (await fail(O(20))).ok);
d = await delivery(O(20));
ok("...failed_at stamped and the failed event logged with its reason",
  d.failed_at !== null && (await one(`select reason from public.delivery_events where order_id = '${O(20)}' and kind = 'failed'`))?.reason === "customer_unreachable");

await assigned(O(22));
await exception(O(22), "wrong_address", "approved");
ok("an approved wrong_address lets an assigned delivery fail", (await fail(O(22))).ok);
await pickedUp(O(23));
await exception(O(23), "failed_delivery", "approved");
ok("an approved failed_delivery lets a picked-up delivery fail", (await fail(O(23))).ok);

await pickedUp(O(24));
ok("a correction bypasses the exception requirement", (await fail(O(24), ", correction_reason = 'ops_failed'")).ok);
await pickedUp(O(25));
ok("...but a correction still needs a failure_reason (0081)",
  refused(await run(`update public.deliveries set status = 'failed', correction_reason = 'ops' where order_id = '${O(25)}'`)));
await pickedUp(O(26));
await exception(O(26), "failed_delivery", "approved");
r = await as("authenticated", M, `update public.deliveries set status = 'failed', failure_reason = 'refused' where order_id = '${O(26)}'`);
ok("a manager's own-JWT failure with an approved exception works (the guard reads exceptions under their RLS)", r.ok);
await pickedUp(O(27));
await exception(O(27), "failed_delivery", "approved");
r = await as("service_role", null, `update public.deliveries set status = 'failed', failure_reason = 'refused' where order_id = '${O(27)}'`);
ok("the service role's failure with an approved exception works", r.ok);

console.log("\n── delivery_method = 'ops_approved' requires an approved complete_without_code ──");
await pickedUp(O(28));
const opsDeliver = (o, extra = "") => run(`update public.deliveries set status = 'delivered', delivery_method = 'ops_approved'${extra} where order_id = '${o}'`);
ok("picked_up -> delivered (ops_approved) without approval is refused", refused(await opsDeliver(O(28))));
ok("...setting ops_approved without a status move is refused too",
  refused(await run(`update public.deliveries set delivery_method = 'ops_approved' where order_id = '${O(28)}'`)));
await exception(O(28), "manual_pickup", "approved");
ok("...an approved manual_pickup is not enough", refused(await opsDeliver(O(28))));
await exception(O(28), "complete_without_code", "approved");
ok("with an approved complete_without_code it succeeds", (await opsDeliver(O(28))).ok);
ok("...and the delivered event carries ops_approved",
  (await one(`select method from public.delivery_events where order_id = '${O(28)}' and kind = 'delivered'`))?.method === "ops_approved");
await pickedUp(O(29));
ok("a correction bypasses it", (await opsDeliver(O(29), ", correction_reason = 'ops_completed'")).ok);
await pickedUp(O(30));
ok("delivery_method = 'code' needs no exception", (await run(`update public.deliveries set status = 'delivered', delivery_method = 'code' where order_id = '${O(30)}'`)).ok);

console.log("\n── pickup_method = 'manual' requires an approved manual_pickup ──");
await assigned(O(31));
const manualPickup = (o, extra = "") => run(`update public.deliveries set status = 'picked_up', pickup_method = 'manual'${extra} where order_id = '${o}'`);
ok("assigned -> picked_up (manual) without approval is refused", refused(await manualPickup(O(31))));
await exception(O(31), "manual_pickup");
ok("...a pending manual_pickup is not enough", refused(await manualPickup(O(31))));
await db.exec(`update public.delivery_exceptions set status = 'approved', decided_at = now() where kind = 'manual_pickup' and order_id = '${O(31)}'`);
ok("with an approved manual_pickup it succeeds", (await manualPickup(O(31))).ok);
ok("...and the picked_up event carries manual",
  (await one(`select method from public.delivery_events where order_id = '${O(31)}' and kind = 'picked_up'`))?.method === "manual");
await assigned(O(32));
ok("a correction bypasses it", (await manualPickup(O(32), ", correction_reason = 'ops_pickup'")).ok);

console.log("\n── delivered requires old status picked_up (Phase 1 review) ──");
await assigned(O(33));
ok("picked_up_at can be stamped on an assigned row", (await run(`update public.deliveries set picked_up_at = now() where order_id = '${O(33)}'`)).ok);
r = await run(`update public.deliveries set status = 'delivered', delivery_method = 'code' where order_id = '${O(33)}'`);
ok("assigned -> delivered is refused even with picked_up_at set", refused(r) && /picked/.test(r.detail ?? ""));
ok("...a correction still may", (await run(`update public.deliveries set status = 'delivered', delivery_method = 'staff', correction_reason = 'staff_marked_delivered' where order_id = '${O(33)}'`)).ok);

console.log("\n── reassignment logs reassigned (loser) and accepted (taker) ──");
await assigned(O(34), D1);
ok("driver D1 -> D2", (await run(`update public.deliveries set driver_id = '${D2}' where order_id = '${O(34)}'`)).ok);
let rows = (await db.query(`select kind, driver_id from public.delivery_events where order_id = '${O(34)}' order by id`)).rows;
ok("events: accepted(D1), reassigned(D1), accepted(D2)", same(rows.map((x) => [x.kind, x.driver_id]),
  [["accepted", D1], ["reassigned", D1], ["accepted", D2]]));
ok("unassigned -> assigned still logs one accepted",
  (await run(`insert into public.deliveries (order_id) values ('${O(35)}')`)).ok
  && (await run(`update public.deliveries set status = 'assigned', driver_id = '${D1}' where order_id = '${O(35)}'`)).ok
  && same(await kinds(O(35)), ["accepted"]));
ok("clearing the rider without a correction is refused (a release is a correction)",
  refused(await run(`update public.deliveries set driver_id = null, status = 'unassigned' where order_id = '${O(35)}'`))
  && same(await kinds(O(35)), ["accepted"]));
const Z = "aaaaaaaa-0000-0000-0000-0000000000ff";
await assigned(O(36), D1);
r = await run(`update public.deliveries set driver_id = '${D2}', last_action_id = '${Z}' where order_id = '${O(36)}'`);
ok("a reassignment carrying an action id records it exactly once", r.ok
  && (await count(`select 1 from public.delivery_events where client_action_id = '${Z}'`)) === 1);
ok("...and replaying it raises 23505", (await run(`update public.deliveries set driver_id = '${D1}', last_action_id = '${Z}' where order_id = '${O(36)}'`)).code === "23505");

let ev;
console.log("\n── release back to dispatch (driver -> null) ──");
await pickedUp(O(62), D1);
r = await run(`update public.deliveries set driver_id = null, status = 'unassigned', correction_reason = 'released:go_offline:62' where order_id = '${O(62)}'`);
ok("a picked-up job cannot be released, even as a correction (P2-R9: the rider has the food)", refused(r) && /assigned/.test(r.detail ?? ""));
ok("...and stays with its rider", (await delivery(O(62))).driver_id === D1 && (await delivery(O(62))).status === "picked_up");
await assigned(O(41), D1);
// Arrived at the shop, and a stray picked_up_at on the assigned row (possible
// without a status move): a release must clear both.
await db.exec(`update public.deliveries set arrived_pickup_at = now(), picked_up_at = now() where order_id = '${O(41)}';`);
ok("a non-correction attempt to clear a stamp still raises",
  refused(await run(`update public.deliveries set arrived_pickup_at = null where order_id = '${O(41)}'`)));
ok("a non-correction release is refused",
  refused(await run(`update public.deliveries set driver_id = null, status = 'unassigned' where order_id = '${O(41)}'`)));
r = await run(`update public.deliveries set driver_id = null, status = 'assigned', correction_reason = 'released:a' where order_id = '${O(41)}'`);
ok("a release must land on unassigned", refused(r) && /unassigned/.test(r.detail ?? ""));
r = await run(`update public.deliveries set driver_id = null, status = 'unassigned', correction_reason = 'released:go_offline:1' where order_id = '${O(41)}'`);
ok("a release as a correction succeeds", r.ok);
d = await delivery(O(41));
ok("...and clears every per-rider stamp and the pickup method",
  d.driver_id === null && d.status === "unassigned" && d.assigned_at === null && d.arrived_pickup_at === null
  && d.picked_up_at === null && d.departed_pickup_at === null && d.arrived_drop_at === null && d.pickup_method === null);
ev = await one(`select driver_id, reason from public.delivery_events where order_id = '${O(41)}' and kind = 'released'`);
ok("...writes released naming the rider who lost it, with the reason", ev?.driver_id === D1 && ev.reason === "released:go_offline:1");
ok("...then corrected", (await kinds(O(41))).slice(-2).join() === "released,corrected");
ok("the next rider accepts", (await run(`update public.deliveries set status = 'assigned', driver_id = '${D2}', assigned_at = now() where order_id = '${O(41)}'`)).ok
  && (await kinds(O(41))).at(-1) === "accepted");
ok("...and can stamp arrival, pickup, departure and arrival again",
  (await run(`update public.deliveries set arrived_pickup_at = now() where order_id = '${O(41)}'`)).ok
  && (await run(`update public.deliveries set status = 'picked_up', pickup_method = 'code', departed_pickup_at = now() where order_id = '${O(41)}'`)).ok
  && (await run(`update public.deliveries set arrived_drop_at = now() where order_id = '${O(41)}'`)).ok
  && (await run(`update public.deliveries set status = 'delivered', delivery_method = 'code' where order_id = '${O(41)}'`)).ok);
ok("...each of those events names the new rider",
  (await count(`select 1 from public.delivery_events where order_id = '${O(41)}' and kind in ('arrived_pickup','picked_up','departed','arrived_drop','delivered') and driver_id = '${D2}'`)) === 5);
ok("a delivered job cannot be released, even as a correction",
  refused(await run(`update public.deliveries set driver_id = null, status = 'unassigned', correction_reason = 'released:late' where order_id = '${O(41)}'`)));
await assigned(O(42), D1);
r = await as("authenticated", M, `update public.deliveries set driver_id = null, status = 'unassigned', correction_reason = 'released:ops' where order_id = '${O(42)}'`);
ok("a manager's own-JWT release is logged with the manager as actor",
  r.ok && (await one(`select actor_id from public.delivery_events where order_id = '${O(42)}' and kind = 'released'`))?.actor_id === M);

console.log("\n── a deleted offer is withdrawn ──");
await db.exec(`insert into public.deliveries (order_id, offered_driver_id, offered_at) values ('${O(43)}','${D2}',now())`);
ok("deleting an offered unassigned row succeeds", (await run(`delete from public.deliveries where order_id = '${O(43)}'`)).ok);
ev = await one(`select driver_id from public.delivery_events where order_id = '${O(43)}' and kind = 'withdrawn'`);
ok("...and writes withdrawn naming the offered rider", ev?.driver_id === D2 && same(await kinds(O(43)), ["offered", "withdrawn"]));
await db.exec(`insert into public.deliveries (order_id) values ('${O(44)}')`);
ok("deleting a row never offered writes nothing",
  (await run(`delete from public.deliveries where order_id = '${O(44)}'`)).ok && (await kinds(O(44))).length === 0);
await db.exec(`insert into public.deliveries (order_id, offered_driver_id, offered_at) values ('${O(45)}','${D1}',now())`);
r = await as("authenticated", A, `delete from public.deliveries where order_id = '${O(45)}'`);
ok("an admin's own-JWT delete writes withdrawn with the admin as actor (definer trigger)",
  r.ok && (await one(`select actor_id from public.delivery_events where order_id = '${O(45)}' and kind = 'withdrawn'`))?.actor_id === A);
await db.exec(`insert into public.deliveries (order_id, offered_driver_id, offered_at) values ('${O(46)}','${D1}',now())`);
ok("deleting the ORDER of an offered row still works (cascade; nothing written for a vanished order)",
  (await run(`delete from public.orders where id = '${O(46)}'`)).ok && (await kinds(O(46))).length === 0);

console.log("\n── delivery_exceptions: kinds, statuses, one pending per kind ──");
await assigned(O(37));
const reportId = await exception(O(37), "missing_items");
ok("a report kind cannot be set approved", checkFails(await run(`update public.delivery_exceptions set status = 'approved' where id = '${reportId}'`)));
ok("...nor rejected", checkFails(await run(`update public.delivery_exceptions set status = 'rejected' where id = '${reportId}'`)));
ok("...it can be acknowledged", (await run(`update public.delivery_exceptions set status = 'acknowledged', decided_at = now() where id = '${reportId}'`)).ok);
for (const k of ["return_to_shop", "wrong_package", "vendor_delay", "other_issue"]) {
  ok(`${k} is a report (inserting it approved is refused)`, checkFails(await run(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status)
    values ('${await did(O(37))}','${O(37)}','${D1}','${k}','x','approved')`)));
}
const reqId = await exception(O(37), "wrong_address");
ok("a request kind cannot be set acknowledged", checkFails(await run(`update public.delivery_exceptions set status = 'acknowledged' where id = '${reqId}'`)));
for (const k of ["customer_unreachable", "complete_without_code", "failed_delivery", "manual_pickup", "go_offline"]) {
  ok(`${k} is a request (inserting it acknowledged is refused)`, checkFails(await run(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status)
    values ('${await did(O(37))}','${O(37)}','${D1}','${k}','x','acknowledged')`)));
}
ok("an unknown kind is refused", checkFails(await run(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason)
  values ('${await did(O(37))}','${O(37)}','${D1}','teleport','x')`)));
ok("an unknown status is refused", checkFails(await run(`update public.delivery_exceptions set status = 'maybe' where id = '${reqId}'`)));
ok("status defaults to pending", (await one(`select status from public.delivery_exceptions where id = '${reqId}'`)).status === "pending");
r = await run(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason)
  values ('${await did(O(37))}','${O(37)}','${D1}','wrong_address','again')`);
ok("a second pending wrong_address for the same delivery raises 23505", !r.ok && r.code === "23505");
ok("...a pending exception of another kind is fine", (await run(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason)
  values ('${await did(O(37))}','${O(37)}','${D1}','customer_unreachable','x')`)).ok);
await db.exec(`update public.delivery_exceptions set status = 'rejected', decided_at = now() where id = '${reqId}'`);
ok("...once the first is decided a new pending wrong_address is allowed", (await run(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason)
  values ('${await did(O(37))}','${O(37)}','${D1}','wrong_address','again')`)).ok);
const nE = await count(`select 1 from public.delivery_exceptions where order_id = '${O(37)}'`);
await db.exec(`delete from public.deliveries where order_id = '${O(37)}'`);
ok(`deleting the delivery cascades its exceptions (${nE} rows)`, nE > 0 && (await count(`select 1 from public.delivery_exceptions where order_id = '${O(37)}'`)) === 0);

console.log("\n── delivery_exceptions RLS ──");
await assigned(O(38), D2);
await exception(O(38), "vendor_delay", "pending", D2);
const all = await count(`select 1 from public.delivery_exceptions`);
const mine = await count(`select 1 from public.delivery_exceptions where driver_id = '${D1}'`);
r = await as("authenticated", D1, `select driver_id from public.delivery_exceptions`);
ok(`a rider reads only their own exceptions (${mine} of ${all})`, r.ok && mine > 0 && mine < all && r.rows.length === mine && r.rows.every((x) => x.driver_id === D1));
r = await as("authenticated", M, `select id from public.delivery_exceptions`);
ok("a manager reads all", r.ok && r.rows.length === all);
r = await as("authenticated", A, `select id from public.delivery_exceptions`);
ok("an admin reads all", r.ok && r.rows.length === all);
r = await as("authenticated", C, `select id from public.delivery_exceptions`);
ok("a customer reads none", r.ok && r.rows.length === 0);
ok("anon cannot read", denied(await as("anon", null, `select id from public.delivery_exceptions`)));
ok("a rider cannot insert", denied(await as("authenticated", D1, `insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason)
  values ('${await did(O(38))}','${O(38)}','${D1}','other_issue','x')`)));
ok("a rider cannot update (approve their own)", denied(await as("authenticated", D1, `update public.delivery_exceptions set status = 'approved'`)));
ok("a manager cannot update with their JWT", denied(await as("authenticated", M, `update public.delivery_exceptions set status = 'approved'`)));
ok("an admin cannot delete with their JWT", denied(await as("authenticated", A, `delete from public.delivery_exceptions`)));
ok("the service role inserts", (await as("service_role", null, `insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, lat, lng, photo_path, notes)
  values ('${await did(O(38))}','${O(38)}','${D2}','other_issue','x', 21.7, 81.5, 'p/x.jpg', 'n') returning id`)).ok);
ok("the service role decides", (await as("service_role", null, `update public.delivery_exceptions set status = 'acknowledged', decided_by = '${M}', decided_at = now(), decision_note = 'ok'
  where order_id = '${O(38)}' and kind = 'other_issue'`)).ok);

console.log("\n── delivery_events: contact_attempt ──");
const d38 = await did(O(38));
const contact = (m) => run(`insert into public.delivery_events (delivery_id, order_id, driver_id, kind, method)
  values ('${d38}','${O(38)}','${D2}','contact_attempt',${m === null ? "null" : `'${m}'`})`);
ok("contact_attempt (customer) inserts", (await contact("customer")).ok);
ok("contact_attempt (vendor) inserts", (await contact("vendor")).ok);
ok("contact_attempt with another method is refused", checkFails(await contact("pigeon")));
ok("contact_attempt without a method is refused", checkFails(await contact(null)));
ok("an unknown event kind is still refused", checkFails(await run(`insert into public.delivery_events (delivery_id, order_id, kind)
  values (gen_random_uuid(), '${O(38)}', 'teleported')`)));
ok("exactly one kind constraint, by its 0081 name",
  (await count(`select 1 from pg_constraint where conrelid = 'public.delivery_events'::regclass and conname = 'delivery_events_kind_check'`)) === 1);
ok("a rider still cannot insert events", denied(await as("authenticated", D2, `insert into public.delivery_events (delivery_id, order_id, kind, method)
  values (gen_random_uuid(), '${O(38)}', 'contact_attempt', 'customer')`)));

console.log("\n── deliveries.pod_photo_path ──");
ok("the service role writes pod_photo_path", (await as("service_role", null, `update public.deliveries set pod_photo_path = '${O(38)}/pod.jpg' where order_id = '${O(38)}'`)).ok);
ok("...it reads back", (await delivery(O(38))).pod_photo_path === `${O(38)}/pod.jpg`);

console.log("\n── deliveries.distance_source ──");
ok("distance_source starts null", (await delivery(O(38))).distance_source === null);
ok("'estimate' is accepted", (await as("service_role", null, `update public.deliveries set distance_km = 3.4, distance_source = 'estimate' where order_id = '${O(38)}'`)).ok);
ok("'road' is accepted", (await as("service_role", null, `update public.deliveries set distance_km = 3.1, distance_source = 'road' where order_id = '${O(38)}'`)).ok);
ok("...and reads back", (await delivery(O(38))).distance_source === "road");
ok("any other source is refused", checkFails(await run(`update public.deliveries set distance_source = 'guess' where order_id = '${O(38)}'`)));
await as("authenticated", D2, `update public.deliveries set distance_source = 'estimate' where order_id = '${O(38)}'`);
ok("a rider's own JWT does not change it", (await delivery(O(38))).distance_source === "road");

console.log("\n── orders.delivery_instructions ──");
ok("300 characters are accepted", (await run(`update public.orders set delivery_instructions = repeat('a', 300) where id = '${O(40)}'`)).ok);
ok("301 characters are refused", checkFails(await run(`update public.orders set delivery_instructions = repeat('a', 301) where id = '${O(40)}'`)));
r = await as("authenticated", C, `select delivery_instructions from public.orders where id = '${O(40)}'`);
ok("granted to authenticated: the customer reads it on their order", r.ok && r.rows[0]?.delivery_instructions?.length === 300);
ok("the handover codes stay unreadable", denied(await as("authenticated", C, `select pickup_otp from public.orders`)));
r = await as("authenticated", V, `update public.orders set delivery_instructions = 'ring twice' where id = '${O(40)}'`);
ok("a vendor (owns_restaurant) updating it raises via guard_order_update", !r.ok && /delivery_instructions/.test(r.msg));
ok("...the vendor can still move status", (await as("authenticated", V, `update public.orders set status = 'kitchen' where id = '${O(40)}'`)).ok);
r = await as("authenticated", V, `update public.orders set pickup_otp = '9999' where id = '${O(40)}'`);
ok("...0055's locked columns stay locked (pickup_otp)", !r.ok && /pickup_otp/.test(r.msg));
r = await as("authenticated", V, `update public.orders set customer_id = '${V}' where id = '${O(40)}'`);
ok("...and customer_id", !r.ok && /customer_id/.test(r.msg));
ok("the service role writes it", (await as("service_role", null, `update public.orders set delivery_instructions = 'Gate 2' where id = '${O(40)}'`)).ok);
ok("an admin JWT writes it", (await as("authenticated", A, `update public.orders set delivery_instructions = 'Gate 3' where id = '${O(40)}'`)).ok);

console.log("\n── platform_settings: dispatch and proof settings ──");
const s = await one(`select rider_offer_window_seconds, pod_photo_rule, unreachable_wait_minutes, routing_base_url from public.platform_settings`);
ok("defaults: 180 s, never, 10 min, OSRM", s.rider_offer_window_seconds === 180 && s.pod_photo_rule === "never"
  && s.unreachable_wait_minutes === 10 && s.routing_base_url === "https://router.project-osrm.org");
const set = (col, v) => run(`update public.platform_settings set ${col} = ${v}`);
ok("offer window 59 refused", checkFails(await set("rider_offer_window_seconds", 59)));
ok("offer window 601 refused", checkFails(await set("rider_offer_window_seconds", 601)));
ok("offer window 60 and 600 accepted", (await set("rider_offer_window_seconds", 60)).ok && (await set("rider_offer_window_seconds", 600)).ok);
ok("offer window null refused", !(await set("rider_offer_window_seconds", "null")).ok);
ok("unreachable wait 2 refused", checkFails(await set("unreachable_wait_minutes", 2)));
ok("unreachable wait 31 refused", checkFails(await set("unreachable_wait_minutes", 31)));
ok("unreachable wait 3 and 30 accepted", (await set("unreachable_wait_minutes", 3)).ok && (await set("unreachable_wait_minutes", 30)).ok);
let rulesOk = true;
for (const v of ["never", "cod", "always", "exceptions"]) rulesOk &&= (await set("pod_photo_rule", `'${v}'`)).ok;
ok("pod_photo_rule accepts never, cod, always, exceptions", rulesOk);
ok("pod_photo_rule refuses anything else", checkFails(await set("pod_photo_rule", "'sometimes'")));
ok("routing_base_url accepts https", (await set("routing_base_url", "'https://osrm.deligro.in'")).ok);
ok("routing_base_url refuses http", checkFails(await set("routing_base_url", "'http://osrm.deligro.in'")));
ok("routing_base_url refuses empty", checkFails(await set("routing_base_url", "''")));
r = await as("anon", null, `select rider_offer_window_seconds, pod_photo_rule, unreachable_wait_minutes, routing_base_url from public.platform_settings`);
ok("the four columns are readable by anon", r.ok && r.rows.length === 1);
r = await as("authenticated", D1, `select rider_offer_window_seconds, pod_photo_rule, unreachable_wait_minutes, routing_base_url from public.platform_settings`);
ok("...and by authenticated (the settings facade reads with the user's JWT)", r.ok && r.rows.length === 1);
ok("vendor_commission_pct stays private", denied(await as("anon", null, `select vendor_commission_pct from public.platform_settings`)));

console.log("\n── storage bucket delivery-proofs ──");
const b = await one(`select * from storage.buckets where id = 'delivery-proofs'`);
ok("the bucket row exists", !!b && b.name === "delivery-proofs");
ok("...and is not public", b?.public === false);
ok("...5 MB limit", Number(b?.file_size_limit) === 5242880);
ok("...JPEG and PNG only", same([...(b?.allowed_mime_types ?? [])].sort(), ["image/jpeg", "image/png"]));
ok("no storage.objects policy mentions delivery-proofs (service role only)",
  (await count(`select 1 from pg_policies where schemaname = 'storage' and (coalesce(qual, '') || coalesce(with_check, '')) like '%delivery-proofs%'`)) === 0);
await db.exec(`update storage.buckets set public = true where id = 'delivery-proofs'`);

console.log("\n── a new delivery starts unassigned or assigned (BEFORE INSERT guard) ──");
const ins = (o, cols, vals) => run(`insert into public.deliveries (order_id, ${cols}) values ('${o}', ${vals})`);
for (const st of ["picked_up", "delivered", "failed", "cancelled"]) {
  r = await ins(O(51), "driver_id, status, failure_reason", `'${D1}', '${st}', 'x'`);
  ok(`inserting a ${st} delivery is refused`, refused(r) && /unassigned or assigned/.test(r.detail ?? ""));
}
for (const [col, v] of [["picked_up_at", "now()"], ["delivered_at", "now()"], ["failed_at", "now()"], ["pickup_method", "'code'"], ["delivery_method", "'code'"]]) {
  ok(`inserting an assigned delivery carrying ${col} is refused`,
    refused(await ins(O(51), `driver_id, status, ${col}`, `'${D1}', 'assigned', ${v}`)));
}
ok("inserting an assigned delivery without a rider is refused",
  refused(await ins(O(51), "status", "'assigned'")));
ok("...nothing was inserted by any of those", (await count(`select 1 from public.deliveries where order_id = '${O(51)}'`)) === 0);
ok("an unassigned insert (dispatch's offer row) works", (await ins(O(51), "offered_driver_id, offered_at", `'${D2}', now()`)).ok);
ok("an assigned insert with a rider works", (await ins(O(52), "driver_id, status, assigned_at", `'${D1}', 'assigned', now()`)).ok);
r = await ins(O(53), "driver_id, status, picked_up_at, delivered_at, delivery_method, correction_reason",
  `'${D1}', 'delivered', now(), now(), 'staff', 'imported:legacy'`);
ok("a correction insert (correction_reason set) may carry the stamps", r.ok && (await delivery(O(53))).status === "delivered");
r = await as("authenticated", M, `insert into public.deliveries (order_id, driver_id, status, picked_up_at) values ('${O(54)}','${D1}','assigned', now())`);
ok("...the guard applies to a manager's own JWT too", refused(r));
r = await as("service_role", null, `insert into public.deliveries (order_id, driver_id, status) values ('${O(54)}','${D1}','picked_up')`);
ok("...and to the service role (no role is exempt)", refused(r));

console.log("\n── assigned_at is the database's clock (the approval comparison needs one clock) ──");
await db.exec(`insert into public.deliveries (order_id, driver_id, status, assigned_at) values ('${O(55)}','${D1}','assigned', '2020-01-01')`);
d = await delivery(O(55));
ok("an assigned insert's assigned_at is stamped now(), not what the writer sent", new Date(d.assigned_at).getFullYear() > 2020);
await db.exec(`insert into public.deliveries (order_id, offered_driver_id, offered_at) values ('${O(56)}','${D1}',now())`);
await db.exec(`update public.deliveries set status = 'assigned', driver_id = '${D1}', assigned_at = '2020-01-01' where order_id = '${O(56)}'`);
ok("taking an unassigned row stamps assigned_at now() too", new Date((await delivery(O(56))).assigned_at).getFullYear() > 2020);
const before56 = String((await delivery(O(56))).assigned_at);
await db.exec(`update public.deliveries set driver_lat = 21.7, driver_lng = 81.5 where order_id = '${O(56)}'`);
ok("a write that keeps the rider leaves assigned_at alone", String((await delivery(O(56))).assigned_at) === before56);
ok("a correction may set assigned_at explicitly",
  (await run(`update public.deliveries set assigned_at = '2020-01-01', correction_reason = 'backfill' where order_id = '${O(56)}'`)).ok
  && new Date((await delivery(O(56))).assigned_at).getFullYear() === 2020);

console.log("\n── an approval counts only for the current assignment (created_at >= assigned_at) ──");
await pickedUp(O(57), D1);
d = await delivery(O(57));
await db.exec(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status, decided_at, created_at)
  values ('${d.id}','${O(57)}','${D1}','failed_delivery','old','approved', now(), timestamptz '${new Date(d.assigned_at).toISOString()}' - interval '1 minute')`);
r = await fail(O(57));
ok("an approval raised before the current assignment is refused", refused(r) && /approved/.test(r.detail ?? ""));
await exception(O(57), "customer_unreachable", "approved");
ok("...one raised during it works", (await fail(O(57))).ok);
// The same rider released and given the job again: their old approval is from the earlier stint.
await assigned(O(58), D1);
const x58 = await exception(O(58), "manual_pickup", "approved");
ok("released as a correction", (await run(`update public.deliveries set driver_id = null, status = 'unassigned', correction_reason = 'released:go_offline:${x58}' where order_id = '${O(58)}'`)).ok);
ok("...and taken again by the same rider", (await run(`update public.deliveries set status = 'assigned', driver_id = '${D1}', assigned_at = now() where order_id = '${O(58)}'`)).ok);
ok("...the earlier approval no longer unlocks a manual pickup", refused(await manualPickup(O(58))));
await exception(O(58), "manual_pickup", "approved");
ok("...a fresh approval does", (await manualPickup(O(58))).ok);
await pickedUp(O(59), D1);
d = await delivery(O(59));
await db.exec(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status, decided_at, created_at)
  values ('${d.id}','${O(59)}','${D1}','complete_without_code','old','approved', now(), timestamptz '${new Date(d.assigned_at).toISOString()}' - interval '1 second')`);
ok("ops_approved with only an earlier-assignment approval is refused", refused(await opsDeliver(O(59))));

console.log("\n── a release also clears the offer ──");
await db.exec(`insert into public.deliveries (order_id, offered_driver_id, offered_at) values ('${O(60)}','${D1}',now())`);
await db.exec(`update public.deliveries set status = 'assigned', driver_id = '${D1}' where order_id = '${O(60)}'`);
ok("the taken row still carries its offer", (await delivery(O(60))).offered_driver_id === D1);
ok("release", (await run(`update public.deliveries set driver_id = null, status = 'unassigned', correction_reason = 'released:go_offline:60' where order_id = '${O(60)}'`)).ok);
d = await delivery(O(60));
ok("...offered_driver_id and offered_at are cleared", d.offered_driver_id === null && d.offered_at === null);
ok("...and no new offered event is written", (await kinds(O(60))).filter((k) => k === "offered").length === 1);
ok("a release that sends an offer explicitly still lands with none",
  (await run(`update public.deliveries set status = 'assigned', driver_id = '${D2}' where order_id = '${O(60)}'`)).ok
  && (await run(`update public.deliveries set driver_id = null, status = 'unassigned', offered_driver_id = '${D2}', offered_at = now(), correction_reason = 'released:go_offline:60b' where order_id = '${O(60)}'`)).ok
  && (await delivery(O(60))).offered_driver_id === null);

console.log("\n── a decided exception is final ──");
await assigned(O(61), D1);
const dx = await exception(O(61), "wrong_address");
ok("a pending exception cannot be approved without decided_at (CHECK)",
  checkFails(await run(`update public.delivery_exceptions set status = 'approved' where id = '${dx}'`)));
ok("...nor inserted decided without one",
  checkFails(await run(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status)
    values ('${await did(O(61))}','${O(61)}','${D1}','failed_delivery','x','rejected')`)));
ok("pending -> approved with decided_at works",
  (await run(`update public.delivery_exceptions set status = 'approved', decided_at = now(), decided_by = '${M}', decision_note = 'ok' where id = '${dx}'`)).ok);
r = await run(`update public.delivery_exceptions set status = 'rejected' where id = '${dx}'`);
ok("approved -> rejected is refused", checkFails(r) && /decided/.test(r.msg));
ok("approved -> pending is refused", checkFails(await run(`update public.delivery_exceptions set status = 'pending', decided_at = null where id = '${dx}'`)));
ok("the decider cannot be rewritten", checkFails(await run(`update public.delivery_exceptions set decided_by = '${A}' where id = '${dx}'`)));
ok("nor the decision time", checkFails(await run(`update public.delivery_exceptions set decided_at = now() + interval '1 hour' where id = '${dx}'`)));
ok("nor the note", checkFails(await run(`update public.delivery_exceptions set decision_note = 'changed' where id = '${dx}'`)));
ok("the service role is held to it too",
  checkFails(await as("service_role", null, `update public.delivery_exceptions set status = 'rejected' where id = '${dx}'`)));
const ack = await exception(O(61), "vendor_delay");
await db.exec(`update public.delivery_exceptions set status = 'acknowledged', decided_at = now() where id = '${ack}'`);
ok("an acknowledged report is final too", checkFails(await run(`update public.delivery_exceptions set status = 'pending', decided_at = null where id = '${ack}'`)));
const px = await exception(O(61), "customer_unreachable");
ok("a pending exception cannot move to another rider, kind or time",
  checkFails(await run(`update public.delivery_exceptions set kind = 'failed_delivery' where id = '${px}'`))
  && checkFails(await run(`update public.delivery_exceptions set driver_id = '${D2}' where id = '${px}'`))
  && checkFails(await run(`update public.delivery_exceptions set created_at = now() - interval '1 day' where id = '${px}'`)));
ok("...its notes may still be written while pending", (await run(`update public.delivery_exceptions set notes = 'later' where id = '${px}'`)).ok);
r = await run(`update public.delivery_exceptions set status = 'rejected', decided_at = now() where id = '${dx}' and status = 'pending' returning id`);
ok("the decision update guarded on pending matches nothing once decided", r.ok && r.rows.length === 0);

console.log("\n── proof photo retention (P8-R4) ──");
const retentionIdx = (await db.query(`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'deliveries'
  and indexname in ('deliveries_pod_photo_delivered_idx','deliveries_pod_photo_failed_idx','deliveries_pod_photo_picked_up_idx')`)).rows;
ok("pod_photo_removed_at exists", (await count(`select 1 from information_schema.columns where table_name = 'deliveries' and column_name = 'pod_photo_removed_at'`)) === 1);
ok("three partial retention indexes, each on its stamp where a photo is held",
  retentionIdx.length === 3 && retentionIdx.every((i) => /WHERE \(pod_photo_path IS NOT NULL\)/i.test(i.indexdef)));

console.log("\n── idempotent ──");
const before = await count(`select 1 from public.delivery_exceptions`);
let again = true; try { await db.exec(M0082); } catch (e) { again = false; console.log(e.message); }
ok("0082 can be applied twice", again);
ok("...the exceptions survive", (await count(`select 1 from public.delivery_exceptions`)) === before);
ok("...the bucket is private again (a re-run corrects drift)", (await one(`select public from storage.buckets where id = 'delivery-proofs'`)).public === false);
ok("...one decided check, one exception-update trigger and one insert guard",
  (await count(`select 1 from pg_constraint where conname = 'delivery_exceptions_decided_check'`)) === 1
  && (await count(`select 1 from pg_trigger where tgname = 'guard_delivery_exception_update'`)) === 1
  && (await count(`select 1 from pg_trigger where tgname = 'guard_delivery_insert'`)) === 1);
ok("...settings keep their values", (await one(`select unreachable_wait_minutes as n from public.platform_settings`)).n === 30);

console.log("\n── 0081's rules, re-run against 0082's re-declared functions ──");
await db.exec(`insert into public.deliveries (order_id) values ('${O(1)}')`);
ok("unassigned -> assigned", (await run(`update public.deliveries set status = 'assigned', driver_id = '${D1}', assigned_at = now() where order_id = '${O(1)}'`)).ok);
ok("assigned -> picked_up (no stamp sent)", (await run(`update public.deliveries set status = 'picked_up', pickup_method = 'code' where order_id = '${O(1)}'`)).ok);
ok("picked_up -> delivered (no stamp sent)", (await run(`update public.deliveries set status = 'delivered', delivery_method = 'code' where order_id = '${O(1)}'`)).ok);
d = await delivery(O(1));
ok("picked_up_at and delivered_at stamped by the guard", d.picked_up_at !== null && d.delivered_at !== null);
ok("events: accepted, picked_up, delivered — in order", same(await kinds(O(1)), ["accepted", "picked_up", "delivered"]));
ok("delivered -> assigned is refused (terminal)", refused(await run(`update public.deliveries set status = 'assigned' where order_id = '${O(1)}'`)));
ok("a non-status write on a delivered row still works (COD record)", (await run(`update public.deliveries set cod_collected_amount = 250, cod_collected_at = now() where order_id = '${O(1)}'`)).ok);

await assigned(O(2));
ok("assigned -> delivered is refused", refused(await run(`update public.deliveries set status = 'delivered' where order_id = '${O(2)}'`)));
ok("...the same with correction_reason succeeds and logs delivered + corrected",
  (await run(`update public.deliveries set status = 'delivered', delivery_method = 'staff', correction_reason = 'staff_marked_delivered' where order_id = '${O(2)}'`)).ok
  && same(await kinds(O(2)), ["accepted", "delivered", "corrected"]));

await assigned(O(3));
ok("first arrived_pickup_at", (await run(`update public.deliveries set arrived_pickup_at = now() where order_id = '${O(3)}'`)).ok);
ok("second arrived_pickup_at is refused", refused(await run(`update public.deliveries set arrived_pickup_at = now() + interval '1 minute' where order_id = '${O(3)}'`)));
ok("clearing it is refused too", refused(await run(`update public.deliveries set arrived_pickup_at = null where order_id = '${O(3)}'`)));
ok("a correction may change it", (await run(`update public.deliveries set arrived_pickup_at = null, correction_reason = 'wrong tap' where order_id = '${O(3)}'`)).ok);
await db.exec(`insert into public.deliveries (order_id) values ('${O(4)}')`);
ok("unassigned -> picked_up is refused", refused(await run(`update public.deliveries set status = 'picked_up', driver_id = '${D1}' where order_id = '${O(4)}'`)));
await pickedUp(O(5));
ok("picked_up -> failed without a reason is refused", refused(await run(`update public.deliveries set status = 'failed' where order_id = '${O(5)}'`)));
await exception(O(5), "customer_unreachable", "approved");
ok("...a blank reason is refused even with an approved exception", refused(await run(`update public.deliveries set status = 'failed', failure_reason = '  ' where order_id = '${O(5)}'`)));
ok("...with a reason and the exception it fails", (await fail(O(5))).ok);
ok("failed -> picked_up is refused (terminal)", refused(await run(`update public.deliveries set status = 'picked_up' where order_id = '${O(5)}'`)));
await db.exec(`insert into public.deliveries (order_id) values ('${O(6)}')`);
await exception(O(6), "failed_delivery", "approved", D1);
ok("failed from unassigned is refused", refused(await run(`update public.deliveries set status = 'failed', failure_reason = 'x', correction_reason = 'ops' where order_id = '${O(6)}'`)));

const X = "aaaaaaaa-0000-0000-0000-000000000001", Y = "aaaaaaaa-0000-0000-0000-000000000002";
await assigned(O(7));
ok("action X: arrived_pickup_at", (await run(`update public.deliveries set arrived_pickup_at = now(), last_action_id = '${X}' where order_id = '${O(7)}'`)).ok);
ok("...its event carries X", (await one(`select client_action_id from public.delivery_events where order_id = '${O(7)}' and kind = 'arrived_pickup'`)).client_action_id === X);
r = await run(`update public.deliveries set departed_pickup_at = now(), last_action_id = '${X}' where order_id = '${O(7)}'`);
ok("replaying X with another stamp raises 23505 and leaves the row unchanged", !r.ok && r.code === "23505" && (await delivery(O(7))).departed_pickup_at === null);
ok("a location ping (id untouched) still works", (await run(`update public.deliveries set driver_lat = 21.7, driver_lng = 81.5 where order_id = '${O(7)}'`)).ok);
ok("action Y: picked_up + departed in one update, Y recorded once",
  (await run(`update public.deliveries set status = 'picked_up', departed_pickup_at = now(), last_action_id = '${Y}' where order_id = '${O(7)}'`)).ok
  && (await count(`select 1 from public.delivery_events where client_action_id = '${Y}'`)) === 1);
r = await run(`update public.deliveries set arrived_drop_at = now(), last_action_id = '${X}' where order_id = '${O(7)}'`);
ok("an older id (X) replayed after Y also raises 23505", !r.ok && r.code === "23505");

await db.exec(`insert into public.deliveries (order_id, offered_driver_id, offered_at) values ('${O(8)}','${D2}',now())`);
ev = await one(`select kind, driver_id from public.delivery_events where order_id = '${O(8)}'`);
ok("an offer logs offered against the offered rider", ev?.kind === "offered" && ev.driver_id === D2);
await assigned(O(9));
r = await as("authenticated", M, `update public.deliveries set status = 'cancelled' where order_id = '${O(9)}'`);
ok("a manager's own-JWT cancel is logged with the manager as actor",
  r.ok && (await one(`select actor_id from public.delivery_events where order_id = '${O(9)}' and kind = 'cancelled'`))?.actor_id === M);
await assigned(O(10));
ok("service_role assigned -> delivered is refused", refused(await as("service_role", null, `update public.deliveries set status = 'delivered' where order_id = '${O(10)}'`)));
ok("pickup_method check rejects an unknown method", !(await run(`update public.deliveries set pickup_method = 'teleport' where order_id = '${O(10)}'`)).ok);
r = await as("authenticated", D1, `select driver_id from public.delivery_events`);
ok("delivery_events: a rider still reads only their own", r.ok && r.rows.length > 0 && r.rows.every((x) => x.driver_id === D1));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
