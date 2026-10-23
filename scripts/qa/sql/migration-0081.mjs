// Runs migration 0081 in an in-process Postgres (PGlite) with stubbed Supabase auth helpers.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0081.mjs
// Proves the trigger, privilege and RLS logic; it does not replace running the migration on staging.
// Also exports seed() and proof() for scripts/qa/sql/rider-migrations-sequence.mjs, which runs these
// assertions on one database holding the real baseline and 0081-0087 (`seq` below).
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0081_rider_app_foundation.sql", import.meta.url), "utf8");

const STUBS = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  -- Supabase's auth.jwt(): the guard's correction rule reads the JWT role (ruling P8-R10).
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  -- Supabase default: every table, sequence and function created later in public
  -- is granted to the API roles. The migration has to take that back itself.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create table public.profiles (id uuid primary key, role text not null, full_name text,
    created_at timestamptz not null default now());
  create table public.orders (id uuid primary key, status text not null default 'ready');
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

  -- 0001/0023: a manager writes deliveries with their own JWT, so the audit
  -- trigger must work for authenticated, not only for the service role.
  alter table public.deliveries enable row level security;
  create policy "deliveries — manager manage" on public.deliveries for all
    using (public.is_admin() or public.current_role() = 'manager')
    with check (public.is_admin() or public.current_role() = 'manager');
  alter table public.profiles enable row level security;
  create policy "profiles — read" on public.profiles for select using (true);
  create policy "profiles — admin update" on public.profiles for update using (public.is_admin()) with check (public.is_admin());

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  -- 0032/0045: platform_settings is readable per column.
  revoke select on public.platform_settings from anon, authenticated;
  grant select (id, business_name) on public.platform_settings to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

// Every id carries a namespace in its fourth group, so the sequence run can hold every proof at once.
const names = (ns) => {
  const id = (n) => `00000000-0000-0000-${ns}-${String(n).padStart(12, "0")}`;
  return { id, D1: id(0xd1), D2: id(0xd2), D3: id(0xd3), M: id(0xe1), A: id(0xa1), C: id(0xc1), C2: id(0xc2), C3: id(0xc3),
           O: (i) => id(0x100 + i), LEGACY: id(0x200) };
};

// The rows that must exist BEFORE 0081 is applied: the drivers its backfill numbers, and a legacy delivery.
export async function seed(db, ns = "0000") {
  const { D1, D2, M, A, C, C2, C3, O, LEGACY } = names(ns);
  // D2 is inserted first but registered later: the backfill must follow created_at, not insertion order.
  await db.exec(`
    insert into public.profiles (id, role, full_name, created_at) values
      ('${D2}','driver','Second rider','2026-02-01'),
      ('${D1}','driver','First rider','2026-01-01'),
      ('${M}','manager','Manager','2026-01-05'),
      ('${A}','admin','Admin','2026-01-06'),
      ('${C}','customer','Customer','2026-01-07'),
      ('${C2}','customer','Becomes a rider','2026-01-08'),
      ('${C3}','customer','Promoted by admin','2026-01-09');
  `);
  for (let i = 1; i <= 12; i++) await db.exec(`insert into public.orders (id) values ('${O(i)}')`);
  // A delivery the ORIGINAL writer left at picked_up with no picked_up_at stamp
  // (it set status only). The migration must backfill it before the guard exists.
  await db.exec(`
    insert into public.orders (id, status) values ('${LEGACY}', 'on_the_way');
    insert into public.deliveries (order_id, driver_id, status, assigned_at)
      values ('${LEGACY}', '${D1}', 'picked_up', '2026-03-01T10:00:00Z');
  `);
}

export async function proof({ db: shared = null, ns = "0000", quiet = false } = {}) {
  // seq: the sequence run passes a database that already holds the baseline, seed() and 0081-0087.
  const seq = shared !== null;
  const db = shared ?? new PGlite();
  if (!seq) {
    await db.exec(STUBS);
    await seed(db, ns);
    await db.exec(MIGRATION);
  }
  const { id, D1, D2, D3, M, A, C, C2, C3, O, LEGACY } = names(ns);

  let passed = 0, failed = 0;
  const ok = (n, c) => { if (c) passed++; else failed++; if (!c || !quiet) console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
  async function run(sql) {
    try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
    catch (e) { return { ok: false, msg: String(e.message), code: e.code, detail: e.detail }; }
  }
  async function as(role, uid, sql) {
    await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false);
      select set_config('test.jwt','{"role":"${role}"}',false);`);
    try { return await run(sql); } finally { await db.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
  }
  const denied = (r) => !r.ok && /permission denied/.test(r.msg);
  const refused = (r) => !r.ok && /invalid_delivery_transition/.test(r.msg) && r.code === "23514";
  const one = async (sql) => (await db.query(sql)).rows[0];
  const code = async (uid) => (await one(`select rider_code from public.rider_profiles where driver_id = '${uid}'`))?.rider_code ?? null;
  const kinds = async (o) => (await db.query(`select kind from public.delivery_events where order_id = '${o}' order by id`)).rows.map((r) => r.kind);
  const delivery = (o) => one(`select * from public.deliveries where order_id = '${o}'`);

  console.log("\n── delivery_status gains 'failed' ──");
  ok("enum has failed", (await one(`select 'failed'::public.delivery_status::text as s`)).s === "failed");

  console.log("\n── rider ID ──");
  ok("first-registered driver is DR-0001", (await code(D1)) === "DR-0001");
  ok("second-registered driver is DR-0002", (await code(D2)) === "DR-0002");
  await db.exec(`insert into public.profiles (id, role, full_name) values ('${D3}','driver','Third rider')`);
  ok("a new driver gets DR-0003", (await code(D3)) === "DR-0003");
  ok("a customer gets no rider_profiles row", (await code(C)) === null);
  await db.exec(`update public.profiles set role = 'driver' where id = '${C2}'`);
  ok("a customer turned driver gets DR-0004", (await code(C2)) === "DR-0004");
  await db.exec(`update public.profiles set role = 'driver', full_name = 'Renamed' where id = '${D1}'`);
  ok("re-saving a driver's role keeps their code", (await code(D1)) === "DR-0001");
  let r = await as("authenticated", A, `update public.profiles set role = 'driver' where id = '${C3}'`);
  ok("an admin promoting with their own JWT creates the row (definer trigger) — next code DR-0005", r.ok && (await code(C3)) === "DR-0005");

  console.log("\n── a legacy picked_up row with no stamp ──");
  let lg = await delivery(LEGACY);
  ok("the migration backfilled picked_up_at from assigned_at", lg.picked_up_at !== null && new Date(lg.picked_up_at).toISOString() === "2026-03-01T10:00:00.000Z");
  ok("the backfill left no audit row (it ran before the triggers)", (await kinds(LEGACY)).length === 0);
  ok("the rider can deliver it: the guard accepts picked_up -> delivered", (await run(`update public.deliveries set status = 'delivered', delivery_method = 'code' where order_id = '${LEGACY}'`)).ok);
  lg = await delivery(LEGACY);
  ok("and it is delivered with delivered_at stamped (not stuck at picked_up)", lg.status === "delivered" && lg.delivered_at !== null);

  console.log("\n── the happy path, audited ──");
  await db.exec(`insert into public.deliveries (order_id) values ('${O(1)}')`);
  ok("unassigned -> assigned", (await run(`update public.deliveries set status = 'assigned', driver_id = '${D1}', assigned_at = now() where order_id = '${O(1)}'`)).ok);
  ok("assigned -> picked_up (no stamp sent)", (await run(`update public.deliveries set status = 'picked_up', pickup_method = 'code' where order_id = '${O(1)}'`)).ok);
  ok("picked_up -> delivered (no stamp sent)", (await run(`update public.deliveries set status = 'delivered', delivery_method = 'code' where order_id = '${O(1)}'`)).ok);
  let d = await delivery(O(1));
  ok("picked_up_at and delivered_at stamped by the guard", d.picked_up_at !== null && d.delivered_at !== null);
  ok("events: accepted, picked_up, delivered — in order", JSON.stringify(await kinds(O(1))) === JSON.stringify(["accepted", "picked_up", "delivered"]));
  let ev = await one(`select method, driver_id from public.delivery_events where order_id = '${O(1)}' and kind = 'picked_up'`);
  ok("picked_up event carries the method and the rider", ev.method === "code" && ev.driver_id === D1);
  ok("delivered event carries its method", (await one(`select method from public.delivery_events where order_id = '${O(1)}' and kind = 'delivered'`)).method === "code");
  ok("delivered -> assigned is refused (terminal)", refused(await run(`update public.deliveries set status = 'assigned' where order_id = '${O(1)}'`)));
  ok("a non-status write on a delivered row still works (COD record)", (await run(`update public.deliveries set cod_collected_amount = 250, cod_collected_at = now() where order_id = '${O(1)}'`)).ok);

  console.log("\n── delivered needs a pickup, unless it is a correction ──");
  await db.exec(`insert into public.deliveries (order_id, driver_id, status, assigned_at) values ('${O(2)}','${D1}','assigned',now())`);
  ok("insert straight to assigned logs accepted", JSON.stringify(await kinds(O(2))) === JSON.stringify(["accepted"]));
  ok("assigned -> delivered is refused", refused(await run(`update public.deliveries set status = 'delivered' where order_id = '${O(2)}'`)));
  ok("...the same with correction_reason succeeds",
    (await run(`update public.deliveries set status = 'delivered', delivery_method = 'staff', correction_reason = 'staff_marked_delivered' where order_id = '${O(2)}'`)).ok);
  ok("...and logs delivered + corrected", JSON.stringify(await kinds(O(2))) === JSON.stringify(["accepted", "delivered", "corrected"]));
  ev = await one(`select reason from public.delivery_events where order_id = '${O(2)}' and kind = 'corrected'`);
  ok("corrected event carries the reason", ev.reason === "staff_marked_delivered");
  ok("...and delivered_at was stamped", (await delivery(O(2))).delivered_at !== null);

  console.log("\n── stamps are set once ──");
  await db.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${O(3)}','${D1}','assigned')`);
  ok("first arrived_pickup_at", (await run(`update public.deliveries set arrived_pickup_at = now() where order_id = '${O(3)}'`)).ok);
  ok("second arrived_pickup_at is refused", refused(await run(`update public.deliveries set arrived_pickup_at = now() + interval '1 minute' where order_id = '${O(3)}'`)));
  ok("re-sending the same value is not a change", (await run(`update public.deliveries set arrived_pickup_at = arrived_pickup_at where order_id = '${O(3)}'`)).ok);
  ok("clearing it is refused too", refused(await run(`update public.deliveries set arrived_pickup_at = null where order_id = '${O(3)}'`)));
  ok("arrived_pickup logged once", (await kinds(O(3))).filter((k) => k === "arrived_pickup").length === 1);
  await db.exec(`insert into public.deliveries (order_id) values ('${O(12)}')`);
  ok("unassigned -> picked_up is refused", refused(await run(`update public.deliveries set status = 'picked_up', driver_id = '${D1}' where order_id = '${O(12)}'`)));

  console.log("\n── failed needs a reason ──");
  await db.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${O(4)}','${D2}','assigned');
                 update public.deliveries set status = 'picked_up' where order_id = '${O(4)}';`);
  ok("picked_up -> failed without a reason is refused", refused(await run(`update public.deliveries set status = 'failed' where order_id = '${O(4)}'`)));
  ok("...a blank reason is refused", refused(await run(`update public.deliveries set status = 'failed', failure_reason = '  ' where order_id = '${O(4)}'`)));
  ok("...a correction does not skip it", refused(await run(`update public.deliveries set status = 'failed', correction_reason = 'ops' where order_id = '${O(4)}'`)));
  if (seq) {
    // 0082 (rule 7): a non-correction failure also needs an approved exception from the delivery's rider.
    await db.exec(`insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status, decided_at)
      select id, order_id, driver_id, 'customer_unreachable', 'seq', 'approved', now() from public.deliveries where order_id = '${O(4)}'`);
  }
  ok("picked_up -> failed with a reason", (await run(`update public.deliveries set status = 'failed', failure_reason = 'customer_unreachable' where order_id = '${O(4)}'`)).ok);
  d = await delivery(O(4));
  ok("failed_at stamped", d.failed_at !== null);
  ev = await one(`select reason, driver_id from public.delivery_events where order_id = '${O(4)}' and kind = 'failed'`);
  ok("failed event carries the reason and rider", ev?.reason === "customer_unreachable" && ev.driver_id === D2);
  ok("failed -> picked_up is refused (terminal)", refused(await run(`update public.deliveries set status = 'picked_up' where order_id = '${O(4)}'`)));
  await db.exec(`insert into public.deliveries (order_id) values ('${O(11)}')`);
  ok("failed from unassigned is refused", refused(await run(`update public.deliveries set status = 'failed', failure_reason = 'x' where order_id = '${O(11)}'`)));

  console.log("\n── a replayed action id fails the whole update ──");
  const X = `aaaaaaaa-0000-0000-${ns}-000000000001`, Y = `aaaaaaaa-0000-0000-${ns}-000000000002`;
  await db.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${O(5)}','${D1}','assigned')`);
  ok("action X: arrived_pickup_at", (await run(`update public.deliveries set arrived_pickup_at = now(), last_action_id = '${X}' where order_id = '${O(5)}'`)).ok);
  ok("...its event carries X", (await one(`select client_action_id from public.delivery_events where order_id = '${O(5)}' and kind = 'arrived_pickup'`)).client_action_id === X);
  r = await run(`update public.deliveries set departed_pickup_at = now(), last_action_id = '${X}' where order_id = '${O(5)}'`);
  ok("replaying X with another stamp raises 23505", !r.ok && r.code === "23505");
  d = await delivery(O(5));
  ok("...and leaves the row unchanged", d.departed_pickup_at === null && (await kinds(O(5))).length === 2);
  ok("a write that does not touch the id (location ping) still works", (await run(`update public.deliveries set driver_lat = 21.7, driver_lng = 81.5 where order_id = '${O(5)}'`)).ok);
  ok("a later event without a new id is not mistaken for a replay",
    (await run(`update public.deliveries set correction_reason = 'ops_note' where order_id = '${O(5)}'`)).ok);
  ok("action Y: two events in one update (picked_up + departed) both logged",
    (await run(`update public.deliveries set status = 'picked_up', departed_pickup_at = now(), last_action_id = '${Y}' where order_id = '${O(5)}'`)).ok
    && (await kinds(O(5))).includes("departed") && (await kinds(O(5))).includes("picked_up"));
  ok("...Y is recorded exactly once", Number((await one(`select count(*)::int as n from public.delivery_events where client_action_id = '${Y}'`)).n) === 1);
  r = await run(`update public.deliveries set arrived_drop_at = now(), last_action_id = '${X}' where order_id = '${O(5)}'`);
  ok("an older id (X) replayed after Y also raises 23505", !r.ok && r.code === "23505");

  console.log("\n── reassignment, offers, cancellation ──");
  await db.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${O(6)}','${D1}','assigned')`);
  ok("driver A -> B", (await run(`update public.deliveries set driver_id = '${D2}' where order_id = '${O(6)}'`)).ok);
  ok("...writes reassigned", (await kinds(O(6))).includes("reassigned"));
  await db.exec(`insert into public.deliveries (order_id, offered_driver_id, offered_at) values ('${O(7)}','${D2}',now())`);
  ev = await one(`select kind, driver_id from public.delivery_events where order_id = '${O(7)}'`);
  ok("an offer logs offered against the offered rider", ev?.kind === "offered" && ev.driver_id === D2);
  ok("re-offer to another rider logs a second offered",
    (await run(`update public.deliveries set offered_driver_id = '${D1}', offered_at = now() where order_id = '${O(7)}'`)).ok
    && (await kinds(O(7))).filter((k) => k === "offered").length === 2);
  ok("a refreshed offered_at for the same rider logs nothing new",
    (await run(`update public.deliveries set offered_at = now() where order_id = '${O(7)}'`)).ok
    && (await kinds(O(7))).length === 2);
  await db.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${O(8)}','${D1}','assigned')`);
  r = await as("authenticated", M, `update public.deliveries set status = 'cancelled' where order_id = '${O(8)}'`);
  ok("a manager's own-JWT cancel works and is logged (definer trigger)", r.ok && (await kinds(O(8))).includes("cancelled"));
  ev = await one(`select actor_id from public.delivery_events where order_id = '${O(8)}' and kind = 'cancelled'`);
  ok("...with the manager as actor", ev.actor_id === M);
  ok("cancelled -> assigned is refused", refused(await run(`update public.deliveries set status = 'assigned' where order_id = '${O(8)}'`)));

  console.log("\n── the guard applies to the service role too ──");
  await db.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${O(9)}','${D1}','assigned')`);
  ok("service_role assigned -> delivered is refused", refused(await as("service_role", null, `update public.deliveries set status = 'delivered' where order_id = '${O(9)}'`)));
  ok("service_role correction succeeds", (await as("service_role", null, `update public.deliveries set status = 'delivered', delivery_method = 'staff', correction_reason = 'staff_marked_delivered' where order_id = '${O(9)}'`)).ok);

  console.log("\n── P8-R10: who may make a correction ──");
  await db.exec(`insert into public.orders (id) values ('${O(14)}'), ('${O(15)}');
                 insert into public.deliveries (order_id, driver_id, status) values ('${O(14)}','${D1}','assigned'), ('${O(15)}','${D1}','assigned')`);
  r = await as("authenticated", M, `update public.deliveries set status = 'delivered', delivery_method = 'staff', correction_reason = 'manager says' where order_id = '${O(14)}'`);
  ok("a manager's own JWT cannot make a correction (assigned -> delivered, never picked up)",
    refused(r) && /correction/.test(r.detail ?? "") && (await delivery(O(14))).status === "assigned");
  r = await as("authenticated", D1, `update public.deliveries set correction_reason = 'mine' where order_id = '${O(14)}'`);
  ok("...nor can a rider's (no write path, and the guard would refuse it)",
    (refused(r) || denied(r) || r.ok) && (await delivery(O(14))).correction_reason === null);
  ok("an admin's own JWT may", (await as("authenticated", A, `update public.deliveries set status = 'delivered', delivery_method = 'staff', correction_reason = 'admin override' where order_id = '${O(14)}'`)).ok);
  ok("...the migration owner (SECURITY DEFINER ops functions) may",
    (await run(`update public.deliveries set status = 'delivered', delivery_method = 'staff', correction_reason = 'owner' where order_id = '${O(15)}'`)).ok);
  ok("pickup_method check rejects an unknown method", !(await run(`update public.deliveries set pickup_method = 'teleport' where order_id = '${O(9)}'`)).ok);
  ok("delivery_method check rejects an unknown method", !(await run(`update public.deliveries set delivery_method = 'teleport' where order_id = '${O(9)}'`)).ok);

  console.log("\n── rider_status / rider_shifts / rider_profiles / delivery_events RLS ──");
  await db.exec(`insert into public.rider_status (driver_id, is_online) values ('${D1}', true), ('${D2}', false);
                 insert into public.rider_shifts (driver_id, started_at) values ('${D1}', now() - interval '1 hour');`);
  await db.exec(`insert into public.rider_shifts (driver_id, started_at, ended_at, ended_by) values ('${D2}', now() - interval '2 hours', now() - interval '1 hour', 'rider')`);
  for (const table of ["rider_status", "rider_shifts", "rider_profiles", "delivery_events"]) {
    const all = Number((await one(`select count(*)::int as n from public.${table}`)).n);
    const mine = Number((await one(`select count(*)::int as n from public.${table} where driver_id = '${D1}'`)).n);
    r = await as("authenticated", D1, `select driver_id from public.${table}`);
    ok(`${table}: driver 1 sees only own rows (${mine} of ${all})`, r.ok && mine > 0 && r.rows.length === mine && r.rows.every((x) => x.driver_id === D1));
    r = await as("authenticated", M, `select driver_id from public.${table}`);
    ok(`${table}: manager sees all rows`, r.ok && r.rows.length === all);
    r = await as("authenticated", A, `select driver_id from public.${table}`);
    ok(`${table}: admin sees all rows`, r.ok && r.rows.length === all);
    r = await as("authenticated", C, `select driver_id from public.${table}`);
    ok(`${table}: customer sees none`, r.ok && r.rows.length === 0);
    ok(`${table}: anon cannot read`, denied(await as("anon", null, `select driver_id from public.${table}`)));
    ok(`${table}: driver cannot update`, denied(await as("authenticated", D1, `update public.${table} set driver_id = driver_id`)));
    ok(`${table}: driver cannot delete`, denied(await as("authenticated", D1, `delete from public.${table}`)));
    ok(`${table}: manager cannot delete`, denied(await as("authenticated", M, `delete from public.${table}`)));
    ok(`${table}: service_role reads all`, (await as("service_role", null, `select driver_id from public.${table}`)).rows?.length === all);
  }
  ok("insert into rider_status is denied for driver", denied(await as("authenticated", D1, `insert into public.rider_status (driver_id, is_online) values ('${D1}', true)`)));
  ok("insert into delivery_events is denied for driver", denied(await as("authenticated", D1, `insert into public.delivery_events (delivery_id, order_id, kind) values (gen_random_uuid(), '${O(1)}', 'delivered')`)));
  ok("insert into rider_profiles is denied for admin JWT", denied(await as("authenticated", A, `insert into public.rider_profiles (driver_id) values ('${C}')`)));
  ok("service_role upserts rider_status", (await as("service_role", null, `insert into public.rider_status (driver_id, is_online, last_lat, last_lng, last_fix_at) values ('${D3}', true, 21.7, 81.5, now()) on conflict (driver_id) do update set is_online = excluded.is_online`)).ok);
  ok("service_role inserts a rider_profiles row (sequence usage)", (await as("service_role", null, `insert into public.rider_profiles (driver_id) values ('${C}') returning rider_code`)).rows?.[0]?.rider_code === "DR-0006");

  console.log("\n── one open shift per rider ──");
  r = await run(`insert into public.rider_shifts (driver_id, started_at) values ('${D1}', now())`);
  ok("a second open shift raises", !r.ok && r.code === "23505");
  ok("closing it, then opening a new one works",
    (await run(`update public.rider_shifts set ended_at = now(), ended_by = 'logout' where driver_id = '${D1}' and ended_at is null`)).ok
    && (await run(`insert into public.rider_shifts (driver_id, started_at) values ('${D1}', now())`)).ok);
  ok("ended_by check rejects an unknown value", !(await run(`update public.rider_shifts set ended_at = now(), ended_by = 'aliens' where driver_id = '${D1}' and ended_at is null`)).ok);

  console.log("\n── platform_settings: privacy and terms links ──");
  r = await as("anon", null, `select privacy_policy_url, terms_url from public.platform_settings`);
  ok("both columns default to '' and are publicly readable", r.ok && r.rows[0].privacy_policy_url === "" && r.rows[0].terms_url === "");
  ok("vendor_commission_pct stays private", denied(await as("anon", null, `select vendor_commission_pct from public.platform_settings`)));
  ok("an https link is accepted", (await run(`update public.platform_settings set privacy_policy_url = 'https://deligro.in/privacy'`)).ok);
  ok("an http link is refused", !(await run(`update public.platform_settings set terms_url = 'http://deligro.in/terms'`)).ok);

  // The sequence run re-applies 0081-0087 together on its populated database instead.
  if (!seq) {
    console.log("\n── idempotent ──");
    // A picked_up row without the stamp after the first run (a correction import): a re-run leaves it alone.
    await db.exec(`insert into public.orders (id, status) values ('${O(13)}', 'on_the_way');
      insert into public.deliveries (order_id, driver_id, status, correction_reason) values ('${O(13)}', '${D2}', 'picked_up', 'imported')`);
    let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
    ok("migration can be applied twice", again);
    ok("...without re-numbering or burning codes", (await code(D1)) === "DR-0001"
      && (await run(`insert into public.profiles (id, role) values ('${id(0xd9)}','driver')`)).ok && (await code(id(0xd9))) === "DR-0007");
    ok("...and the events survive", (await kinds(O(1))).length === 3);
    ok("...and the one-off picked_up_at backfill does not run again", (await delivery(O(13))).picked_up_at === null);
  }

  return { passed, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { passed, failed } = await proof();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
