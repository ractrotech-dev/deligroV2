// Runs migration 0186 (one-admin payments on by default) in PGlite on top of
// finance-base.mjs: an admin pays alone with a reason, on the record; a manager
// still cannot approve their own request; a plain update still can't flip it.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0186.mjs
import { financeBase, harness, readMigration, id, IDS } from "./finance-base.mjs";

const { db } = await financeBase();
const { A, M } = IDS;
const D1 = id(601), D2 = id(602);

await db.exec(`
  insert into public.profiles (id, role, full_name) values ('${D1}','driver','Ravi'), ('${D2}','driver','Asha');
  insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by)
    values ('${D1}','salary',1000,'October','2026-09-30','${A}'), ('${D2}','salary',500,'October','2026-09-30','${A}');
`);

const { ok, srv, one, fails, done } = harness(db);
const on = async () => (await one(`select allow_single_admin_payments as x from public.platform_settings`)).x;
const audits = async () => (await one(`select count(*)::int as n from public.ops_audit_log where action = 'settings.single_admin_payments'`)).n;

ok("before: the switch is off", (await on()) === false);
await db.exec(readMigration("0186_single_admin_payments_on.sql"));
ok("after: the switch is on", (await on()) === true);
ok("...the column defaults on too", (await one(`select column_default as d from information_schema.columns where table_name = 'platform_settings' and column_name = 'allow_single_admin_payments'`)).d === "true");
ok("...and the change is in the audit log", (await audits()) === 1);

await db.exec(readMigration("0186_single_admin_payments_on.sql"));
ok("running it again writes nothing new", (await audits()) === 1);

ok("a plain update still can't flip the switch",
  fails(await srv(`update public.platform_settings set allow_single_admin_payments = false`), /ops_set_single_admin_payments/));

let r = await srv(`select public.ops_request_rider_payout('${A}','${D1}','2026-09-30','bank',null,null,'a-req') as s`);
ok("an admin asks to pay", r.ok, r.msg);
const REQ = r.rows?.[0].s.request_id;
ok("...their own approval still needs a reason",
  fails(await srv(`select public.ops_decide_payment_request('${A}','${REQ}','approve','UPI1','2026-10-02',null,null,'a-1')`), /reason_required/));
r = await srv(`select public.ops_decide_payment_request('${A}','${REQ}','approve','UPI1','2026-10-02',null,'October salary','a-2') as s`);
ok("...with one, the admin pays alone", r.ok && r.rows[0].s.status === "approved" && r.rows[0].s.self_approved === true, r.msg);
const log = await one(`select actor_id, reason, after from public.ops_audit_log where action = 'payment.approve' and client_action_id = 'a-2'`);
ok("...who and why are on the record", log.actor_id === A && log.reason === "October salary" && log.after.self_approved === true);

ok("the reference is still required",
  fails(await srv(`select public.ops_decide_payment_request('${A}','${REQ}','approve',null,null,null,'x y z','a-3')`), /already_decided|reference_required/));

r = await srv(`select public.ops_request_rider_payout('${M}','${D2}','2026-09-30','bank',null,null,'m-req') as s`);
if (r.ok) {
  const MREQ = r.rows[0].s.request_id;
  ok("a manager still can't approve their own request",
    fails(await srv(`select public.ops_decide_payment_request('${M}','${MREQ}','approve','UPI2','2026-10-02',null,'Please','m-1')`), /same_person/));
  r = await srv(`select public.ops_decide_payment_request('${A}','${MREQ}','approve','UPI2','2026-10-02',null,null,'a-4') as s`);
  ok("...an admin approves a manager's request, marked as not their own", r.ok && r.rows[0].s.self_approved === false, r.msg);
} else {
  ok("a manager in scope can ask (test setup)", false, r.msg);
}

r = await srv(`select public.ops_set_single_admin_payments('${A}', false, 'Testing off', 'off-1') as s`);
ok("it can still be turned off, with a reason", r.ok && (await on()) === false && (await audits()) === 2, r.msg);

done();
