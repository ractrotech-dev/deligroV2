// Runs the migration in an in-process Postgres (PGlite) with stubbed Supabase roles.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0057.mjs
// Proves the DDL, the retention function and the grants; it does not replace running the migration on staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0057_indexes_and_housekeeping.sql", import.meta.url), "utf8");
const db = new PGlite();

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create type order_status as enum ('placed','kitchen','ready','on_the_way','delivered','cancelled');
  create type delivery_status as enum ('unassigned','assigned','picked_up','delivered','cancelled');
  create type user_role as enum ('customer','restaurant','driver','admin');
  create table public.orders (id uuid primary key default gen_random_uuid(), customer_id uuid, restaurant_id uuid, status order_status not null default 'placed', created_at timestamptz not null default now());
  create table public.deliveries (id uuid primary key default gen_random_uuid(), order_id uuid, driver_id uuid, status delivery_status not null default 'unassigned', delivered_at timestamptz);
  create table public.profiles (id uuid primary key default gen_random_uuid(), role user_role not null default 'customer', created_at timestamptz not null default now());
  create table public.rate_limits (key text primary key, count int not null default 0, reset_at timestamptz not null);
  create table public.otp_codes (id uuid primary key default gen_random_uuid(), phone text, created_at timestamptz not null default now());
  create table public.banner_events (id bigint generated always as identity primary key, kind text, created_at timestamptz not null default now());
  grant all on all tables in schema public to anon, authenticated, service_role;
`);

await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };

console.log("\n── indexes ──");
const have = new Set((await db.query(`select indexname from pg_indexes where schemaname='public'`)).rows.map((r) => r.indexname));
for (const n of ["orders_active_created_idx", "orders_restaurant_status_created_idx", "orders_created_at_idx", "orders_customer_created_idx",
  "deliveries_driver_delivered_idx", "deliveries_driver_active_idx", "profiles_customer_created_idx", "rate_limits_reset_idx", "otp_codes_created_idx", "banner_events_created_idx"]) {
  ok(`${n} exists`, have.has(n));
}

// Give the planner something to choose between, then ask it for the real query shapes.
await db.exec(`
  insert into public.orders (customer_id, restaurant_id, status, created_at)
    select gen_random_uuid(), ('00000000-0000-0000-0000-0000000000' || lpad((g % 80)::text, 2, '0'))::uuid,
           (array['delivered','delivered','delivered','delivered','ready','placed'])[1 + (g % 6)]::order_status, now() - (g || ' minutes')::interval
    from generate_series(1, 5000) g;
  analyze public.orders;
`);
async function plan(sql) {
  await db.exec("set enable_seqscan = off");
  const r = await db.query("explain " + sql);
  await db.exec("reset enable_seqscan");
  return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
}
console.log("\n── planner uses them ──");
ok("driver board (status = ready order by created_at) uses the partial index",
  /orders_active_created_idx/.test(await plan(`select * from public.orders where status = 'ready' order by created_at limit 20`)));
ok("vendor board (restaurant + status in active) uses the composite index",
  /orders_restaurant_status_created_idx/.test(await plan(`select * from public.orders where restaurant_id = '00000000-0000-0000-0000-000000000001' and status in ('placed','kitchen') order by created_at desc`)));
ok("admin newest-first list uses orders_created_at_idx",
  /orders_created_at_idx/.test(await plan(`select * from public.orders order by created_at desc limit 50`)));
ok("my orders uses the customer composite",
  /orders_customer_created_idx/.test(await plan(`select * from public.orders where customer_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by created_at desc limit 101`)));

console.log("\n── housekeeping ──");
await db.exec(`
  insert into public.rate_limits values ('old', 1, now() - interval '3 days'), ('fresh', 1, now() + interval '1 minute'), ('just-ended', 1, now() - interval '1 hour');
  insert into public.otp_codes (phone, created_at) values ('a', now() - interval '8 days'), ('b', now() - interval '1 hour');
  insert into public.banner_events (kind, created_at) values ('click', now() - interval '200 days'), ('click', now() - interval '10 days');
`);
await db.exec("set role service_role");
const res = (await db.query("select public.housekeeping() as r")).rows[0].r;
await db.exec("reset role");
ok("deletes the stale rate_limit only", res.rate_limits === 1 && (await db.query("select key from public.rate_limits order by key")).rows.map((r) => r.key).join() === "fresh,just-ended");
ok("deletes the 8-day-old otp code only", res.otp_codes === 1 && (await db.query("select count(*)::int c from public.otp_codes")).rows[0].c === 1);
ok("deletes the 200-day-old banner event only", res.banner_events === 1 && (await db.query("select count(*)::int c from public.banner_events")).rows[0].c === 1);
const db_r2 = (await db.query("select public.housekeeping() as r")).rows[0].r;
ok("a second run deletes nothing", (() => { const r = (db_r2); return r.rate_limits === 0 && r.otp_codes === 0 && r.banner_events === 0; })());

console.log("\n── grants ──");
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set role ${role}`);
  let denied = false;
  try { await db.query("select public.housekeeping()"); } catch (e) { denied = /permission denied/.test(e.message); }
  await db.exec("reset role");
  ok(`${role} cannot run housekeeping`, denied);
  await db.exec(`set role ${role}`);
  denied = false;
  try { await db.exec("insert into public.banner_events (kind) values ('click')"); } catch (e) { denied = /permission denied/.test(e.message); }
  await db.exec("reset role");
  ok(`${role} cannot insert banner_events directly`, denied);
}
await db.exec("set role service_role");
let svcOk = true;
try { await db.exec("insert into public.banner_events (kind) values ('click')"); } catch { svcOk = false; }
await db.exec("reset role");
ok("service role still can", svcOk);

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
