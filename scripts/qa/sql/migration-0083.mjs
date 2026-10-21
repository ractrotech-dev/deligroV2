// Runs migrations 0081, 0082 then 0083 in one in-process Postgres (PGlite) with stubbed Supabase auth,
// orders and storage. Needs: npm i --no-save @electric-sql/pglite@0.2.17
// Usage: node scripts/qa/sql/migration-0083.mjs
// Proves the rate-card maths, the earnings and incentive triggers, record_rider_payout, the ledger
// guard, privileges and RLS. It does not replace running the migration on staging. PGlite is one
// connection, so concurrency is proved by the unique keys and locks, not by racing two sessions.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), "utf8");
const M0081 = read("0081_rider_app_foundation.sql");
const M0082 = read("0082_rider_jobs.sql");
let M0083 = "";
try { M0083 = read("0083_rider_money.sql"); } catch { /* reported below */ }
const db = new PGlite();

const STUBS = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  -- Supabase default: every table, sequence and function created later in public
  -- is granted to the API roles. The migrations have to take that back themselves.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);

  create table public.profiles (id uuid primary key, role text not null, full_name text,
    created_at timestamptz not null default now());
  create table public.restaurants (id uuid primary key, owner_id uuid);
  -- 0013: tip is whole rupees; 0025: payment_method enum, not null, default cod.
  create type public.payment_method as enum ('cod', 'online');
  create table public.orders (id uuid primary key, status text not null default 'ready',
    customer_id uuid, restaurant_id uuid,
    tip integer not null default 0 check (tip >= 0),
    payment_method public.payment_method not null default 'cod',
    payment_status text not null default 'pending',
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

  alter table public.deliveries enable row level security;
  create policy "deliveries — manager manage" on public.deliveries for all
    using (public.is_admin() or public.current_role() = 'manager')
    with check (public.is_admin() or public.current_role() = 'manager');
  alter table public.profiles enable row level security;
  create policy "profiles — read" on public.profiles for select using (true);
  -- The earnings trigger reads orders as its owner, so the order's RLS must not hide the tip.
  alter table public.orders enable row level security;
  create policy "orders — read" on public.orders for select
    using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());

  create function public.guard_order_update() returns trigger language plpgsql as $$ begin return new; end $$;
  create trigger orders_guard_update before update on public.orders
    for each row execute function public.guard_order_update();

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  revoke select on public.platform_settings from anon, authenticated;
  grant select (id, business_name) on public.platform_settings to anon, authenticated;
  revoke select on public.orders from anon, authenticated;
  grant select (id, status, customer_id, restaurant_id) on public.orders to authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`;
await db.exec(STUBS);

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const D1 = id(0xd1), D2 = id(0xd2), D3 = id(0xd3), D4 = id(0xd4), D5 = id(0xd5), D6 = id(0xd6), D7 = id(0xd7), D8 = id(0xd8), M = id(0xe1), A = id(0xa1), C = id(0xc1), V = id(0xb1), R = id(0xf1);
await db.exec(`
  insert into public.profiles (id, role, full_name, created_at) values
    ('${D1}','driver','First rider','2025-01-02'), ('${D2}','driver','Second rider','2025-01-03'),
    ('${D3}','driver','Third rider','2025-01-04'), ('${D4}','driver','Fourth rider','2025-01-05'),
    ('${D5}','driver','Fifth rider','2025-01-03'), ('${D6}','driver','Sixth rider','2025-01-03'),
    ('${D7}','driver','Seventh rider','2025-01-03'), ('${D8}','driver','Eighth rider','2025-01-03'),
    ('${M}','manager','Manager','2025-01-06'), ('${A}','admin','Admin','2025-01-07'),
    ('${C}','customer','Customer','2025-01-08'), ('${V}','vendor','Vendor','2025-01-09');
  insert into public.restaurants (id, owner_id) values ('${R}','${V}');
`);

await db.exec(M0081);
await db.exec(M0082);
let applied = true;
try { if (!M0083) throw new Error("supabase/migrations/0083_rider_money.sql not found"); await db.exec(M0083); }
catch (e) { applied = false; console.log(`0083 did not apply: ${e.message}`); }

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
ok("0083 applies on top of 0081 and 0082", applied);
if (!applied) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }

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
const rlsRefused = (r) => !r.ok && /row-level security/.test(r.msg);
const checkFails = (r) => !r.ok && r.code === "23514";
const one = async (sql) => (await db.query(sql)).rows[0];
const count = async (sql) => Number((await one(`select count(*)::int as n from (${sql}) q`)).n);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const TODAY = (await one(`select ((now() at time zone 'Asia/Kolkata')::date)::text as d`)).d;
const TOMORROW = (await one(`select ((now() at time zone 'Asia/Kolkata')::date + 1)::text as d`)).d;

let orderSeq = 0;
// An order + a delivery taken by `driver`, moved to picked_up through the guards. Returns ids.
async function pickedUp({ driver = D1, km = null, source = null, tip = 0, method = "cod" } = {}) {
  const o = id(0x1000 + ++orderSeq);
  await db.exec(`insert into public.orders (id, customer_id, restaurant_id, tip, payment_method)
                 values ('${o}','${C}','${R}',${tip},'${method}')`);
  await db.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${o}','${driver}','assigned')`);
  // The data layer stores the distance at acceptance (0081/0082).
  if (km !== null) {
    await db.exec(`update public.deliveries set distance_km = ${km}, distance_source = ${source ? `'${source}'` : "null"} where order_id = '${o}'`);
  }
  await db.exec(`update public.deliveries set status = 'picked_up', pickup_method = 'code' where order_id = '${o}'`);
  const d = (await one(`select id from public.deliveries where order_id = '${o}'`)).id;
  return { o, d };
}
// The rider app's completion path (non-correction picked_up -> delivered), optionally at a given instant.
async function delivered(opts = {}) {
  const x = await pickedUp(opts);
  const at = opts.at ? `, delivered_at = '${opts.at}'` : "";
  await db.exec(`update public.deliveries set status = 'delivered', delivery_method = 'code'${at} where id = '${x.d}'`);
  return x;
}
// The latest earning for a delivery (attempt n+1 follows a reversed attempt n).
const earning = (d) => one(`select * from public.rider_earnings where delivery_id = '${d}' order by attempt desc, created_at desc limit 1`);
const earningsOf = (d) => count(`select 1 from public.rider_earnings where delivery_id = '${d}'`);

// ── the rate card ──
console.log("\n── platform_settings: the rate card ──");
let s = await one(`select rider_base_fee, rider_km_included, rider_per_km, rider_min_per_delivery from public.platform_settings`);
ok("four rate-card columns default to 0 (nothing is paid until an admin sets a rate)",
  [s.rider_base_fee, s.rider_km_included, s.rider_per_km, s.rider_min_per_delivery].every((v) => Number(v) === 0));
ok("a negative base fee is refused", checkFails(await run(`update public.platform_settings set rider_base_fee = -1`)));
ok("a negative per-km rate is refused", checkFails(await run(`update public.platform_settings set rider_per_km = -0.5`)));
ok("negative km included is refused", checkFails(await run(`update public.platform_settings set rider_km_included = -1`)));
ok("a negative minimum is refused", checkFails(await run(`update public.platform_settings set rider_min_per_delivery = -1`)));
let r = await as("authenticated", D1, `select rider_base_fee, rider_km_included, rider_per_km, rider_min_per_delivery from public.platform_settings`);
ok("a rider can read the rate card (shown verbatim; the settings facade reads with the user's client)", r.ok && r.rows.length === 1);
ok("anon can read it too (same column grant as every non-commercial-secret setting)",
  (await as("anon", null, `select rider_base_fee from public.platform_settings`)).ok);
ok("vendor_commission_pct stays private", denied(await as("anon", null, `select vendor_commission_pct from public.platform_settings`)));

const ZERO = await delivered({ km: 5, source: "road" });
let e = await earning(ZERO.d);
ok("at the default ₹0 card a delivery still gets a ₹0 row (the ledger is complete)", e && Number(e.amount) === 0);

await db.exec(`update public.platform_settings set rider_base_fee = 20, rider_km_included = 2, rider_per_km = 6, rider_min_per_delivery = 30`);

console.log("\n── the earning: base + distance, the minimum, tips ──");
let x = await delivered({ km: 1.5, source: "road" });
e = await earning(x.d);
ok("1.5 km: amount 30", num(e?.amount) === 30);
ok("...base 20, billable 0 km, distance fee 0, min_topup 10",
  num(e.base_fee) === 20 && num(e.billable_km) === 0 && num(e.distance_fee) === 0 && num(e.min_topup) === 10);
ok("...distance 1.5 km recorded with its source 'road'", num(e.distance_km) === 1.5 && e.distance_source === "road");
ok("...order, rider and earned_at copied from the delivery",
  e.order_id === x.o && e.driver_id === D1 && e.earned_at !== null && e.payout_id === null);
const delivAt = (await one(`select delivered_at from public.deliveries where id = '${x.d}'`)).delivered_at;
ok("...earned_at is the delivery's delivered_at", new Date(e.earned_at).getTime() === new Date(delivAt).getTime());

x = await delivered({ km: 5, source: "estimate" });
e = await earning(x.d);
ok("5 km: amount 38 (20 + 3 km x 6), no top-up", num(e?.amount) === 38 && num(e.billable_km) === 3 && num(e.distance_fee) === 18 && num(e.min_topup) === 0);
ok("...an estimated distance is recorded as 'estimate'", e.distance_source === "estimate");

x = await delivered({ km: 5, source: "road", tip: 15, method: "online" });
e = await earning(x.d);
ok("5 km with a ₹15 online tip: amount 53, tip payable", num(e?.amount) === 53 && num(e.tip_amount) === 15 && e.tip_in_cash === false);

x = await delivered({ km: 5, source: "road", tip: 15, method: "cod" });
e = await earning(x.d);
ok("5 km with a ₹15 COD tip: amount 38, tip shown but in cash", num(e?.amount) === 38 && num(e.tip_amount) === 15 && e.tip_in_cash === true);

x = await delivered({ km: null });
e = await earning(x.d);
ok("no distance recorded: 0 km, source null (\"distance not recorded\"), amount = minimum 30",
  num(e?.distance_km) === 0 && e.distance_source === null && num(e.amount) === 30 && num(e.min_topup) === 10);

x = await delivered({ km: 2.37, source: "road" });
e = await earning(x.d);
ok("distance fee is rounded to paise: 0.37 km x 6 = 2.22, amount 30 (top-up 7.78)",
  num(e?.distance_fee) === 2.22 && num(e.min_topup) === 7.78 && num(e.amount) === 30);

await db.exec(`update public.platform_settings set rider_per_km = 6.333`);
x = await delivered({ km: 5, source: "road" });
e = await earning(x.d);
ok("a per-km rate with more precision is stored as money (numeric(10,2)) — 6.33 x 3 = 18.99",
  num(e?.distance_fee) === 18.99 && num(e.amount) === 38.99);
await db.exec(`update public.platform_settings set rider_per_km = 6`);

console.log("\n── a rate change never rewrites a row; a replayed delivery is reversed, then re-earned once ──");
const TWICE = await delivered({ km: 5, source: "road" });
const before = await earning(TWICE.d);
await db.exec(`update public.platform_settings set rider_base_fee = 50, rider_min_per_delivery = 60`);
ok("after a rate change the stored row keeps its amount and base fee",
  num((await one(`select amount from public.rider_earnings where id = '${before.id}'`)).amount) === 38 && num(before.base_fee) === 20);
ok("staff correction: delivered -> assigned",
  (await run(`update public.deliveries set status = 'assigned', correction_reason = 'undo:1' where id = '${TWICE.d}'`)).ok);
ok("...reverses the earning (P3-R4)",
  num((await one(`select amount from public.rider_adjustments where reverses_earning_id = '${before.id}'`))?.amount) === -38);
ok("...and back to delivered by the same rider (the delivered transition replays)",
  (await run(`update public.deliveries set status = 'delivered', correction_reason = 'redo:1' where id = '${TWICE.d}'`)).ok);
let after = await earning(TWICE.d);
ok("...the same rider re-earns once, as attempt 2, from the card in force now (50 + 18 = 68)",
  (await earningsOf(TWICE.d)) === 2 && after.id !== before.id && after.attempt === 2 && num(after.amount) === 68);
ok("...the first row is unchanged (id, amount)",
  num((await one(`select amount from public.rider_earnings where id = '${before.id}'`)).amount) === 38);
const second = after;
ok("corrected out of delivered again: the update succeeds",
  (await run(`update public.deliveries set status = 'cancelled', correction_reason = 'void:twice' where id = '${TWICE.d}'`)).ok);
ok("...only attempt 2 gets a new reversal; attempt 1 keeps its single one",
  (await count(`select 1 from public.rider_adjustments where order_id = '${TWICE.o}'`)) === 2
  && (await count(`select 1 from public.rider_adjustments where reverses_earning_id = '${second.id}'`)) === 1
  && (await count(`select 1 from public.rider_adjustments where reverses_earning_id = '${before.id}'`)) === 1);
ok("...and back to delivered for the rest of the proof (attempt 3)",
  (await run(`update public.deliveries set status = 'delivered', correction_reason = 'redo:2' where id = '${TWICE.d}'`)).ok
  && (await earning(TWICE.d)).attempt === 3);
ok("...one live earning: earnings + reversals for the delivery = 68",
  num((await one(`select (select sum(amount) from public.rider_earnings where delivery_id = '${TWICE.d}')
                       + (select sum(amount) from public.rider_adjustments where order_id = '${TWICE.o}') as n`)).n) === 68);
x = await delivered({ km: 5, source: "road" });
ok("a delivery after the rate change uses the new card (50 + 18 = 68)", num((await earning(x.d))?.amount) === 68);
ok("the earlier rows keep their recorded amounts",
  num((await earning(ZERO.d)).amount) === 0 && num((await one(`select amount from public.rider_earnings where id = '${before.id}'`)).amount) === 38);
await db.exec(`update public.platform_settings set rider_base_fee = 20, rider_min_per_delivery = 30`);

x = await pickedUp({ km: 5, source: "road" });
r = await as("authenticated", M, `update public.deliveries set status = 'delivered', delivery_method = 'staff', correction_reason = 'staff_marked_delivered' where id = '${x.d}'`);
ok("a manager marking delivered with their own JWT earns the rider (SECURITY DEFINER trigger)", r.ok && num((await earning(x.d))?.amount) === 38);

x = await pickedUp({ km: 5, source: "road" });
await db.exec(`update public.deliveries set status = 'failed', failure_reason = 'customer_unreachable', correction_reason = 'ops_failed' where id = '${x.d}'`);
ok("a failed delivery earns nothing", (await earningsOf(x.d)) === 0);
x = await pickedUp({ km: 5, source: "road" });
await db.exec(`update public.deliveries set status = 'cancelled' where id = '${x.d}'`);
ok("a cancelled delivery earns nothing", (await earningsOf(x.d)) === 0);
x = await pickedUp({ km: 5, source: "road" });
await db.exec(`update public.deliveries set cod_collected_amount = 100, driver_lat = 21.2 where id = '${x.d}'`);
ok("a non-status write earns nothing", (await earningsOf(x.d)) === 0);
await db.exec(`update public.deliveries set status = 'delivered', delivery_method = 'code' where id = '${x.d}'`);
await db.exec(`update public.deliveries set cod_collected_at = now() where id = '${x.d}'`);
ok("...and a write after delivery adds no second row", (await earningsOf(x.d)) === 1);

r = await run(`insert into public.rider_earnings (delivery_id, order_id, driver_id, earned_at, base_fee, distance_km, billable_km, distance_fee, min_topup, tip_amount, tip_in_cash, amount)
  values ('${TWICE.d}','${TWICE.o}','${D1}',now(),0,0,0,0,0,0,false,0)`);
ok("a second row for the same (delivery, rider, attempt) is refused by the unique key", !r.ok && r.code === "23505");
r = await run(`insert into public.rider_earnings (delivery_id, order_id, driver_id, earned_at, base_fee, distance_km, billable_km, distance_fee, min_topup, tip_amount, tip_in_cash, amount)
  values (gen_random_uuid(),'${TWICE.o}','${D1}',now(),20,0,0,0,10,5,false,99)`);
ok("a row whose amount does not add up is refused (CHECK)", checkFails(r));

// ── incentives ──
console.log("\n── incentive rules ──");
const rule = (sql) => run(`insert into public.rider_incentive_rules (name, period, target_deliveries, bonus_amount, window_start, window_end, starts_on, ends_on) values ${sql} returning id`);
ok("target 0 is refused", checkFails(await rule(`('x','daily',0,10,null,null,'2025-11-02',null)`)));
ok("bonus 0 is refused", checkFails(await rule(`('x','daily',1,0,null,null,'2025-11-02',null)`)));
ok("an unknown period is refused", checkFails(await rule(`('x','monthly',1,10,null,null,'2025-11-02',null)`)));
ok("a window with only a start is refused", checkFails(await rule(`('x','daily',1,10,'12:00',null,'2025-11-02',null)`)));
ok("a window ending before it starts is refused", checkFails(await rule(`('x','daily',1,10,'15:00','12:00','2025-11-02',null)`)));
ok("ends_on before starts_on is refused", checkFails(await rule(`('x','daily',1,10,null,null,'2025-11-06','2025-11-02')`)));
ok("a blank name is refused", checkFails(await rule(`('  ','daily',1,10,null,null,'2025-11-02',null)`)));
ok("the table has no Hindi name column (English-only rider side)",
  (await count(`select 1 from information_schema.columns where table_name = 'rider_incentive_rules' and column_name like '%_hi'`)) === 0);

// Each rule is in force on its own dates, so the cases below do not award each other.
const RA = (await rule(`('Daily 3','daily',3,100,null,null,'2025-11-03','2025-11-03')`)).rows[0].id;
const RB = (await rule(`('Daily 2','daily',2,50,null,null,'2025-11-03','2025-11-03')`)).rows[0].id;
const RW = (await rule(`('Lunch rush','daily',2,70,'12:00','15:00','2025-11-04','2025-11-04')`)).rows[0].id;
const RK = (await rule(`('Weekly 2','weekly',2,200,null,null,'2025-11-12','2025-11-23')`)).rows[0].id;
const awards = (driver, ruleId) => db.query(`select * from public.rider_incentive_awards where driver_id = '${driver}'${ruleId ? ` and rule_id = '${ruleId}'` : ""} order by awarded_at, period_start`).then((q) => q.rows);

console.log("\n── daily target: award on the third only; two rules both award ──");
const P1 = await delivered({ driver: D2, km: 5, source: "road", at: "2025-11-03 09:00+05:30" });
ok("1st delivery: no award", (await awards(D2)).length === 0);
const P2 = await delivered({ driver: D2, km: 5, source: "road", at: "2025-11-03 10:00+05:30" });
let aw = await awards(D2);
ok("2nd delivery: the target-2 rule awards ₹50, the target-3 rule does not",
  aw.length === 1 && aw[0].rule_id === RB && num(aw[0].amount) === 50 && aw[0].deliveries_count === 2 && aw[0].trigger_delivery_id === P2.d);
const P3 = await delivered({ driver: D2, km: 5, source: "road", at: "2025-11-03 11:00+05:30" });
aw = await awards(D2, RA);
ok("3rd delivery: the target-3 rule awards ₹100 once, triggered by the third",
  aw.length === 1 && num(aw[0].amount) === 100 && aw[0].deliveries_count === 3 && aw[0].trigger_delivery_id === P3.d);
ok("...its period starts that IST day", aw[0].period_start instanceof Date
  ? aw[0].period_start.toISOString().slice(0, 10) === "2025-11-03" : String(aw[0].period_start).startsWith("2025-11-03"));
const P4 = await delivered({ driver: D2, km: 5, source: "road", at: "2025-11-03 20:00+05:30" });
ok("4th delivery: no new award for either rule", (await awards(D2)).length === 2);
ok("both rules awarded the same rider the same day", (await awards(D2, RA)).length === 1 && (await awards(D2, RB)).length === 1);
r = await run(`insert into public.rider_incentive_awards (rule_id, driver_id, period_start, deliveries_count, amount)
  values ('${RA}','${D2}','2025-11-03',3,100)`);
ok("a second award for (rule, rider, period) is refused by the unique key (two concurrent completions award once)", !r.ok && r.code === "23505");
await delivered({ driver: D1, km: 5, source: "road", at: "2025-11-03 21:00+05:30" });
ok("another rider's delivery does not count towards this rider", (await awards(D1)).length === 0);
await delivered({ driver: D1, km: 5, source: "road", at: "2025-11-04 01:00+05:30" });
ok("a delivery after midnight IST (still 3 Nov in UTC) counts for 4 Nov, not towards 3 Nov",
  (await awards(D1)).length === 0);

console.log("\n── window rule: only 12:00–15:00 IST counts ──");
await delivered({ driver: D3, km: 5, source: "road", at: "2025-11-04 11:59+05:30" });
await delivered({ driver: D3, km: 5, source: "road", at: "2025-11-04 12:30+05:30" });
await delivered({ driver: D3, km: 5, source: "road", at: "2025-11-04 16:00+05:30" });
ok("11:59, 12:30 and 16:00 IST: only one inside the window, no award", (await awards(D3)).length === 0);
await delivered({ driver: D3, km: 5, source: "road", at: "2025-11-04 15:00+05:30" });
ok("15:00 IST is outside (the window is [start, end))", (await awards(D3)).length === 0);
const W2 = await delivered({ driver: D3, km: 5, source: "road", at: "2025-11-04 14:59+05:30" });
aw = await awards(D3, RW);
ok("14:59 IST: the second inside the window awards ₹70, counting 2", aw.length === 1 && aw[0].deliveries_count === 2 && aw[0].trigger_delivery_id === W2.d && num(aw[0].amount) === 70);

await db.exec(`update public.rider_incentive_rules set active = false where id = '${RW}'`);
await delivered({ driver: D1, km: 5, source: "road", at: "2025-11-04 12:10+05:30" });
await delivered({ driver: D1, km: 5, source: "road", at: "2025-11-04 12:20+05:30" });
await db.exec(`update public.rider_incentive_rules set active = true where id = '${RW}'`);
ok("two in-window deliveries while the rule was off: no award", (await awards(D1, RW)).length === 0);
await delivered({ driver: D1, km: 5, source: "road", at: "2025-11-04 17:00+05:30" });
ok("...after it is switched on, a delivery OUTSIDE the window does not trigger it", (await awards(D1, RW)).length === 0);
await delivered({ driver: D1, km: 5, source: "road", at: "2025-11-04 13:00+05:30" });
aw = await awards(D1, RW);
ok("...the next one inside it awards once, counting all three inside (>= target)", aw.length === 1 && aw[0].deliveries_count === 3);

console.log("\n── weekly rule: weeks start Monday IST ──");
await delivered({ driver: D4, km: 5, source: "road", at: "2025-11-11 10:00+05:30" });
ok("Tue 11 Nov: the rule (from Wed 12 Nov) is not yet in force", (await awards(D4)).length === 0);
await delivered({ driver: D4, km: 5, source: "road", at: "2025-11-12 10:00+05:30" });
ok("Wed 12 Nov: one counted delivery, no award (days before the rule do not count)", (await awards(D4)).length === 0);
const SUN = await delivered({ driver: D4, km: 5, source: "road", at: "2025-11-16 23:30+05:30" });
aw = await awards(D4, RK);
ok("Sun 16 Nov 23:30 IST belongs to the week of Mon 10 Nov: award ₹200, count 2",
  aw.length === 1 && aw[0].trigger_delivery_id === SUN.d && aw[0].deliveries_count === 2 && num(aw[0].amount) === 200
  && new Date(aw[0].period_start).toISOString().slice(0, 10) === "2025-11-10");
await delivered({ driver: D4, km: 5, source: "road", at: "2025-11-17 00:30+05:30" });
ok("Mon 17 Nov 00:30 IST (still Sunday in UTC) starts a new week: no award yet", (await awards(D4, RK)).length === 1);
await delivered({ driver: D4, km: 5, source: "road", at: "2025-11-17 10:00+05:30" });
aw = await awards(D4, RK);
ok("...a second on Mon 17 Nov awards the week of 17 Nov",
  aw.length === 2 && new Date(aw[1].period_start).toISOString().slice(0, 10) === "2025-11-17");
await db.exec(`update public.rider_incentive_rules set active = false where id = '${RK}'`);
await delivered({ driver: D1, km: 5, source: "road", at: "2025-11-18 10:00+05:30" });
await delivered({ driver: D1, km: 5, source: "road", at: "2025-11-18 11:00+05:30" });
ok("an inactive rule awards nothing", (await awards(D1, RK)).length === 0);
await db.exec(`update public.rider_incentive_rules set updated_at = '2000-01-01' where id = '${RK}'`);
ok("updated_at is stamped by the database on every edit",
  (await one(`select updated_at > '2001-01-01' as moved from public.rider_incentive_rules where id = '${RK}'`)).moved === true);
ok("a rule with awards cannot be deleted", !(await run(`delete from public.rider_incentive_rules where id = '${RA}'`)).ok);
r = await as("service_role", null, `update public.rider_incentive_rules set period = 'weekly' where id = '${RA}'`);
ok("a rule's period cannot change, even for the service role (trigger)", checkFails(r) && /rider_rule_fixed/.test(r.msg));
ok("...nor its starts_on, even for the owner", checkFails(await run(`update public.rider_incentive_rules set starts_on = '2025-10-01' where id = '${RA}'`)));
ok("...other fields still can (ends_on)", (await as("service_role", null, `update public.rider_incentive_rules set ends_on = ends_on where id = '${RA}'`)).ok);

// ── adjustments ──
console.log("\n── adjustments ──");
const adj = (driver, kind, amount, on, by = A) => run(`insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by)
  values ('${driver}','${kind}',${amount},'test','${on}','${by}') returning id`);
ok("a deduction must be positive", checkFails(await adj(D2, "deduction", -10, "2025-11-03")));
ok("a bonus must be positive", checkFails(await adj(D2, "bonus", 0, "2025-11-03")));
ok("a salary must be positive", checkFails(await adj(D2, "salary", -1, "2025-11-03")));
ok("an adjustment of 0 is refused", checkFails(await adj(D2, "adjustment", 0, "2025-11-03")));
ok("an unknown kind is refused", checkFails(await adj(D2, "fine", 10, "2025-11-03")));
ok("a blank reason is refused", checkFails(await run(`insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by)
  values ('${D2}','bonus',5,' ','2025-11-03','${A}')`)));

// ── payouts ──
console.log("\n── record_rider_payout ──");
// D2 so far: four deliveries on 3 Nov (4 x 38) + awards 100 + 50.
await adj(D2, "bonus", 25, "2025-11-03");
await adj(D2, "deduction", 10, "2025-11-06");
await adj(D2, "adjustment", -2.5, "2025-11-07");
const SALARY_LATER = (await adj(D2, "salary", 5000, "2025-12-01")).rows[0].id;
const IN_LATE = await delivered({ driver: D2, km: 5, source: "road", at: "2025-11-11 23:30+05:30" });   // 18:00 UTC, IST date 11 Nov
const OUT_EARLY = await delivered({ driver: D2, km: 5, source: "road", at: "2025-11-12 00:30+05:30" }); // 11 Nov in UTC, IST date 12 Nov
const expected = 4 * 38 + 38 + 100 + 50 + 25 - 10 - 2.5; // 352.5
// Every successful payout is checked: its amount = attached earnings + awards + signed adjustments.
const reconciles = async (payoutId) => (await one(`select p.amount =
      coalesce((select sum(amount) from public.rider_earnings where payout_id = p.id), 0)
    + coalesce((select sum(amount) from public.rider_incentive_awards where payout_id = p.id), 0)
    + coalesce((select sum(case when kind = 'deduction' then -amount else amount end)
                  from public.rider_adjustments where payout_id = p.id), 0) as ok
  from public.rider_payouts p where p.id = '${payoutId}'`))?.ok === true;
async function pay(who, driver, end = "2025-11-11", method = "upi", paidOn = end) {
  const res = await as("authenticated", who, `select public.record_rider_payout('${driver}', '${end}', '${method}', 'UTR-1', '${paidOn}', 'Week 2') as id`);
  if (res.ok) ok(`payout ${res.rows[0].id.slice(0, 8)} reconciles: amount = attached earnings + awards + adjustments`, await reconciles(res.rows[0].id));
  return res;
}

ok("a rider calling it is refused with forbidden", /forbidden/.test((await pay(D2, D2)).msg ?? ""));
ok("a manager calling it is refused with forbidden", /forbidden/.test((await pay(M, D2)).msg ?? ""));
ok("anon cannot execute it", denied(await as("anon", null, `select public.record_rider_payout('${D2}', '2025-11-11', 'upi', null, '2025-11-12', null)`)));
r = await as("service_role", null, `select public.record_rider_payout('${D2}', '2025-11-11', 'upi', null, '2025-11-12', null)`);
ok("the service role (no admin identity) cannot execute it either", !r.ok);
ok("nothing is attached after the refusals", (await count(`select 1 from public.rider_earnings where payout_id is not null`)) === 0);
ok("an unknown method is refused", checkFails(await pay(A, D2, "2025-11-11", "crypto")));
r = await pay(A, D2, "2025-11-11", "upi", "2025-11-10");
ok("paid_on before period_end is refused with invalid_payout", !r.ok && /invalid_payout/.test(r.msg));
r = await pay(A, D2, TOMORROW, "upi", TOMORROW);
ok("a period ending after today (IST) is refused with invalid_payout", !r.ok && /invalid_payout/.test(r.msg));
ok("...and neither attached anything", (await count(`select 1 from public.rider_payouts`)) === 0);
ok("the table refuses paid_on before period_end too (CHECK)", checkFails(await run(`insert into public.rider_payouts (driver_id, period_end, amount, method, paid_on, created_by)
  values ('${D1}','2025-11-11',5,'cash','2025-11-10','${A}')`)));

r = await pay(A, D2, "2025-11-11", "upi", "2025-11-12");
ok("an admin records the payout", r.ok && r.rows[0].id);
const PAYOUT = r.rows[0]?.id;
const p = await one(`select * from public.rider_payouts where id = '${PAYOUT}'`);
ok(`the payout amount is the net of everything up to 11 Nov IST: ₹${expected}`, num(p?.amount) === expected);
ok("...with period_end, method, reference, paid_on, note and created_by",
  p.driver_id === D2 && new Date(p.period_end).toISOString().slice(0, 10) === "2025-11-11" && p.method === "upi"
  && p.reference === "UTR-1" && new Date(p.paid_on).toISOString().slice(0, 10) === "2025-11-12" && p.note === "Week 2" && p.created_by === A);
ok("all five earnings up to 11 Nov IST are attached (incl. 23:30 IST on the 11th)",
  (await count(`select 1 from public.rider_earnings where driver_id = '${D2}' and payout_id = '${PAYOUT}'`)) === 5
  && (await earning(IN_LATE.d)).payout_id === PAYOUT);
ok("the 12 Nov 00:30 IST earning (11 Nov in UTC) is not", (await earning(OUT_EARLY.d)).payout_id === null);
ok("both awards are attached", (await count(`select 1 from public.rider_incentive_awards where driver_id = '${D2}' and payout_id = '${PAYOUT}'`)) === 2);
ok("the bonus, deduction and adjustment are attached; the 1 Dec salary is not",
  (await count(`select 1 from public.rider_adjustments where driver_id = '${D2}' and payout_id = '${PAYOUT}'`)) === 3
  && (await one(`select payout_id from public.rider_adjustments where id = '${SALARY_LATER}'`)).payout_id === null);
ok("no other rider's rows were touched",
  (await count(`select 1 from public.rider_earnings where driver_id <> '${D2}' and payout_id is not null`)) === 0);

r = await pay(A, D2);
ok("a second call (double-click) is refused with nothing_to_pay", !r.ok && /nothing_to_pay/.test(r.msg));
ok("...and there is still exactly one payout", (await count(`select 1 from public.rider_payouts where driver_id = '${D2}'`)) === 1);
r = await pay(A, D2, "2025-12-01");
ok("a later period settles only what is left (12 Nov earning + 1 Dec salary)", r.ok
  && num((await one(`select amount from public.rider_payouts where id = '${r.rows[0].id}'`)).amount) === 38 + 5000);

// D3: five window-day earnings (5 x 38) + award 70 = 260; a deduction of 10000 exceeds it.
await adj(D3, "deduction", 10000, "2025-11-04");
r = await pay(A, D3, "2025-12-01");
ok("a deduction exceeding everything else is refused with nothing_to_pay", !r.ok && /nothing_to_pay/.test(r.msg));
ok("...and leaves every row of that rider unattached",
  (await count(`select 1 from public.rider_earnings where driver_id = '${D3}' and payout_id is not null`)) === 0
  && (await count(`select 1 from public.rider_adjustments where driver_id = '${D3}' and payout_id is not null`)) === 0
  && (await count(`select 1 from public.rider_payouts where driver_id = '${D3}'`)) === 0);
ok("a rider with nothing at all: nothing_to_pay", /nothing_to_pay/.test((await pay(A, C, "2025-12-01")).msg ?? ""));
r = await pay(A, D4, "2025-12-01");
ok("a payout for another rider (D4: 5 x 38 + 2 x 200 = 590)", r.ok && num((await one(`select amount from public.rider_payouts where id = '${r.rows[0].id}'`)).amount) === 5 * 38 + 400);
ok("a payout amount of 0 cannot be inserted directly", checkFails(await run(`insert into public.rider_payouts (driver_id, period_end, amount, method, paid_on, created_by)
  values ('${D1}','2025-12-01',0,'cash','2025-12-01','${A}')`)));

// ── the ledger is append-only ──
console.log("\n── the ledger guard ──");
r = await run(`update public.rider_earnings set amount = amount + 1, base_fee = base_fee + 1 where delivery_id = '${OUT_EARLY.d}'`);
ok("changing an earning's figures is refused, even for the owner role", checkFails(r) && /rider_ledger_immutable/.test(r.msg));
r = await as("service_role", null, `update public.rider_earnings set payout_id = null where delivery_id = '${IN_LATE.d}'`);
ok("detaching a paid earning is refused for the service role", checkFails(r));
r = await run(`update public.rider_adjustments set amount = 1 where id = '${SALARY_LATER}'`);
ok("changing an adjustment is refused (a correction is a new row)", checkFails(r));
r = await run(`delete from public.rider_earnings where delivery_id = '${IN_LATE.d}'`);
ok("deleting a paid earning is refused", checkFails(r));
r = await run(`delete from public.rider_adjustments where driver_id = '${D2}' and kind = 'bonus'`);
ok("deleting a paid adjustment is refused", checkFails(r));
ok("stamping notified_at on an award is allowed (the push job)",
  (await as("service_role", null, `update public.rider_incentive_awards set notified_at = now() where driver_id = '${D4}'`)).ok);
const UNPAID = (await adj(D1, "bonus", 5, "2025-11-21")).rows[0].id;
ok("deleting an unpaid adjustment is allowed for the service role",
  (await as("service_role", null, `delete from public.rider_adjustments where id = '${UNPAID}'`)).ok);

// ── RLS and privileges ──
console.log("\n── RLS and privileges ──");
for (const table of ["rider_earnings", "rider_incentive_awards", "rider_adjustments", "rider_payouts"]) {
  const all = await count(`select 1 from public.${table}`);
  const mine = await count(`select 1 from public.${table} where driver_id = '${D2}'`);
  r = await as("authenticated", D2, `select driver_id from public.${table}`);
  ok(`${table}: rider 2 reads only own rows (${mine} of ${all})`,
    r.ok && mine > 0 && mine < all && r.rows.length === mine && r.rows.every((y) => y.driver_id === D2));
  r = await as("authenticated", A, `select driver_id from public.${table}`);
  ok(`${table}: admin reads all`, r.ok && r.rows.length === all);
  r = await as("authenticated", C, `select driver_id from public.${table}`);
  ok(`${table}: a customer reads none`, r.ok && r.rows.length === 0);
  ok(`${table}: anon cannot read`, denied(await as("anon", null, `select driver_id from public.${table}`)));
  ok(`${table}: rider cannot update`, denied(await as("authenticated", D2, `update public.${table} set driver_id = driver_id`)));
  ok(`${table}: rider cannot delete`, denied(await as("authenticated", D2, `delete from public.${table}`)));
  ok(`${table}: service_role reads all`, (await as("service_role", null, `select driver_id from public.${table}`)).rows?.length === all);
}
ok("rider cannot insert an earning", denied(await as("authenticated", D2, `insert into public.rider_earnings (delivery_id, order_id, driver_id, earned_at, base_fee, distance_km, billable_km, distance_fee, min_topup, tip_amount, tip_in_cash, amount)
  values (gen_random_uuid(),'${P1.o}','${D2}',now(),0,0,0,0,0,0,false,0)`)));
ok("rider cannot insert an award", denied(await as("authenticated", D2, `insert into public.rider_incentive_awards (rule_id, driver_id, period_start, deliveries_count, amount) values ('${RW}','${D2}','2025-12-02',1,1)`)));
ok("rider cannot insert a payout", denied(await as("authenticated", D2, `insert into public.rider_payouts (driver_id, period_end, amount, method, paid_on, created_by) values ('${D2}','2025-12-02',1,'cash','2025-12-02','${D2}')`)));
ok("admin cannot insert a payout directly (only through record_rider_payout)", denied(await as("authenticated", A, `insert into public.rider_payouts (driver_id, period_end, amount, method, paid_on, created_by) values ('${D2}','2025-12-02',1,'cash','2025-12-02','${A}')`)));
ok("rider cannot insert an adjustment (RLS)", rlsRefused(await as("authenticated", D2, `insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by) values ('${D2}','bonus',500,'me','2025-12-02','${D2}')`)));
ok("a manager cannot insert an adjustment (RLS)", rlsRefused(await as("authenticated", M, `insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by) values ('${D2}','bonus',500,'x','2025-12-02','${M}')`)));
ok("an admin inserts an adjustment with their own JWT", (await as("authenticated", A, `insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by) values ('${D1}','bonus',50,'Festival','2025-12-02','${A}')`)).ok);
ok("...but not in someone else's name", rlsRefused(await as("authenticated", A, `insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by) values ('${D1}','bonus',50,'x','2025-12-02','${M}')`)));
ok("...and not pre-attached to a payout", denied(await as("authenticated", A, `insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by, payout_id) values ('${D1}','bonus',50,'x','2025-12-02','${A}','${PAYOUT}')`)));
ok("an admin cannot edit an adjustment", denied(await as("authenticated", A, `update public.rider_adjustments set amount = 1`)));

r = await as("authenticated", D1, `select id, active from public.rider_incentive_rules`);
ok("a rider reads the active rules only", r.ok && r.rows.length === 3 && r.rows.every((y) => y.active) && !r.rows.some((y) => y.id === RK));
ok("a customer reads no rules", (await as("authenticated", C, `select id from public.rider_incentive_rules`)).rows?.length === 0);
ok("anon cannot read rules", denied(await as("anon", null, `select id from public.rider_incentive_rules`)));
ok("an admin reads every rule", (await as("authenticated", A, `select id from public.rider_incentive_rules`)).rows?.length === 4);
ok("an admin creates a rule with their own JWT",
  (await as("authenticated", A, `insert into public.rider_incentive_rules (name, period, target_deliveries, bonus_amount, starts_on, created_by) values ('Admin rule','daily',5,40,'2025-12-02','${A}')`)).ok);
ok("an admin edits / deactivates a rule", (await as("authenticated", A, `update public.rider_incentive_rules set active = false, bonus_amount = 45 where name = 'Admin rule'`)).ok
  && (await one(`select active from public.rider_incentive_rules where name = 'Admin rule'`)).active === false);
ok("an admin cannot change a rule's period (a new period is a new rule)",
  denied(await as("authenticated", A, `update public.rider_incentive_rules set period = 'weekly' where name = 'Admin rule'`)));
ok("...nor its starts_on", denied(await as("authenticated", A, `update public.rider_incentive_rules set starts_on = '2025-11-01' where name = 'Admin rule'`)));
ok("an admin cannot create a rule in someone else's name",
  rlsRefused(await as("authenticated", A, `insert into public.rider_incentive_rules (name, period, target_deliveries, bonus_amount, starts_on, created_by) values ('Forged','daily',5,40,'2025-12-02','${M}')`)));
r = await as("authenticated", D4, `select id, name from public.rider_incentive_rules where id = '${RK}'`);
ok("a rider still reads a switched-off rule they hold an award under (its name on past awards)", r.ok && r.rows.length === 1 && r.rows[0].name === "Weekly 2");
ok("...a rider without an award under it does not", (await as("authenticated", D2, `select id from public.rider_incentive_rules where id = '${RK}'`)).rows?.length === 0);
ok("an admin cannot delete a rule", denied(await as("authenticated", A, `delete from public.rider_incentive_rules where name = 'Admin rule'`)));
ok("a rider cannot create a rule", rlsRefused(await as("authenticated", D1, `insert into public.rider_incentive_rules (name, period, target_deliveries, bonus_amount, starts_on) values ('Mine','daily',1,1000,'2025-12-02')`)));
r = await as("authenticated", D1, `update public.rider_incentive_rules set bonus_amount = 1000 returning id`);
ok("a rider's update to a rule changes nothing", r.ok && r.rows.length === 0);
ok("a manager cannot create a rule", rlsRefused(await as("authenticated", M, `insert into public.rider_incentive_rules (name, period, target_deliveries, bonus_amount, starts_on) values ('Mgr','daily',1,1000,'2025-12-02')`)));

console.log("\n── P3-R4: leaving delivered reverses the earning ──");
const RV = await delivered({ driver: D5, km: 5, source: "road" });
const rvE = await earning(RV.d);
ok("rider 5 earns 38", num(rvE?.amount) === 38);
r = await as("authenticated", M, `update public.deliveries set status = 'assigned', correction_reason = 'wrong_handover:1' where id = '${RV.d}'`);
ok("a manager corrects the delivery out of delivered with their own JWT", r.ok);
let rev = (await db.query(`select * from public.rider_adjustments where order_id = '${RV.o}'`)).rows;
ok("...one reversing adjustment: kind adjustment, -38, rider 5, linked to the earning",
  rev.length === 1 && rev[0].kind === "adjustment" && num(rev[0].amount) === -38 && rev[0].driver_id === D5 && rev[0].reverses_earning_id === rvE.id);
ok("...its reason names the order code; dated today IST; authored by the manager",
  rev[0].reason === `Delivery ${RV.o.slice(0, 8).toUpperCase()} corrected after delivery` && day(rev[0].effective_on) === TODAY && rev[0].created_by === M);
ok("...the earning row itself is untouched", num((await one(`select amount from public.rider_earnings where id = '${rvE.id}'`)).amount) === 38);
r = await run(`update public.deliveries set status = 'failed', failure_reason = 'customer_refused', correction_reason = 'ops_failed:1' where id = '${RV.d}'`);
ok("...then corrected to failed: still exactly one reversal", r.ok && (await count(`select 1 from public.rider_adjustments where order_id = '${RV.o}'`)) === 1);
r = await run(`update public.deliveries set status = 'failed', correction_reason = 'ops_failed:2' where id = '${RV.d}'`);
ok("a replayed correction writes no second reversal", r.ok && (await count(`select 1 from public.rider_adjustments where order_id = '${RV.o}'`)) === 1);
ok("rider 5's pending nets to zero",
  num((await one(`select (select coalesce(sum(amount), 0) from public.rider_earnings where driver_id = '${D5}')
                       + (select coalesce(sum(amount), 0) from public.rider_adjustments where driver_id = '${D5}') as n`)).n) === 0);
ok("...so a payout for rider 5 finds nothing_to_pay", /nothing_to_pay/.test((await pay(A, D5, TODAY)).msg ?? ""));
ok("ops gives the job to rider 6 (correction)",
  (await run(`update public.deliveries set status = 'assigned', driver_id = '${D6}', correction_reason = 'reassigned:1' where id = '${RV.d}'`)).ok);
await db.exec(`update public.deliveries set status = 'picked_up', pickup_method = 'code' where id = '${RV.d}'`);
await db.exec(`update public.deliveries set status = 'delivered', delivery_method = 'code' where id = '${RV.d}'`);
e = await one(`select * from public.rider_earnings where delivery_id = '${RV.d}' and driver_id = '${D6}'`);
ok("a second rider completing the corrected delivery earns (their attempt 1)", num(e?.amount) === 38 && e.attempt === 1);
ok("...and rider 5 is not paid again", (await count(`select 1 from public.rider_earnings where delivery_id = '${RV.d}' and driver_id = '${D5}'`)) === 1);
ok("a ₹0 earning is reversed with a ₹0 adjustment",
  (await run(`update public.deliveries set status = 'cancelled', correction_reason = 'void:1' where id = '${ZERO.d}'`)).ok
  && num((await one(`select amount from public.rider_adjustments where order_id = '${ZERO.o}'`))?.amount) === 0);
ok("a reversal cannot be deleted, even by the service role",
  checkFails(await as("service_role", null, `delete from public.rider_adjustments where id = '${rev[0].id}'`)));
ok("a reversal must not be positive", checkFails(await run(`insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, reverses_earning_id)
  values ('${D6}','adjustment',5,'x','${TODAY}','${e.id}')`)));
ok("only a reversal may lack an author", checkFails(await run(`insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on)
  values ('${D6}','bonus',5,'x','${TODAY}')`)));
ok("an admin cannot write a reversal", denied(await as("authenticated", A, `insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by, reverses_earning_id)
  values ('${D6}','adjustment',-38,'x','${TODAY}','${A}','${e.id}')`)));
const PRE = await pickedUp({ driver: D5, km: 5, source: "road" });
await db.exec(`insert into public.rider_earnings (delivery_id, order_id, driver_id, earned_at, base_fee, distance_km, distance_source, billable_km, distance_fee, min_topup, tip_amount, tip_in_cash, amount)
  values ('${PRE.d}','${PRE.o}','${D5}',now(),20,5,'road',3,18,0,0,false,38)`);
await db.exec(`update public.deliveries set status = 'delivered', delivery_method = 'code' where id = '${PRE.d}'`);
ok("while the rider holds a live earning for the delivery, delivering writes no second one", (await earningsOf(PRE.d)) === 1);
const OTHER = await pickedUp({ driver: D6, km: 5, source: "road" });
await db.exec(`insert into public.rider_earnings (delivery_id, order_id, driver_id, earned_at, base_fee, distance_km, distance_source, billable_km, distance_fee, min_topup, tip_amount, tip_in_cash, amount)
  values ('${OTHER.d}','${OTHER.o}','${D5}',now(),20,5,'road',3,18,0,0,false,38)`);
await db.exec(`update public.deliveries set status = 'delivered', delivery_method = 'code' where id = '${OTHER.d}'`);
ok("another rider's live earning on the delivery does not block the rider who delivers it (key is per rider)",
  (await count(`select 1 from public.rider_earnings where delivery_id = '${OTHER.d}' and driver_id = '${D6}'`)) === 1);
const RR = (await rule(`('Reversal day','daily',2,30,null,null,'2025-12-10','2025-12-10')`)).rows[0].id;
const RX = await delivered({ driver: D6, km: 5, source: "road", at: "2025-12-10 10:00+05:30" });
await db.exec(`update public.deliveries set status = 'cancelled', correction_reason = 'void:2' where id = '${RX.d}'`);
await delivered({ driver: D6, km: 5, source: "road", at: "2025-12-10 11:00+05:30" });
ok("a reversed earning does not count towards a target", (await awards(D6, RR)).length === 0);
await delivered({ driver: D6, km: 5, source: "road", at: "2025-12-10 12:00+05:30" });
aw = await awards(D6, RR);
ok("...the next live one does (count 2)", aw.length === 1 && aw[0].deliveries_count === 2);
await db.exec(`update public.rider_incentive_rules set active = false where id = '${RR}'`);

console.log("\n── an award is dated by its earning row; a re-earned delivery does not double it ──");
const RC = (await rule(`('Fix2 daily','daily',1,10,null,null,'2025-12-15','2025-12-15')`)).rows[0].id;
const AX = await delivered({ driver: D7, km: 5, source: "road", at: "2025-12-15 10:00+05:30" });
aw = await awards(D7, RC);
ok("D7's delivery earns 38 and an award of 10 linked to that earning row",
  aw.length === 1 && aw[0].trigger_earning_id === (await earning(AX.d)).id && aw[0].trigger_delivery_id === AX.d);
await db.exec(`update public.deliveries set status = 'assigned', correction_reason = 'fix2:undo' where id = '${AX.d}'`);
await db.exec(`update public.deliveries set status = 'delivered', correction_reason = 'fix2:redo' where id = '${AX.d}'`);
ok("...corrected out (reversed) and re-earned: two earning rows on the delivery, still one award",
  (await earningsOf(AX.d)) === 2 && (await awards(D7, RC)).length === 1);
r = await pay(A, D7, TODAY);
ok("...the payout counts the award once: 38 + 38 - 38 + 10 = 48",
  r.ok && num((await one(`select amount from public.rider_payouts where id = '${r.rows[0].id}'`)).amount) === 48);

console.log("\n── P3-R6: a payout that attaches an earning attaches its reversal ──");
const PY = await delivered({ driver: D8, km: 5, source: "road", at: "2025-12-16 10:00+05:30" });
const PZ = await delivered({ driver: D8, km: 5, source: "road", at: "2025-12-16 11:00+05:30" });
await db.exec(`update public.deliveries set status = 'cancelled', correction_reason = 'fix2:void-y' where id = '${PY.d}'`);
const pyRev = await one(`select * from public.rider_adjustments where order_id = '${PY.o}'`);
ok("the reversal of Y is dated today, after the period below", day(pyRev.effective_on) === TODAY && TODAY > "2025-12-16");
r = await pay(A, D8, "2025-12-16");
const PAY8 = r.rows?.[0]?.id;
ok("a payout up to 16 Dec pays only Z (38): Y and its reversal are both attached",
  r.ok && num((await one(`select amount from public.rider_payouts where id = '${PAY8}'`)).amount) === 38
  && (await one(`select payout_id from public.rider_adjustments where id = '${pyRev.id}'`)).payout_id === PAY8
  && (await earning(PY.d)).payout_id === PAY8 && (await earning(PZ.d)).payout_id === PAY8);
await db.exec(`update public.deliveries set status = 'cancelled', correction_reason = 'fix2:void-z' where id = '${PZ.d}'`);
const pzRev = await one(`select * from public.rider_adjustments where order_id = '${PZ.o}'`);
ok("a reversal of an earning paid earlier stays pending (honest debt)", num(pzRev.amount) === -38 && pzRev.payout_id === null);
ok("...and on its own it is nothing_to_pay", /nothing_to_pay/.test((await pay(A, D8, TODAY)).msg ?? ""));

console.log("\n── P3-R7: a delivered delivery keeps its rider ──");
r = await run(`update public.deliveries set driver_id = '${D6}' where id = '${TWICE.d}'`);
ok("changing the rider of a delivered delivery is refused", checkFails(r) && /delivered/.test(r.detail ?? ""));
r = await as("authenticated", M, `update public.deliveries set driver_id = '${D6}', correction_reason = 'fix2:move' where id = '${TWICE.d}'`);
ok("...even as a manager's correction", checkFails(r));
ok("...other writes on a delivered row still work", (await run(`update public.deliveries set cod_collected_amount = 10 where id = '${TWICE.d}'`)).ok);

console.log("\n── P3-R8: a delivery with an earning cannot be deleted ──");
r = await run(`delete from public.deliveries where id = '${TWICE.d}'`);
ok("deleting a delivery with a live earning is refused", !r.ok && /delivery_has_earnings/.test(r.msg));
r = await as("authenticated", M, `delete from public.deliveries where id = '${ZERO.d}'`);
ok("...with only a reversed earning, refused too — for a manager's own JWT as well", !r.ok && /delivery_has_earnings/.test(r.msg));
r = await run(`delete from public.orders where id = '${TWICE.o}'`);
ok("deleting its order (cascading to the delivery) is refused", !r.ok && /delivery_has_earnings/.test(r.msg)
  && (await count(`select 1 from public.deliveries where id = '${TWICE.d}'`)) === 1);
const NOEARN = await pickedUp({ driver: D8, km: 5, source: "road" });
ok("a delivery without an earning can still be deleted", (await run(`delete from public.deliveries where id = '${NOEARN.d}'`)).ok);

console.log("\n── function hygiene ──");
const fns = (await db.query(`select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('record_rider_earning','reverse_rider_earning','award_rider_incentives','record_rider_payout','guard_rider_ledger','touch_rider_incentive_rule','guard_delivered_rider','guard_delivery_delete')`)).rows;
ok("eight functions exist", fns.length === 8);
ok("every one pins search_path", fns.every((f) => /search_path=/.test(f.cfg ?? "")));
ok("the earning, reversal, award and payout functions are SECURITY DEFINER",
  ["record_rider_earning", "reverse_rider_earning", "award_rider_incentives", "record_rider_payout", "guard_delivery_delete"].every((n) => fns.find((f) => f.proname === n)?.prosecdef === true));
for (const fn of ["record_rider_earning()", "reverse_rider_earning()", "award_rider_incentives()", "guard_rider_ledger()", "touch_rider_incentive_rule()", "guard_delivered_rider()", "guard_delivery_delete()"]) {
  const g = await one(`select has_function_privilege('anon', 'public.${fn}', 'execute') as a,
                              has_function_privilege('authenticated', 'public.${fn}', 'execute') as u`);
  ok(`${fn}: no EXECUTE for anon or authenticated`, !g.a && !g.u);
}
const g = await one(`select has_function_privilege('anon', 'public.record_rider_payout(uuid,date,text,text,date,text)', 'execute') as a,
                            has_function_privilege('authenticated', 'public.record_rider_payout(uuid,date,text,text,date,text)', 'execute') as u`);
ok("record_rider_payout: authenticated may call it (it checks is_admin itself); anon may not", g.u && !g.a);

console.log("\n── idempotent ──");
const nEarn = await count(`select 1 from public.rider_earnings`), nAw = await count(`select 1 from public.rider_incentive_awards`);
let again = true; try { await db.exec(M0083); } catch (err) { again = false; console.log(err.message); }
ok("0083 can be applied twice", again);
ok("...and the ledger survives", (await count(`select 1 from public.rider_earnings`)) === nEarn && (await count(`select 1 from public.rider_incentive_awards`)) === nAw);
ok("...the rate card keeps the admin's values", num((await one(`select rider_base_fee from public.platform_settings`)).rider_base_fee) === 20);
x = await delivered({ km: 5, source: "road" });
ok("...and a delivery after the re-run still earns once", (await earningsOf(x.d)) === 1);

console.log("\n── the rollback block (fresh instance) ──");
// The header's rollback lines are "--   <sql>"; a line whose SQL is itself commented out is skipped.
const lines = M0083.split("\n");
const from = lines.findIndex((l) => l.startsWith("-- Rollback"));
const block = [];
for (const l of lines.slice(from + 1)) {
  if (l.startsWith("-- ====")) break;
  if (/^--   /.test(l) && !/^--\s+--/.test(l)) block.push(l.slice(2));
}
const ROLLBACK = block.join("\n");
ok("the rollback block was found", from > 0 && /drop table/.test(ROLLBACK));
const rb = new PGlite();
await rb.exec(STUBS);
await rb.exec(`insert into public.profiles (id, role) values ('${D1}','driver'), ('${A}','admin');
               insert into public.orders (id, customer_id, restaurant_id) values ('${id(0x9001)}','${C}','${R}'), ('${id(0x9002)}','${C}','${R}');`);
await rb.exec(M0081); await rb.exec(M0082); await rb.exec(M0083);
await rb.exec(`update public.platform_settings set rider_base_fee = 20;
  insert into public.rider_incentive_rules (name, period, target_deliveries, bonus_amount, starts_on) values ('R','daily',1,10,'2025-01-01');
  insert into public.deliveries (order_id, driver_id, status) values ('${id(0x9001)}','${D1}','assigned');
  update public.deliveries set status = 'picked_up', pickup_method = 'code' where order_id = '${id(0x9001)}';
  update public.deliveries set status = 'delivered', delivery_method = 'code' where order_id = '${id(0x9001)}';
  update public.deliveries set status = 'cancelled', correction_reason = 'void' where order_id = '${id(0x9001)}';`);
ok("the fresh instance has an earning, an award and a reversal",
  Number((await rb.query(`select (select count(*) from public.rider_earnings) + (select count(*) from public.rider_incentive_awards)
                                + (select count(*) from public.rider_adjustments) as n`)).rows[0].n) === 3);
let rolled = true; try { await rb.exec(ROLLBACK); } catch (err) { rolled = false; console.log(`rollback failed: ${err.message}`); }
ok("the rollback block runs to completion", rolled);
ok("...and removes every 0083 table, function and rate-card column",
  (await rb.query(`select to_regclass('public.rider_earnings') is null and to_regclass('public.rider_payouts') is null
                      and to_regclass('public.rider_adjustments') is null and to_regclass('public.rider_incentive_rules') is null
                      and to_regclass('public.rider_incentive_awards') is null
                      and not exists (select 1 from pg_proc where proname in ('record_rider_earning','reverse_rider_earning','award_rider_incentives','record_rider_payout','guard_rider_ledger','touch_rider_incentive_rule','guard_delivered_rider','guard_delivery_delete'))
                      and not exists (select 1 from information_schema.columns where table_name = 'platform_settings' and column_name like 'rider\_%' and column_name in ('rider_base_fee','rider_km_included','rider_per_km','rider_min_per_delivery')) as gone`)).rows[0].gone === true);
let after0083 = true;
try {
  await rb.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${id(0x9002)}','${D1}','assigned');
    update public.deliveries set status = 'picked_up', pickup_method = 'code' where order_id = '${id(0x9002)}';
    update public.deliveries set status = 'delivered', delivery_method = 'code' where order_id = '${id(0x9002)}';`);
} catch (err) { after0083 = false; console.log(err.message); }
ok("...deliveries still complete afterwards (no dangling trigger)", after0083);
let reapplied = true; try { await rb.exec(M0083); } catch (err) { reapplied = false; console.log(err.message); }
ok("...and 0083 applies again after the rollback", reapplied);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
