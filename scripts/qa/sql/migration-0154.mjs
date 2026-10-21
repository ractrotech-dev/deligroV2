// Runs migration 0154 (a rider's cash position and money summary, summed in SQL)
// in an in-process Postgres (PGlite) on top of manager-base.mjs + 0142 + 0150–0152.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0154.mjs
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0154_rider_cash_money_summary.sql");
const { db } = await managerBase();
const { A, M, C, D1, D2, R1 } = IDS;

await db.exec(`
  alter table public.profiles add column if not exists phone text;
  alter table public.cod_handovers add column if not exists from_user uuid, add column if not exists to_user uuid,
    add column if not exists handover_date date not null default current_date, add column if not exists note text;
  create or replace function public.lock_role() returns trigger language plpgsql as $$ begin return new; end; $$;
`);
await db.exec(readMigration("0142_manager_orders_live.sql"));
await db.exec(readMigration("0150_rider_tables_converge.sql"));
await db.exec(readMigration("0151_manager_riders.sql"));
await db.exec(readMigration("0152_payment_requests_cash_exceptions.sql"));
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

const o = (n) => id(6000 + n);
await db.exec(`
  insert into public.orders (id, customer_id, restaurant_id, status, total) values
    ('${o(1)}','${C}','${R1}','delivered',500), ('${o(2)}','${C}','${R1}','delivered',300), ('${o(3)}','${C}','${R1}','delivered',200);
  insert into public.deliveries (order_id, driver_id, status, delivered_at, cod_collected_amount, cod_collected_at) values
    ('${o(1)}','${D1}','delivered', now(), 500, now()),
    ('${o(2)}','${D1}','delivered', now() - interval '3 days', 300, now() - interval '3 days'),
    ('${o(3)}','${D2}','delivered', now(), 200, now());
  insert into public.cod_handovers (leg, from_user, to_user, amount, recorded_by, handover_date) values
    ('rider_to_manager','${D1}','${M}', 300, '${M}', current_date - 3),
    ('rider_to_manager','${D1}','${M}', 100, '${M}', current_date),
    ('manager_to_owner','${M}','${A}', 400, '${M}', current_date);
  insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by) values
    ('${D1}','bonus',500,'x',current_date,'${A}'), ('${D1}','deduction',200,'x',current_date,'${A}');
`);

let r = await as("service_role", null, `select public.ops_rider_cash_position('${D1}', current_date) as c`);
const c = r.ok ? r.rows[0].c : null;
ok("collected today (500)", c?.collected_today === 500, r.msg ?? JSON.stringify(c));
ok("deposited today (100; the manager→owner leg is not the rider's)", c?.deposited_today === 100);
ok("pending deposit = all collected (800) − all deposited (400)", c?.pending_deposit === 400);
r = await as("service_role", null, `select public.ops_rider_money_summary('${D1}') as m`);
const m = r.ok ? r.rows[0].m : null;
ok("pending money = 500 bonus − 200 deduction", Number(m?.pending) === 300, r.msg ?? JSON.stringify(m));
ok("nothing paid yet", Number(m?.paid_total) === 0);
await as("authenticated", A, `select public.record_rider_payout('${D1}', current_date, 'cash', null, current_date, null)`);
r = await as("service_role", null, `select public.ops_rider_money_summary('${D1}') as m`);
ok("after a payout: pending 0, paid 300", Number(r.rows[0].m.pending) === 0 && Number(r.rows[0].m.paid_total) === 300, JSON.stringify(r.rows?.[0]));
ok("not callable by a manager's session", !(await as("authenticated", M, `select public.ops_rider_cash_position('${D1}', current_date)`)).ok);

let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
