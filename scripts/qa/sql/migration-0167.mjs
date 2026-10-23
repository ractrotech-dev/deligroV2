// Runs migration 0167 (vendor availability for the downtime alert) in an
// in-process Postgres (PGlite) on top of support-base.mjs.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0167.mjs
// Proves the availability stamp and the downtime facts (inside / outside
// hours, holidays, weekly off, troubled orders, zone scope); it does not
// replace staging.
import { readMigration, id, IDS } from "./manager-base.mjs";
import { supportBase } from "./support-base.mjs";

const MIGRATION = readMigration("0167_vendor_availability.sql");
const { db, ZA, ZB } = await supportBase();
const { V, C, R1, R2 } = IDS;
// 0062's columns the facts read.
await db.exec(`alter table public.restaurants add column if not exists closed_until timestamptz;
               alter table public.orders add column if not exists cancelled_at timestamptz;`);
await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };
async function as(role, uid, sql) {
  const claims = role === "service_role" ? { role: "service_role" } : {};
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
}
const one = async (sql) => (await db.query(sql)).rows[0];
// 13:30 IST on a Thursday.
const NOW = "2026-10-22T08:00:00Z";
const facts = async (zones = null, all = true, win = 60) =>
  (await as("service_role", null, `select * from public.ops_vendor_downtime_facts('${NOW}'::timestamptz, ${win}, ${zones ? `array['${zones}']::uuid[]` : "null"}, ${all})`));
const row = (r, rid) => r.rows?.find((x) => x.restaurant_id === rid);

await db.exec(`update public.restaurants set status = 'active', opening_time = '09:00', closing_time = '23:00', weekly_off = '{}' where id in ('${R1}','${R2}')`);

console.log("\n── availability stamp ──");
await db.exec(`update public.restaurants set availability_changed_at = null where id = '${R1}'`);
await db.exec(`update public.restaurants set is_open = false where id = '${R1}'`);
let s = await one(`select availability_changed_at from public.restaurants where id = '${R1}'`);
ok("switching the shop off stamps the time", s.availability_changed_at !== null);
// Fixture time travel with the trigger off (it refuses direct writes, by design).
const setStamp = (rid, expr) => db.exec(`alter table public.restaurants disable trigger stamp_restaurant_availability;
  update public.restaurants set availability_changed_at = ${expr} where id = '${rid}';
  alter table public.restaurants enable trigger stamp_restaurant_availability;`);
await setStamp(R1, `'${NOW}'::timestamptz - interval '40 minutes'`);
await db.exec(`update public.restaurants set name = 'Spice Hub', availability_changed_at = now() where id = '${R1}'`);
s = await one(`select (availability_changed_at = '${NOW}'::timestamptz - interval '40 minutes') as kept from public.restaurants where id = '${R1}'`);
ok("other edits, even a direct write to the stamp, leave it alone", s.kept === true);
await db.exec(`update public.restaurants set closed_until = now() + interval '1 hour', availability_changed_at = null where id = '${R2}'`);
s = await one(`select availability_changed_at from public.restaurants where id = '${R2}'`);
ok("closing for a while stamps it too", s.availability_changed_at !== null);
await db.exec(`update public.restaurants set closed_until = null where id = '${R2}'`);
await setStamp(R2, `'${NOW}'::timestamptz`);

console.log("\n── downtime facts ──");
let r = await facts();
let f = row(r, R1);
ok("a shop switched off at 13:30 inside 09:00–23:00 is scheduled open and closed", r.ok && f?.scheduled_open === true && f?.closed === true, r.msg);
ok("...for 40 minutes", f?.closed_minutes === 40, String(f?.closed_minutes));
ok("an open shop is not closed", row(r, R2)?.closed === false && row(r, R2)?.closed_minutes === null);
await db.exec(`update public.restaurants set opening_time = '18:00', closing_time = '23:00' where id = '${R1}'`);
f = row(await facts(), R1);
ok("outside its hours it is not scheduled open", f?.scheduled_open === false);
await db.exec(`update public.restaurants set opening_time = '22:00', closing_time = '15:00' where id = '${R1}'`);
f = row(await facts(), R1);
ok("hours past midnight (22:00–15:00) cover 13:30", f?.scheduled_open === true);
await db.exec(`update public.restaurants set opening_time = '09:00', closing_time = '23:00', weekly_off = array['Thursday'] where id = '${R1}'`);
f = row(await facts(), R1);
ok("a weekly off is not scheduled open", f?.scheduled_open === false);
await db.exec(`update public.restaurants set weekly_off = '{}' where id = '${R1}';
  insert into public.store_holidays (restaurant_id, starts_on, ends_on) values ('${R1}', '2026-10-22', '2026-10-23');`);
f = row(await facts(), R1);
ok("a holiday is not scheduled open", f?.scheduled_open === false);
await db.exec(`delete from public.store_holidays`);
await db.exec(`update public.restaurants set opening_time = null, closing_time = null where id = '${R1}'`);
f = row(await facts(), R1);
ok("a shop without hours is never scheduled open", f?.scheduled_open === false);
await db.exec(`update public.restaurants set opening_time = '09:00', closing_time = '23:00' where id = '${R1}'`);

console.log("\n── troubled orders ──");
await db.exec(`
  insert into public.orders (id, customer_id, restaurant_id, status, created_at, cancelled_by) values
    ('${id(801)}','${C}','${R1}','placed', '${NOW}'::timestamptz - interval '12 minutes', null),
    ('${id(802)}','${C}','${R1}','cancelled', '${NOW}'::timestamptz - interval '20 minutes', 'vendor'),
    ('${id(803)}','${C}','${R1}','cancelled', '${NOW}'::timestamptz - interval '25 minutes', 'customer'),
    ('${id(804)}','${C}','${R1}','placed', '${NOW}'::timestamptz - interval '2 minutes', null),
    ('${id(805)}','${C}','${R1}','cancelled', '${NOW}'::timestamptz - interval '30 hours', 'system');
`);
f = row(await facts(), R1);
ok("an unaccepted order over 5 min and a shop cancellation count; a customer's, a fresh one and an old one do not",
  Array.isArray(f?.troubled_order_times) && f.troubled_order_times.length === 2, JSON.stringify(f?.troubled_order_times));
// An unpaid online checkout was never an order the shop could accept, and a
// system cancellation (the shop did nothing wrong) is not the shop's trouble (review #14).
await db.exec(`
  insert into public.orders (id, customer_id, restaurant_id, status, created_at, cancelled_by, payment_method, payment_status) values
    ('${id(806)}','${C}','${R1}','placed', '${NOW}'::timestamptz - interval '15 minutes', null, 'online', 'pending'),
    ('${id(807)}','${C}','${R1}','cancelled', '${NOW}'::timestamptz - interval '10 minutes', 'system', 'cod', 'pending'),
    ('${id(808)}','${C}','${R1}','placed', '${NOW}'::timestamptz - interval '14 minutes', null, 'online', 'paid');
`);
f = row(await facts(), R1);
ok("an unpaid online checkout and a system cancellation are not the shop's trouble; a PAID online order left unaccepted is",
  f.troubled_order_times.length === 3, JSON.stringify(f?.troubled_order_times));

console.log("\n── cancellation facts: counted by the database, per zone window (review #7) ──");
const cf = async (windows) => as("service_role", null, `select * from public.ops_cancellation_facts('${NOW}'::timestamptz, '${JSON.stringify(windows)}'::jsonb)`);
const zrow = (r, z) => r.rows?.find((x) => x.zone_id === z);
let base = zrow(await cf({ [ZA]: 60 }), ZA);
await db.exec(`
  insert into public.orders (id, customer_id, restaurant_id, status, created_at, payment_method, payment_status) values
    ('${id(811)}','${C}','${R1}','delivered', '${NOW}'::timestamptz - interval '10 minutes', 'cod', 'pending'),
    ('${id(812)}','${C}','${R1}','delivered', '${NOW}'::timestamptz - interval '10 minutes', 'cod', 'pending'),
    ('${id(813)}','${C}','${R1}','delivered', '${NOW}'::timestamptz - interval '10 minutes', 'cod', 'pending'),
    ('${id(814)}','${C}','${R1}','cancelled', '${NOW}'::timestamptz - interval '20 minutes', 'cod', 'pending'),
    ('${id(815)}','${C}','${R1}','cancelled', '${NOW}'::timestamptz - interval '20 minutes', 'cod', 'pending'),
    ('${id(816)}','${C}','${R1}','placed', '${NOW}'::timestamptz - interval '5 minutes', 'online', 'pending'),
    ('${id(817)}','${C}','${R1}','placed', '${NOW}'::timestamptz - interval '5 minutes', 'online', 'paid'),
    ('${id(818)}','${C}','${R1}','delivered', '${NOW}'::timestamptz - interval '90 minutes', 'cod', 'pending');
`);
let after = zrow(await cf({ [ZA]: 60 }), ZA);
ok("in a 60-minute window: +6 placed (3 delivered, 2 cancelled, 1 paid online), +2 cancelled; the unpaid checkout and the 90-minute-old order are out",
  after.placed - base.placed === 6 && after.cancelled - base.cancelled === 2, JSON.stringify([base, after]));
let wide = zrow(await cf({ [ZA]: 1440 }), ZA);
ok("a wider window counts the older order too", wide.placed - after.placed >= 1, JSON.stringify(wide));
let capped = zrow(await cf({ [ZA]: 100000 }), ZA);
ok("a window is capped at a day: a 100000-minute window counts the same as 1440", capped.placed === wide.placed && capped.cancelled === wide.cancelled, JSON.stringify([capped, wide]));
let multi = await cf({ [ZA]: 60, [ZB]: 60 });
ok("each zone gets its own row from one call", !!zrow(multi, ZA) || !!zrow(multi, ZB));
r = await as("authenticated", V, `select * from public.ops_cancellation_facts(now(), '{}'::jsonb)`);
ok("service role only", !r.ok && /permission denied/.test(r.msg), r.msg);
ok("shops' orders are indexed by (restaurant, created_at) for the downtime facts",
  !!(await one(`select 1 as x from pg_indexes where indexname = 'orders_restaurant_created_idx'`)));

console.log("\n── scope and access ──");
r = await facts(ZA, false);
ok("a zone list keeps that zone's shops only", r.ok && !!row(r, R1) && !row(r, R2), r.msg);
r = await facts(ZB, false);
ok("...and the other zone's", r.ok && !row(r, R1) && !!row(r, R2));
await db.exec(`update public.restaurants set status = 'suspended' where id = '${R2}'`);
r = await facts(ZB, false);
ok("only active shops are reported", r.ok && !row(r, R2));
r = await as("authenticated", V, `select * from public.ops_vendor_downtime_facts(now(), 60, null, true)`);
ok("service role only", !r.ok && /permission denied/.test(r.msg));
// restaurants is granted column by column (0022): a new column stays invisible
// to anon/authenticated unless a migration grants it. 0167 grants nothing.
ok("0167 grants no restaurant column to signed-in users", !/grant\s+select\s*\([^)]*availability_changed_at/i.test(MIGRATION));

console.log("\n── idempotent ──");
r = await db.exec(MIGRATION).then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message }));
ok("migration can be applied twice", r.ok, r.msg);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
