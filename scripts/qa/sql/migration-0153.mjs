// Runs migration 0153 (rider list facts and rider history, aggregated in SQL so
// the rider screens never pull a rider's whole history into the server) in an
// in-process Postgres (PGlite) on top of manager-base.mjs + 0142 + 0150 + 0151.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0153.mjs
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0153_rider_list_history.sql");
const { db } = await managerBase();
const { A, M, C, D1, D2, R1 } = IDS;

await db.exec(`
  alter table public.profiles add column if not exists phone text;
  alter table public.orders add column if not exists cancelled_at timestamptz;
  create or replace function public.lock_role() returns trigger language plpgsql as $$ begin return new; end; $$;
  create table if not exists public.support_tickets (id uuid primary key default gen_random_uuid(), requester_id uuid not null,
    requester_role text not null, order_id uuid, status text not null default 'open', created_at timestamptz default now());
`);
await db.exec(readMigration("0142_manager_orders_live.sql"));
await db.exec(readMigration("0150_rider_tables_converge.sql"));
await db.exec(readMigration("0151_manager_riders.sql"));
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
const fails = (r, re) => !r.ok && re.test(r.msg);

// D1: one delivered today (code), one failed yesterday, one cancelled order, one reassigned away; one active.
const o = (n) => id(4000 + n);
await db.exec(`
  insert into public.orders (id, customer_id, restaurant_id, status, total, address) values
    ('${o(1)}','${C}','${R1}','delivered',420,'{"area":"Ward 4","line":"12 Gandhi Chowk"}'),
    ('${o(2)}','${C}','${R1}','cancelled',300,'{"line":"x"}'),
    ('${o(3)}','${C}','${R1}','cancelled',250,'{}'),
    ('${o(4)}','${C}','${R1}','on_the_way',200,'{}'),
    ('${o(5)}','${C}','${R1}','ready',150,'{}');
  update public.orders set cancelled_at = now() - interval '3 hours', cancellation_reason = 'Customer asked', cancelled_by = 'customer' where id = '${o(3)}';
  insert into public.order_items (order_id, name, qty, price) values ('${o(1)}','Thali',2,200),('${o(1)}','Lassi',1,20);
  insert into public.deliveries (id, order_id, driver_id, status, assigned_at, picked_up_at, delivered_at, delivery_method) values
    ('${id(5001)}','${o(1)}','${D1}','delivered', now() - interval '50 minutes', now() - interval '30 minutes', now() - interval '10 minutes', 'code');
  insert into public.deliveries (id, order_id, driver_id, status, assigned_at, failed_at, failure_reason) values
    ('${id(5002)}','${o(2)}','${D1}','failed', now() - interval '1 day 2 hours', now() - interval '1 day', 'customer_unreachable');
  insert into public.deliveries (id, order_id, driver_id, status, assigned_at) values
    ('${id(5003)}','${o(3)}','${D1}','cancelled', now() - interval '4 hours'),
    ('${id(5004)}','${o(4)}','${D2}','picked_up', now() - interval '20 minutes'),
    ('${id(5005)}','${o(5)}','${D1}','assigned', now() - interval '5 minutes');
  insert into public.delivery_events (delivery_id, order_id, driver_id, kind, reason, created_at) values
    ('${id(5004)}','${o(4)}','${D1}','reassigned','Rider bike broke', now() - interval '15 minutes');
  insert into public.rider_ratings (order_id, driver_id, customer_id, rating) values ('${o(1)}','${D1}','${C}',5), (gen_random_uuid(),'${D1}','${C}',3);
  insert into public.rider_documents (driver_id, doc_type, file_path, status, expires_on) values
    ('${D1}','aadhaar','a','pending',null), ('${D1}','driving_licence','l','verified', current_date + 10);
  insert into public.support_tickets (requester_id, requester_role, order_id, status) values
    ('${C}','customer','${o(1)}','open'), ('${D1}','driver',null,'resolved');
`);

console.log("\n── list facts ──");
let r = await as("service_role", null, `select * from public.ops_rider_list_facts(array['${D1}','${D2}']::uuid[], date_trunc('day', now()))`);
const f1 = r.ok ? r.rows.find((x) => x.driver_id === D1) : null;
ok("one row per rider", r.ok && r.rows.length === 2, r.msg);
ok("active deliveries", f1?.active_deliveries === 1, JSON.stringify(f1));
ok("delivered today", f1?.delivered_today === 1);
ok("rating average and count", Number(f1?.rating_avg) === 4 && f1?.rating_count === 2);
ok("pending and expiring documents", f1?.pending_docs === 1 && f1?.expiring_docs === 1);
ok("open complaints (a customer ticket on their order)", f1?.open_complaints === 1);
ok("not callable by a manager's session", fails(await as("authenticated", M, `select * from public.ops_rider_list_facts(array['${D1}']::uuid[], now())`), /permission denied/));

console.log("\n── history ──");
r = await as("service_role", null, `select * from public.ops_rider_history('${D1}', null, null, null, null, null, 50)`);
ok("delivered, failed, cancelled and reassigned-away rows; the active one is not history", r.ok && r.rows.length === 4, r.msg ?? JSON.stringify(r.rows?.map((x) => x.outcome)));
const byOutcome = Object.fromEntries((r.rows ?? []).map((x) => [x.outcome, x]));
ok("newest first", r.ok && r.rows[0].outcome === "delivered");
ok("delivered: proof code, items, value, area only (never the address line)",
  byOutcome.delivered?.proof === "code" && byOutcome.delivered?.item_count === 2 && byOutcome.delivered?.order_value === 420
  && byOutcome.delivered?.drop_area === "Ward 4");
ok("failed: reason from the delivery", byOutcome.failed?.reason === "customer_unreachable");
ok("cancelled: reason and who", byOutcome.cancelled?.reason === "Customer asked" && byOutcome.cancelled?.cancelled_by === "customer");
ok("reassigned away: the reason", byOutcome.reassigned?.reason === "Rider bike broke");
const first = r.rows?.[0];
const page2 = await as("service_role", null,
  `select * from public.ops_rider_history('${D1}', null, null, null, '${first.ended_at.toISOString()}', '${first.row_key}', 2)`);
ok("keyset page after the first row", page2.ok && page2.rows.length === 2 && page2.rows[0].row_key !== first.row_key, page2.msg);
r = await as("service_role", null, `select * from public.ops_rider_history('${D1}', null, null, 'failed', null, null, 50)`);
ok("outcome filter", r.ok && r.rows.length === 1 && r.rows[0].outcome === "failed");
r = await as("service_role", null, `select public.ops_rider_history_totals('${D1}', null, null) as t`);
ok("totals by outcome", r.ok && r.rows[0].t.delivered === 1 && r.rows[0].t.failed === 1 && r.rows[0].t.cancelled === 1 && r.rows[0].t.reassigned === 1, JSON.stringify(r.rows?.[0]));
ok("history not callable by a manager's session", fails(await as("authenticated", M, `select * from public.ops_rider_history('${D1}', null, null, null, null, null, 5)`), /permission denied/));
void A;

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
