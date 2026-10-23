// Runs migration 0156 (maker–checker vendor settlements, audited settlement
// voids and refund decisions) in PGlite on top of finance-base.mjs + 0155.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0156.mjs
import { financeBase, harness, readMigration, id, IDS } from "./finance-base.mjs";

const { db, ZA, M2 } = await financeBase();
const { A, M, MB, C, R1, R2 } = IDS;
const A2 = id(21);
const O1 = id(201), O2 = id(202), O3 = id(203), OB = id(204);
const S1 = id(301), S2 = id(302), S3 = id(303), SB = id(304), SNEG = id(305), SNEW = id(306);

await db.exec(`
  insert into public.profiles (id, role, full_name) values ('${A2}','admin','Second Admin');
  update public.restaurants set zone_id = '${ZA}' where id = '${R1}';
  insert into public.orders (id, customer_id, restaurant_id, status, total, payment_method, payment_status) values
    ('${O1}','${C}','${R1}','delivered',520,'online','paid'), ('${O2}','${C}','${R1}','delivered',300,'online','paid'),
    ('${O3}','${C}','${R1}','delivered',200,'cod','paid'), ('${OB}','${C}','${R2}','delivered',400,'online','paid');
  insert into public.vendor_settlements (id, restaurant_id, period_start, period_end, net_payable, status, created_by) values
    ('${S1}','${R1}','2026-10-01','2026-10-08',15064,'draft','${M}'),
    ('${S2}','${R1}','2026-10-08','2026-10-15',400,'draft','${M}'),
    ('${SB}','${R2}','2026-10-01','2026-10-08',900,'draft','${MB}'),
    ('${SNEG}','${R1}','2026-09-01','2026-09-08',-340,'draft','${M}');
  insert into public.vendor_settlement_orders (settlement_id, order_id, contribution) values ('${S1}','${O1}',370), ('${S2}','${O2}',250);
  insert into public.settlement_corrections (restaurant_id, order_id, original_settlement_id, applied_settlement_id, amount, status, created_by)
    values ('${R1}','${O3}','${SNEG}','${S2}',120,'applied','${A}');
  insert into public.refunds (id, order_id, amount, status) values ('${id(401)}','${O1}',120,'pending'), ('${id(402)}','${OB}',50,'pending');
`);
await db.exec(readMigration("0155_manager_finance_reads.sql"));
await db.exec(readMigration("0156_settlement_requests_and_money_decisions.sql"));

const { ok, as, fails, srv, one, done } = harness(db);
const audits = async (action) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}'`)).n;
const st = async (s) => (await one(`select status::text as s, paid_by, payment_ref, net_payable from public.vendor_settlements where id = '${s}'`));

console.log("\n── request ──");
let r = await srv(`select public.ops_request_vendor_settlement('${M}','${S1}','bank','Week 40','vs1') as s`);
ok("M requests their draft (15064)", r.ok && r.rows[0].s.status === "pending_approval" && Number(r.rows[0].s.amount) === 15064
  && r.rows[0].s.settlement_id === S1, r.msg);
const REQ = r.ok ? r.rows[0].s.request_id : null;
ok("...audited as payment.request", (await audits("payment.request")) === 1);
r = await srv(`select public.ops_request_vendor_settlement('${M}','${S1}','bank','Week 40','vs1') as s`);
ok("replaying the same client action returns the same request", r.ok && r.rows[0].s.request_id === REQ && r.rows[0].s.replayed === true, r.msg);
ok("a second pending request for the shop → duplicate_pending",
  fails(await srv(`select public.ops_request_vendor_settlement('${M}','${S2}','bank',null,'vs2')`), /duplicate_pending/));
ok("a manager cannot request someone else's draft",
  fails(await srv(`select public.ops_request_vendor_settlement('${M2}','${SNEG}','bank',null,'vs3')`), /forbidden/));
ok("negative net → negative_net",
  fails(await srv(`select public.ops_request_vendor_settlement('${M}','${SNEG}','bank',null,'vs4')`), /negative_net/));
ok("a zone-B manager cannot request a zone-A draft",
  fails(await srv(`select public.ops_request_vendor_settlement('${MB}','${S2}','bank',null,'vs5')`), /forbidden/));
ok("an invalid method → invalid_method",
  fails(await srv(`select public.ops_request_vendor_settlement('${MB}','${SB}','cheque',null,'vs6')`), /invalid_method/));
ok("a signed-in user cannot call it at all",
  fails(await (async () => { await db.exec("set role authenticated"); try { await db.query(`select public.ops_request_vendor_settlement('${M}','${S2}','bank',null,'x')`); return { ok: true }; } catch (e) { return { ok: false, msg: String(e.message) }; } finally { await db.exec("reset role"); } })(), /permission denied/));

console.log("\n── decide ──");
ok("the requester approving → same_person",
  fails(await srv(`select public.ops_decide_payment_request('${M}','${REQ}','approve','UTR1',null,null,null,'vd1')`), /same_person/));
ok("approval without a reference → reference_required",
  fails(await srv(`select public.ops_decide_payment_request('${M2}','${REQ}','approve',null,null,null,null,'vd2')`), /reference_required/));
ok("a zone-B manager cannot decide it",
  fails(await srv(`select public.ops_decide_payment_request('${MB}','${REQ}','approve','UTR1',null,null,null,'vd3')`), /forbidden/));
await db.exec(`update public.vendor_settlements set net_payable = 14944 where id = '${S1}'`);
r = await srv(`select public.ops_decide_payment_request('${M2}','${REQ}','approve','UTR1',null,null,null,'vd4')`);
ok("the draft changed under the request → amount_changed 14944", !r.ok && /amount_changed/.test(r.msg) && r.detail === "14944", `${r.msg} ${r.detail}`);
ok("...and nothing was paid", (await st(S1)).s === "draft");
r = await srv(`select public.ops_decide_payment_request('${M2}','${REQ}','approve','UTR1',null,14944,'Checked','vd5') as s`);
ok("confirming 14944 pays it", r.ok && r.rows[0].s.status === "approved" && Number(r.rows[0].s.amount) === 14944, r.msg);
const paid = await st(S1);
ok("settlement paid, paid_by the checker, with the reference", paid.s === "paid" && paid.paid_by === M2 && paid.payment_ref === "UTR1");
ok("...one approval audit row", (await audits("payment.approve")) === 1);
r = await srv(`select public.ops_decide_payment_request('${M2}','${REQ}','approve','UTR1',null,14944,'Checked','vd5') as s`);
ok("replay → same approved state, replayed", r.ok && r.rows[0].s.replayed === true && (await audits("payment.approve")) === 1, r.msg);
ok("deciding it again → already_decided",
  fails(await srv(`select public.ops_decide_payment_request('${A}','${REQ}','reject',null,null,null,'late','vd6')`), /already_decided/));

console.log("\n── reject, cancel, admin ──");
r = await srv(`select public.ops_request_vendor_settlement('${M}','${S2}','upi',null,'vs7') as s`);
const REQ2 = r.ok ? r.rows[0].s.request_id : null;
ok("M requests the second draft (400)", r.ok, r.msg);
ok("reject without a note → note_required",
  fails(await srv(`select public.ops_decide_payment_request('${M2}','${REQ2}','reject',null,null,null,null,'vd7')`), /note_required/));
r = await srv(`select public.ops_decide_payment_request('${M2}','${REQ2}','reject',null,null,null,'Wrong bank','vd8') as s`);
ok("reject → request rejected", r.ok && r.rows[0].s.status === "rejected", r.msg);
ok("...its draft is void and its lines are gone", (await st(S2)).s === "void"
  && (await one(`select count(*)::int as n from public.vendor_settlement_orders where settlement_id = '${S2}'`)).n === 0);
ok("...the correction it had absorbed is outstanding again",
  (await one(`select status::text as s, applied_settlement_id from public.settlement_corrections where order_id = '${O3}'`)).s === "outstanding");
r = await srv(`select public.ops_request_vendor_settlement('${A}','${SB}','bank',null,'vs9') as s`);
const REQB = r.ok ? r.rows[0].s.request_id : null;
ok("an admin may request any draft in any zone", r.ok, r.msg);
ok("the admin approving their own request → same_person",
  fails(await srv(`select public.ops_decide_payment_request('${A}','${REQB}','approve','UTRA',null,null,null,'vd9')`), /same_person/));
ok("someone else cancelling it → not_requester",
  fails(await srv(`select public.ops_decide_payment_request('${A2}','${REQB}','cancel',null,null,null,null,'vd10')`), /not_requester/));
ok("a decision reusing the id of a different action → client_action_id_conflict",
  fails(await srv(`select public.ops_decide_payment_request('${A}','${REQB}','approve','UTRA',null,null,'x','vs9')`), /client_action_id_conflict/));
console.log("\n── one-admin switch (0152's rule, shared) ──");
r = await srv(`select public.ops_set_single_admin_payments('${A}', true, 'Only one admin this month', 'sa56')`);
ok("an admin turns the one-admin switch on", r.ok, r.msg);
ok("switch on, admin approving own vendor request without a reason → reason_required",
  fails(await srv(`select public.ops_decide_payment_request('${A}','${REQB}','approve','UTRA',null,null,null,'vd9b')`), /reason_required/));
r = await srv(`select public.ops_decide_payment_request('${A}','${REQB}','approve','UTRA',null,null,'Sole admin, paid by bank','vd11') as s`);
ok("switch on, admin self-approves the vendor settlement with a reason",
  r.ok && r.rows[0].s.self_approved === true && (await st(SB)).s === "paid" && (await st(SB)).paid_by === A, r.msg);
ok("...the audit row is marked self_approved",
  (await one(`select (after->>'self_approved')::boolean as x from public.ops_audit_log where client_action_id = 'vd11'`)).x === true);
r = await srv(`select public.ops_set_single_admin_payments('${A}', false, 'Second admin joined', 'sa57')`);
ok("the switch goes back off", r.ok, r.msg);
ok("no one-person path: there is no ops_mark_settlement_paid",
  (await one(`select count(*)::int as n from pg_proc where proname = 'ops_mark_settlement_paid'`)).n === 0);

console.log("\n── stale draft: detach, rebuild, repoint ──");
await db.exec(`insert into public.vendor_settlements (id, restaurant_id, period_start, period_end, net_payable, status, created_by)
  values ('${S3}','${R1}','2026-10-15','2026-10-22',700,'draft','${M}');
  insert into public.vendor_settlement_orders (settlement_id, order_id, contribution) values ('${S3}','${O2}',700);`);
r = await srv(`select public.ops_request_vendor_settlement('${M}','${S3}','bank',null,'vs12') as s`);
const REQ3 = r.ok ? r.rows[0].s.request_id : null;
r = await srv(`select public.ops_detach_stale_settlement('${M2}','${REQ3}','dt1') as s`);
ok("detach voids the stale draft and frees its orders", r.ok && (await st(S3)).s === "void"
  && (await one(`select count(*)::int as n from public.vendor_settlement_orders where order_id = '${O2}'`)).n === 0, r.msg);
ok("...returns the period to rebuild", r.ok && r.rows[0].s.restaurant_id === R1 && r.rows[0].s.kind === "batch", r.msg);
ok("approving while it is rebuilding → rebuilding",
  fails(await srv(`select public.ops_decide_payment_request('${M2}','${REQ3}','approve','UTR3',null,null,null,'vd12')`), /rebuilding/));
await db.exec(`insert into public.vendor_settlements (id, restaurant_id, period_start, period_end, net_payable, status, created_by)
  values ('${SNEW}','${R1}','2026-10-15','2026-10-22',580,'draft','${M2}');`);
r = await srv(`select public.ops_repoint_settlement_request('${M2}','${REQ3}','${SNEW}','rp1') as s`);
ok("repoint attaches the rebuilt draft with its amount (580)", r.ok && r.rows[0].s.settlement_id === SNEW && Number(r.rows[0].s.amount) === 580, r.msg);
ok("...audited", (await audits("payment.repoint")) === 1 && (await audits("payment.detach")) === 1);
r = await srv(`select public.ops_decide_payment_request('${M2}','${REQ3}','approve','UTR3',null,null,null,'vd13') as s`);
ok("the checker then approves the rebuilt draft", r.ok && (await st(SNEW)).s === "paid", r.msg);

console.log("\n── void ──");
await db.exec(`insert into public.vendor_settlements (id, restaurant_id, period_start, period_end, net_payable, status, created_by)
  values ('${id(307)}','${R1}','2026-08-01','2026-08-08',100,'draft','${M}');`);
ok("a manager cannot void a paid settlement",
  fails(await srv(`select public.ops_void_settlement('${M}','${S1}','Mistake','vv1')`), /paid_settlement|forbidden/));
ok("an admin cannot void a paid settlement either",
  fails(await srv(`select public.ops_void_settlement('${A}','${S1}','Mistake','vv2')`), /paid_settlement/));
await db.exec(`insert into public.vendor_settlements (id, restaurant_id, period_start, period_end, net_payable, status, created_by, kind, paid_at, paid_by, payment_ref)
  values ('${id(308)}','${R1}','2026-07-01','2026-07-02',90,'paid','${M}','instant', now(), '${M2}', 'UTRI');
  insert into public.vendor_settlement_orders (settlement_id, order_id, contribution) values ('${id(308)}','${O3}',90);`);
ok("an admin cannot void a paid INSTANT payout either (reversing it needs two people)",
  fails(await srv(`select public.ops_void_settlement('${A}','${id(308)}','Bounced','vv2b')`), /paid_settlement/));
ok("void needs a reason", fails(await srv(`select public.ops_void_settlement('${M}','${id(307)}','','vv3')`), /reason_required/));
ok("another manager cannot void M's draft", fails(await srv(`select public.ops_void_settlement('${M2}','${id(307)}','Mine now','vv4')`), /forbidden/));
r = await srv(`select public.ops_void_settlement('${M}','${id(307)}','Built for the wrong week','vv5') as s`);
ok("M voids their own unrequested draft, audited", r.ok && (await st(id(307))).s === "void" && (await audits("settlement.void")) === 1, r.msg);

console.log("\n── reversing a paid settlement (maker–checker) ──");
const SI = id(308);
ok("a reversal needs a reason",
  fails(await srv(`select public.ops_request_settlement_reversal('${M}','${SI}','','rv0')`), /reason_required/));
ok("a voided draft cannot be reversed",
  fails(await srv(`select public.ops_request_settlement_reversal('${M}','${id(307)}','Bounced','rv0b')`), /not_paid/));
r = await srv(`select public.ops_request_settlement_reversal('${M}','${SI}','Bank returned the transfer UTRI','rv1') as s`);
ok("M asks to reverse the paid instant payout", r.ok && r.rows[0].s.kind === "settlement_reversal" && r.rows[0].s.status === "pending_approval", r.msg);
const RREV = r.ok ? r.rows[0].s.request_id : null;
ok("...the payout is still paid until someone else approves", (await st(SI)).s === "paid");
ok("a second reversal request for it → duplicate_pending",
  fails(await srv(`select public.ops_request_settlement_reversal('${A}','${SI}','Again','rv2')`), /duplicate_pending/));
ok("M approving their own reversal → same_person",
  fails(await srv(`select public.ops_decide_payment_request('${M}','${RREV}','approve',null,null,null,'ok','rv3')`), /same_person/));
r = await srv(`select public.ops_decide_payment_request('${M2}','${RREV}','approve',null,null,null,'Confirmed with the bank','rv4') as s`);
ok("M2 approves: the payout is void and its order can be paid again", r.ok && (await st(SI)).s === "void"
  && (await one(`select count(*)::int as n from public.vendor_settlement_orders where settlement_id = '${SI}'`)).n === 0, r.msg);
ok("...audited as settlement.reverse", (await audits("settlement.reverse")) === 1);
ok("reversing it again → not_paid",
  fails(await srv(`select public.ops_request_settlement_reversal('${M}','${SI}','Again','rv5')`), /not_paid/));

console.log("\n── a refund approved after the draft was built makes approval stale ──");
const O4 = id(205), S4 = id(309);
await db.exec(`insert into public.orders (id, customer_id, restaurant_id, status, total, payment_method, payment_status) values ('${O4}','${C}','${R1}','delivered',260,'online','paid');
  insert into public.vendor_settlements (id, restaurant_id, period_start, period_end, net_payable, status, created_by) values ('${S4}','${R1}','2026-06-01','2026-06-08',210,'draft','${M}');
  insert into public.vendor_settlement_orders (settlement_id, order_id, contribution, refund_recovered) values ('${S4}','${O4}',210,0);`);
r = await srv(`select public.ops_request_vendor_settlement('${M}','${S4}','bank',null,'st1') as s`);
const REQ4 = r.ok ? r.rows[0].s.request_id : null;
await db.exec(`insert into public.refunds (id, order_id, amount, status) values ('${id(403)}','${O4}',60,'approved');`);
ok("approving a draft whose order gained a refund → stale_draft",
  fails(await srv(`select public.ops_decide_payment_request('${M2}','${REQ4}','approve','UTR4',null,null,null,'st2')`), /stale_draft/));
ok("...nothing was paid", (await st(S4)).s === "draft");

console.log("\n── refund claims: one gateway call per refund ──");
await db.exec(`insert into public.refunds (id, order_id, amount, status) values ('${id(404)}','${O2}',40,'pending');`);
const RF = id(404);
r = await srv(`select public.ops_claim_refund('${M}','${RF}') as s`);
ok("the first claim is fresh", r.ok && r.rows[0].s.state === "fresh", r.msg);
r = await srv(`select public.ops_claim_refund('${M2}','${RF}') as s`);
ok("a second claim while the first is out → held", r.ok && r.rows[0].s.state === "held", r.msg);
ok("deciding a refund someone else has claimed → in_progress",
  fails(await srv(`select public.ops_decide_refund('${M2}','${RF}','deny','Not needed',null,null,'cl1')`), /in_progress/));
r = await srv(`select public.ops_record_refund_gateway('${M}','${RF}','rfnd_9', null) as s`);
ok("the claimer records the gateway refund id before deciding", r.ok, r.msg);
ok("...the refund is still pending, with the id", (await one(`select status::text as s, provider_refund_id as g from public.refunds where id = '${RF}'`)).g === "rfnd_9");
r = await srv(`select public.ops_claim_refund('${M}','${RF}') as s`);
ok("claiming again after the gateway paid → resume (no second gateway call)", r.ok && r.rows[0].s.state === "resume" && r.rows[0].s.provider_refund_id === "rfnd_9", r.msg);
ok("a claim whose money already went cannot be released",
  fails(await srv(`select public.ops_release_refund_claim('${A}','${RF}','Checked','cl2')`), /gateway_paid/));
ok("money the gateway returned cannot be denied",
  fails(await srv(`select public.ops_decide_refund('${M}','${RF}','deny','Changed mind',null,null,'cl2b')`), /gateway_paid/));
r = await srv(`select public.ops_decide_refund('${M2}','${RF}','approve','Item missing','rfnd_9', now(),'cl3') as s`);
ok("once the gateway paid, anyone in scope may finish recording it; the claim is cleared", r.ok
  && (await one(`select claimed_at from public.refunds where id = '${RF}'`)).claimed_at === null, r.msg);
await db.exec(`insert into public.refunds (id, order_id, amount, status) values ('${id(405)}','${O2}',10,'pending');`);
await srv(`select public.ops_claim_refund('${M}','${id(405)}')`);
ok("a manager cannot release someone else's unresolved claim",
  fails(await srv(`select public.ops_release_refund_claim('${M2}','${id(405)}','Stuck','cl4')`), /forbidden/));
r = await srv(`select public.ops_release_refund_claim('${A}','${id(405)}','Checked Razorpay: nothing was sent','cl5') as s`);
ok("an admin releases an unresolved claim (no gateway id) with a reason, audited", r.ok
  && (await one(`select claimed_at from public.refunds where id = '${id(405)}'`)).claimed_at === null
  && (await audits("refund.release")) === 1, r.msg);
ok("the refund decision locks the order's settlement row",
  /for update/i.test((await one(`select prosrc from pg_proc where proname = 'ops_decide_refund'`)).prosrc));

console.log("\n── a refund that completes the order marks it refunded — in the same transaction (review #20) ──");
const OF = id(231), OC = id(232);
await db.exec(`
  insert into public.orders (id, customer_id, restaurant_id, status, total, payment_method, payment_status) values
    ('${OF}','${C}','${R1}','delivered',300,'online','paid'), ('${OC}','${C}','${R1}','delivered',200,'cod','paid');
  insert into public.payments (order_id, provider, provider_order_id, provider_payment_id, amount_paise, status)
    values ('${OF}','razorpay','order_x','pay_x',30000,'paid');
  insert into public.refunds (id, order_id, amount, status) values ('${id(411)}','${OF}',100,'pending'), ('${id(413)}','${OC}',200,'pending');
`);
r = await srv(`select public.ops_decide_refund('${M}','${id(411)}','approve','Item missing','rfnd_p1', now(),'rfp1')`);
ok("a partial refund leaves the order and its gateway payment as they were",
  r.ok && (await one(`select payment_status::text as s from public.orders where id = '${OF}'`)).s === "paid"
  && (await one(`select status::text as s from public.payments where order_id = '${OF}'`)).s === "paid", r.msg);
await db.exec(`insert into public.refunds (id, order_id, amount, status) values ('${id(412)}','${OF}',200,'pending')`);
r = await srv(`select public.ops_decide_refund('${M}','${id(412)}','approve','Rest of the order','rfnd_p2', now(),'rfp2')`);
ok("the refund that brings the approved total up to the order total marks both refunded, with the decision",
  r.ok && (await one(`select payment_status::text as s from public.orders where id = '${OF}'`)).s === "refunded"
  && (await one(`select status::text as s from public.payments where order_id = '${OF}'`)).s === "refunded", r.msg);
r = await srv(`select public.ops_decide_refund('${M}','${id(413)}','approve','Cash back','',null,'rfp3')`);
ok("a cash order, with no gateway payment, is left alone", r.ok && (await one(`select payment_status::text as s from public.orders where id = '${OC}'`)).s === "paid", r.msg);

console.log("\n── a settlement correction is recorded with its audit row (review #20) ──");
const OP = id(241), SP = id(342), SDR = id(343);
await db.exec(`
  insert into public.orders (id, customer_id, restaurant_id, status, total, payment_method, payment_status) values ('${OP}','${C}','${R1}','delivered',400,'online','paid');
  insert into public.vendor_settlements (id, restaurant_id, period_start, period_end, net_payable, status, created_by, paid_by, paid_at)
    values ('${SP}','${R1}','2026-09-01','2026-09-08',300,'paid','${A}','${A}', now()),
           ('${SDR}','${R1}','2026-09-08','2026-09-15',100,'draft','${M}',null,null);
  insert into public.vendor_settlement_orders (settlement_id, order_id, contribution) values ('${SP}','${OP}',300);
  insert into public.refunds (id, order_id, amount, status) values ('${id(421)}','${OP}',100,'approved');
  insert into public.refunds (id, order_id, amount, status) values ('${id(422)}','${O3}',50,'pending');
`);
r = await srv(`select public.ops_record_settlement_correction('${M}','${OP}','${id(421)}','${SP}',100,'Refund reduced the food value after payout','sc1') as c`);
ok("a correction is created with the audit row, in one call",
  r.ok && r.rows[0].c.replayed === false
  && (await one(`select count(*)::int as n from public.settlement_corrections where order_id = '${OP}' and refund_id = '${id(421)}' and amount = 100 and created_by = '${M}' and status::text = 'outstanding'`)).n === 1
  && (await audits("settlement.correction")) === 1, r.msg);
r = await srv(`select public.ops_record_settlement_correction('${M}','${OP}','${id(421)}','${SP}',100,'Refund reduced the food value after payout','sc1') as c`);
ok("a replay adds nothing", r.ok && r.rows[0].c.replayed === true
  && (await one(`select count(*)::int as n from public.settlement_corrections where order_id = '${OP}'`)).n === 1 && (await audits("settlement.correction")) === 1, r.msg);
ok("a draft settlement needs no correction (it is rebuilt) → invalid_transition",
  fails(await srv(`select public.ops_record_settlement_correction('${M}','${OP}','${id(421)}','${SDR}',100,'x y z','sc2')`), /invalid_transition/));
ok("a refund that is not approved → invalid_transition",
  fails(await srv(`select public.ops_record_settlement_correction('${M}','${O3}','${id(422)}','${SP}',50,'x y z','sc3')`), /invalid_transition/));
ok("an amount of 0 → bad_request",
  fails(await srv(`select public.ops_record_settlement_correction('${M}','${OP}','${id(421)}','${SP}',0,'x y z','sc4')`), /bad_request/));
ok("a manager of another zone → forbidden",
  fails(await srv(`select public.ops_record_settlement_correction('${MB}','${OP}','${id(421)}','${SP}',100,'x y z','sc5')`), /forbidden/));
ok("not callable by a signed-in user",
  fails(await as("authenticated", M, `select public.ops_record_settlement_correction('${M}','${OP}','${id(421)}','${SP}',100,'x y z','sc6')`), /permission denied/));

console.log("\n── refunds ──");
r = await srv(`select public.ops_decide_refund('${M}','${id(401)}','approve','Item missing','rfnd_1', now(),'rf1') as s`);
ok("zone-A manager approves a zone-A refund", r.ok && r.rows[0].s.status === "approved", r.msg);
const rf = await one(`select status::text as s, decided_by, decided_at, provider_refund_id from public.refunds where id = '${id(401)}'`);
ok("...decided_by, decided_at and the gateway id recorded", rf.s === "approved" && rf.decided_by === M && rf.decided_at && rf.provider_refund_id === "rfnd_1");
ok("...audited", (await one(`select count(*)::int as n from public.ops_audit_log where action = 'refund.approve' and client_action_id = 'rf1'`)).n === 1);
ok("deciding it again → already_decided",
  fails(await srv(`select public.ops_decide_refund('${M}','${id(401)}','deny','No','',null,'rf2')`), /already_decided/));
ok("a reason is required", fails(await srv(`select public.ops_decide_refund('${MB}','${id(402)}','deny','',null,null,'rf3')`), /reason_required/));
ok("zone-A manager cannot decide a zone-B refund",
  fails(await srv(`select public.ops_decide_refund('${M}','${id(402)}','deny','Not ours',null,null,'rf4')`), /forbidden/));
r = await srv(`select public.ops_decide_refund('${MB}','${id(402)}','deny','Customer withdrew it',null,null,'rf5') as s`);
ok("zone-B manager denies it", r.ok && r.rows[0].s.status === "denied", r.msg);
const direct = await (async () => {
  await db.exec(`set role authenticated; select set_config('test.uid','${A}',false);`);
  try { const q = await db.query(`update public.refunds set status = 'pending' where id = '${id(402)}' returning id`); return q.rows.length; }
  catch { return -1; } finally { await db.exec("reset role; select set_config('test.uid','',false);"); }
})();
ok("an admin's signed-in session can no longer write refunds directly", direct <= 0, String(direct));

console.log("\n── no path edits a paid settlement's money ──");
const bodies = (await one(`select string_agg(prosrc, ' ') as b from pg_proc where proname like 'ops_%settlement%' or proname = 'ops_decide_payment_request' or proname like '_void_settlement%'`)).b ?? "";
ok("no settlement RPC writes net_payable, food_gross or commission", !/set[^;]*\b(net_payable|food_gross|commission)\s*=/i.test(bodies));

done();
