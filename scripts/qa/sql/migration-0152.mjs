// Runs migration 0152 (maker–checker payment requests, audited cash-deposit,
// cash-dispute and delivery-exception decisions) in an in-process Postgres
// (PGlite) on top of manager-base.mjs + 0142 + 0150 + 0151.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0152.mjs
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0152_payment_requests_cash_exceptions.sql");
const { db, ZA, ZB } = await managerBase();
const { A, M, MB, C, D1, D2, D5, R1 } = IDS;
const M2 = id(20); // a second zone-A manager: the checker

await db.exec(`
  alter table public.profiles add column if not exists phone text;
  alter table public.cod_handovers add column if not exists from_user uuid, add column if not exists to_user uuid,
    add column if not exists handover_date date not null default current_date, add column if not exists note text;
  create or replace function public.lock_role() returns trigger language plpgsql security definer set search_path = public as $$
  begin return new; end; $$;
  insert into public.profiles (id, role, full_name) values ('${M2}','manager','Meera');
`);
await db.exec(readMigration("0142_manager_orders_live.sql"));
await db.exec(readMigration("0150_rider_tables_converge.sql"));
await db.exec(readMigration("0151_manager_riders.sql"));
await db.exec(`delete from public.staff_zones where user_id = '${M2}'; insert into public.staff_zones (user_id, zone_id) values ('${M2}','${ZA}');`);
await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };
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
const audits = async (action) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}'`)).n;

console.log("\n── payout requests (salaried rider, no earnings) ──");
let r = await srv(`select public.ops_request_rider_payout('${M}','${D1}','2026-09-30','bank',12000,'September salary','p1') as s`);
ok("a manager requests a 12,000 salary payout", r.ok && r.rows[0].s.status === "pending_approval" && Number(r.rows[0].s.amount) === 12000, r.msg);
const REQ = r.ok ? r.rows[0].s.request_id : null;
ok("...audited", (await audits("payment.request")) === 1);
ok("a second pending request for the rider → duplicate_pending",
  fails(await srv(`select public.ops_request_rider_payout('${M}','${D1}','2026-09-30','bank',100,null,'p2')`), /duplicate_pending/));
ok("nothing to pay (no salary, no ledger) → nothing_to_pay",
  fails(await srv(`select public.ops_request_rider_payout('${M}','${D2}','2026-09-30','bank',null,null,'p3')`), /nothing_to_pay/));
ok("a zone-B manager cannot request for a zone-A rider",
  fails(await srv(`select public.ops_request_rider_payout('${MB}','${D2}','2026-09-30','bank',500,null,'p4')`), /forbidden/));
ok("the requester approving → same_person",
  fails(await srv(`select public.ops_decide_payment_request('${M}','${REQ}','approve','UTR1','2026-10-05',null,null,'d1')`), /same_person/));
ok("even an admin who requested cannot approve their own",
  !!(await srv(`select public.ops_request_rider_payout('${A}','${D5}','2026-09-30','upi',800,null,'p5')`)).ok &&
  fails(await srv(`select public.ops_decide_payment_request('${A}',(select id from public.payment_requests where subject_id = '${D5}'),'approve','UTR9','2026-10-05',null,null,'d9')`), /same_person/));
ok("a direct write making the decider the requester → check violation",
  fails(await srv(`update public.payment_requests set decided_by = requested_by where id = '${REQ}'`), /violates check/));
ok("approval without a reference → reference_required",
  fails(await srv(`select public.ops_decide_payment_request('${M2}','${REQ}','approve',null,'2026-10-05',null,null,'d2')`), /reference_required/));
ok("a zone-B manager cannot decide it",
  fails(await srv(`select public.ops_decide_payment_request('${MB}','${REQ}','approve','UTR1','2026-10-05',null,null,'d3')`), /forbidden/));

// A bonus lands after the request: the amount changes before approval.
await srv(`select public.ops_add_rider_adjustment('${M}','${D1}','bonus',500,'Festival rush','2026-09-28',null,'b1')`);
r = await srv(`select public.ops_decide_payment_request('${M2}','${REQ}','approve','UTR1','2026-10-05',null,null,'d4')`);
ok("approval after the amount changed → amount_changed with the new figure", fails(r, /amount_changed/) && Number(r.detail) === 12500, `${r.msg} ${r.detail}`);
r = await srv(`select public.ops_decide_payment_request('${M2}','${REQ}','approve','UTR1','2026-10-05',12500,null,'d5') as s`);
ok("approval confirming 12,500 → approved", r.ok && r.rows[0].s.status === "approved", r.msg);
const pay = await one(`select id, amount::numeric as amount, request_id, created_by from public.rider_payouts where driver_id = '${D1}'`);
ok("...one payout of 12,500 linked to the request, recorded by the checker",
  pay && Number(pay.amount) === 12500 && pay.request_id === REQ && pay.created_by === M2, JSON.stringify(pay));
const sal = await one(`select count(*)::int as n, min(created_by::text) as by from public.rider_adjustments where driver_id = '${D1}' and kind = 'salary'`);
ok("...the salary row is written, by the requester", sal.n === 1 && sal.by === M);
ok("...every row is attached to the payout", (await one(`select count(*)::int as n from public.rider_adjustments where driver_id = '${D1}' and payout_id is null`)).n === 0);
ok("...and both steps are audited", (await audits("payment.approve")) === 1);
r = await srv(`select public.ops_decide_payment_request('${M2}','${REQ}','approve','UTR1','2026-10-05',12500,null,'d5') as s`);
ok("replaying the approval pays nothing twice",
  r.ok && r.rows[0].s.replayed === true && (await one(`select count(*)::int as n from public.rider_payouts where driver_id = '${D1}'`)).n === 1);
ok("deciding it again → already_decided",
  fails(await srv(`select public.ops_decide_payment_request('${M2}','${REQ}','reject',null,null,null,'Oops','d6')`), /already_decided/));

r = await srv(`select public.ops_request_rider_payout('${M}','${D2}','2026-09-30','cash',3000,null,'p6') as s`);
const REQ2 = r.rows[0].s.request_id;
ok("reject without a note → note_required",
  fails(await srv(`select public.ops_decide_payment_request('${M2}','${REQ2}','reject',null,null,null,null,'d7')`), /note_required/));
ok("someone else cannot cancel it",
  fails(await srv(`select public.ops_decide_payment_request('${M2}','${REQ2}','cancel',null,null,null,null,'d8')`), /not_requester/));
r = await srv(`select public.ops_decide_payment_request('${M}','${REQ2}','cancel',null,null,null,'Wrong period','d10') as s`);
ok("the requester cancels their own pending request", r.ok && r.rows[0].s.status === "cancelled", r.msg);

ok("record_rider_payout still works for an admin",
  !!(await srv(`select public.ops_add_rider_adjustment('${A}','${D2}','bonus',200,'Bonus','2026-09-20',null,'b2')`)).ok &&
  (await as("authenticated", A, `select public.record_rider_payout('${D2}','2026-09-30','cash',null,'2026-10-02',null)`)).ok);
ok("...and refuses a manager", fails(await as("authenticated", M, `select public.record_rider_payout('${D2}','2026-09-30','cash',null,'2026-10-02',null)`), /forbidden/));

console.log("\n── who reads payment requests ──");
const cnt = async (uid) => { const x = await as("authenticated", uid, `select count(*)::int as n from public.payment_requests`); return x.ok ? x.rows[0].n : x.msg; };
ok("zone A manager reads zone A requests", (await cnt(M)) === 2);
ok("zone B manager reads only zone B's (the admin's request for a zone-B rider)", (await cnt(MB)) === 1);
ok("nobody signed in writes them", fails(await as("authenticated", A, `update public.payment_requests set note = 'x'`), /permission denied/));

console.log("\n── cash deposits and disputes ──");
await db.exec(`insert into public.cash_deposits (id, driver_id, amount, method) values ('${id(801)}','${D2}', 2400, 'cash'), ('${id(802)}','${D2}', 600, 'upi');
  insert into public.cash_disputes (id, driver_id, day, claimed_amount, message) values ('${id(811)}','${D2}','2026-10-20', 1800, 'My count is 1800');`);
r = await srv(`select public.ops_decide_cash_deposit('${M}','${id(801)}','confirm',null,null,'c1') as s`);
ok("confirming a deposit", r.ok && r.rows[0].s.status === "confirmed", r.msg);
const dep = await one(`select handover_id, decided_by from public.cash_deposits where id = '${id(801)}'`);
const ho = dep.handover_id ? await one(`select leg, amount, zone_id, from_user, to_user from public.cod_handovers where id = '${dep.handover_id}'`) : null;
ok("...writes the rider→manager handover in the rider's zone",
  ho && ho.leg === "rider_to_manager" && ho.amount === 2400 && ho.zone_id === ZA && ho.from_user === D2 && ho.to_user === M, JSON.stringify(ho));
ok("dispute without a note → note_required",
  fails(await srv(`select public.ops_decide_cash_deposit('${M}','${id(802)}','dispute',null,null,'c2')`), /note_required/));
r = await srv(`select public.ops_decide_cash_deposit('${M}','${id(802)}','dispute','UPI reference not found',null,'c3') as s`);
ok("dispute with a note", r.ok && r.rows[0].s.status === "disputed", r.msg);
ok("deciding a decided deposit → already_decided",
  fails(await srv(`select public.ops_decide_cash_deposit('${M}','${id(801)}','dispute','x y z',null,'c4')`), /already_decided/));
await db.exec(`insert into public.cash_deposits (id, driver_id, amount, method) values ('${id(803)}','${D2}', 100, 'cash')`);
ok("confirming into a zone that is not the rider's → forbidden",
  fails(await srv(`select public.ops_decide_cash_deposit('${A}','${id(803)}','confirm',null,'${ZB}','c5')`), /forbidden/));
ok("a zone-B manager cannot decide it",
  fails(await srv(`select public.ops_decide_cash_deposit('${MB}','${id(803)}','confirm',null,null,'c6')`), /forbidden/));
ok("resolving a dispute with too short a text → reason_required",
  fails(await srv(`select public.ops_resolve_cash_dispute('${M}','${id(811)}','ok','r1')`), /reason_required/));
r = await srv(`select public.ops_resolve_cash_dispute('${M}','${id(811)}','Recounted: 1800 is right, ledger corrected','r2') as s`);
ok("resolving a dispute", r.ok && r.rows[0].s.status === "resolved", r.msg);
ok("resolving it again → already_resolved",
  fails(await srv(`select public.ops_resolve_cash_dispute('${M}','${id(811)}','Again and again','r3')`), /already_resolved/));

console.log("\n── delivery exceptions ──");
await db.exec(`insert into public.orders (id, customer_id, restaurant_id, status, total) values ('${id(3101)}','${C}','${R1}','on_the_way',300);
  insert into public.deliveries (id, order_id, driver_id, status, assigned_at, picked_up_at, correction_reason) values ('${id(3201)}','${id(3101)}','${D2}','picked_up', now(), now(), 'fixture: seeded in this state (0082 admits a recorded correction)');
  insert into public.delivery_exceptions (id, delivery_id, order_id, driver_id, kind, reason) values
    ('${id(901)}','${id(3201)}','${id(3101)}','${D2}','customer_unreachable','Called 3 times'),
    ('${id(902)}','${id(3201)}','${id(3101)}','${D2}','vendor_delay','Waited 25 minutes');`);
ok("approving a report kind → invalid_transition",
  fails(await srv(`select public.ops_decide_delivery_exception('${M}','${id(902)}','approve',null,'e1')`), /invalid_transition/));
r = await srv(`select public.ops_decide_delivery_exception('${M}','${id(902)}','acknowledge',null,'e2') as s`);
ok("acknowledging a report", r.ok && r.rows[0].s.status === "acknowledged", r.msg);
ok("rejecting a request without a note → note_required",
  fails(await srv(`select public.ops_decide_delivery_exception('${M}','${id(901)}','reject',null,'e3')`), /note_required/));
r = await srv(`select public.ops_decide_delivery_exception('${M}','${id(901)}','approve','Customer phone off','e4') as s`);
ok("approving a request returns what the server needs for the effects",
  r.ok && r.rows[0].s.status === "approved" && r.rows[0].s.kind === "customer_unreachable" && r.rows[0].s.order_id === id(3101), r.msg);
ok("...writes the exception_decided event",
  (await one(`select count(*)::int as n from public.delivery_events where delivery_id = '${id(3201)}' and kind = 'exception_decided'`)).n === 2);
ok("...and lets the delivery fail now",
  (await srv(`update public.deliveries set status = 'failed', failure_reason = 'customer_unreachable' where id = '${id(3201)}'`)).ok);
r = await srv(`select public.ops_decide_delivery_exception('${M}','${id(901)}','approve','Customer phone off','e4') as s`);
ok("replaying the decision returns it again, marked replayed", r.ok && r.rows[0].s.replayed === true && r.rows[0].s.status === "approved", r.msg);
ok("deciding it again → already_resolved",
  fails(await srv(`select public.ops_decide_delivery_exception('${M}','${id(901)}','reject','Changed mind','e5')`), /already_resolved/));
await db.exec(`insert into public.delivery_exceptions (id, delivery_id, order_id, driver_id, kind, reason) values ('${id(903)}','${id(3201)}','${id(3101)}','${D2}','missing_items','Short one item')`);
ok("a zone-B manager cannot decide zone A's exceptions",
  fails(await srv(`select public.ops_decide_delivery_exception('${MB}','${id(903)}','acknowledge',null,'e6')`), /forbidden/));

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
