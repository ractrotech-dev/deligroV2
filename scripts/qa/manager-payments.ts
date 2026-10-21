/**
 * QA — maker–checker payouts, cash deposits and disputes (§5.13, §5.14, §7):
 * who may decide a request, body validation, how the RPC errors become pinned
 * answers, and structural rules (approve checks approve_payment, deposits go
 * through ops_decide_cash_deposit, every list is scoped). The live section runs
 * against a dev server when BASE is reachable.
 *
 * Usage: npx tsx scripts/qa/manager-payments.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { canDecide, type Viewer } from "../../src/lib/ops/rider-serialize";
import {
  mapPaymentRpcError,
  parseDecideBody,
  parseDepositDecision,
  parseDisputeResolution,
  parsePayoutRequestBody,
} from "../../src/lib/ops/payment-actions";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}
const ME = randomUUID();
const OTHER = randomUUID();
const viewer = (perms: Record<string, boolean>, isAdmin = false, id = ME): Viewer => ({ id, perms, isAdmin });
const NOW = new Date("2026-10-21T10:00:00.000Z");

console.log("\n── canDecide ──");
const pending = { requestedBy: OTHER, status: "pending_approval" };
check("another manager with approve_payment → true", canDecide(pending, viewer({ "manager.finance.approve_payment": true })));
check("the requester, even with approve_payment → false", !canDecide({ ...pending, requestedBy: ME }, viewer({ "manager.finance.approve_payment": true })));
check("without approve_payment → false", !canDecide(pending, viewer({})));
check("an admin who requested → false", !canDecide({ ...pending, requestedBy: ME }, viewer({}, true)));
check("an admin who did not → true", canDecide(pending, viewer({}, true)));
check("a decided request → false", !canDecide({ ...pending, status: "approved" }, viewer({}, true)));
const withSwitch = (v: Viewer): Viewer => ({ ...v, singleAdminPayments: true });
check("with one-admin payments on, an admin may decide their own request",
  canDecide({ ...pending, requestedBy: ME }, withSwitch(viewer({}, true))));
check("...a manager still may not, even with approve_payment",
  !canDecide({ ...pending, requestedBy: ME }, withSwitch(viewer({ "manager.finance.approve_payment": true }))));

console.log("\n── one-admin payments switch ──");
const pa = readFileSync("src/lib/data-access/payment-approvals.ts", "utf8");
check("the switch changes only through ops_set_single_admin_payments", /ops_set_single_admin_payments/.test(pa));
const paAction = readFileSync("src/app/admin/settings/platform/payment-approvals-actions.ts", "utf8");
check("its server action is admin-only and rate-limited", /requireRole\("admin"\)/.test(paAction) && /rateLimit\(/.test(paAction));
check("a payment request carries selfApproved", /selfApproved/.test(readFileSync("src/lib/ops/rider-serialize.ts", "utf8")));

console.log("\n── bodies ──");
const rid = randomUUID();
let r = parsePayoutRequestBody({ clientActionId: randomUUID(), kind: "rider_payout", riderId: rid, periodEnd: "2026-09-30", method: "bank", salaryAmount: 12000 }, NOW);
check("a payout request", r.ok && r.input.salaryAmount === 12000);
r = parsePayoutRequestBody({ clientActionId: randomUUID(), kind: "rider_payout", riderId: rid, periodEnd: "2026-10-25", method: "bank" }, NOW);
check("periodEnd in the future (IST) → field periodEnd", !r.ok && r.field === "periodEnd");
r = parsePayoutRequestBody({ clientActionId: randomUUID(), kind: "vendor_settlement", riderId: rid, periodEnd: "2026-09-30", method: "bank" }, NOW);
check("kind vendor_settlement is Phase 6's → field kind", !r.ok && r.field === "kind");
r = parsePayoutRequestBody({ clientActionId: randomUUID(), kind: "rider_payout", riderId: rid, periodEnd: "2026-09-30", method: "cheque" }, NOW);
check("an unknown method → field method", !r.ok && r.field === "method");
r = parsePayoutRequestBody({ clientActionId: randomUUID(), kind: "rider_payout", riderId: rid, periodEnd: "2026-09-30", method: "upi", salaryAmount: -1 }, NOW);
check("a negative salary → field salaryAmount", !r.ok && r.field === "salaryAmount");

let d = parseDecideBody({ clientActionId: randomUUID(), decision: "approve", paidOn: "2026-10-05" }, NOW);
check("approve without a reference → reference_required", !d.ok && d.error === "reference_required");
d = parseDecideBody({ clientActionId: randomUUID(), decision: "reject" }, NOW);
check("reject without a note → note_required", !d.ok && d.error === "note_required");
d = parseDecideBody({ clientActionId: randomUUID(), decision: "approve", reference: "UTR123", confirmAmount: 12500 }, NOW);
check("approve with a reference and a confirmed amount", d.ok && d.input.confirmAmount === 12500 && d.input.paidOn === null);
d = parseDecideBody({ clientActionId: randomUUID(), decision: "approve", reference: "UTR123", paidOn: "2026-10-30" }, NOW);
check("paidOn in the future → field paidOn", !d.ok && d.field === "paidOn");
d = parseDecideBody({ clientActionId: randomUUID(), decision: "cancel" }, NOW);
check("cancel needs nothing else", d.ok);

let dep = parseDepositDecision({ clientActionId: randomUUID(), decision: "dispute" });
check("dispute without a note → note_required", !dep.ok && dep.error === "note_required");
dep = parseDepositDecision({ clientActionId: randomUUID(), decision: "confirm" });
check("confirm needs no note", dep.ok);
const res = parseDisputeResolution({ clientActionId: randomUUID(), resolution: "ok" });
check("a 2-character resolution → bad_request", !res.ok);

console.log("\n── errors ──");
const m = (message: string, details?: string, code?: string) => mapPaymentRpcError({ message, details: details ?? null, code });
const amt = m("amount_changed", "12500.00");
check("amount_changed → 409 with the new amount", !amt.ok && amt.status === 409 && (amt.extra as { amount: number }).amount === 12500);
const sp = m("same_person");
check("same_person → 403", !sp.ok && sp.status === 403 && sp.error === "same_person");
check("not_requester → 403", (() => { const x = m("not_requester"); return !x.ok && x.status === 403; })());
check("duplicate_pending → 409", (() => { const x = m("duplicate_pending"); return !x.ok && x.status === 409; })());
check("nothing_to_pay → 409", (() => { const x = m("nothing_to_pay"); return !x.ok && x.status === 409; })());
check("reference_required → 400", (() => { const x = m("reference_required"); return !x.ok && x.status === 400; })());
check("note_required → 400", (() => { const x = m("note_required"); return !x.ok && x.status === 400; })());
check("already_decided → 409", (() => { const x = m("already_decided"); return !x.ok && x.status === 409; })());
check("forbidden → 404", (() => { const x = m("forbidden", undefined, "42501"); return !x.ok && x.status === 404; })());

console.log("\n── structural ──");
const decide = readFileSync("src/app/api/manager/payments/requests/[id]/decide/route.ts", "utf8");
check("decide route checks approve_payment for approve", /manager\.finance\.approve_payment/.test(decide));
check("decide route checks initiate_payment for cancel", /manager\.finance\.initiate_payment/.test(decide));
const create = readFileSync("src/app/api/manager/payments/requests/route.ts", "utf8");
check("create route needs initiate_payment", /manager\.finance\.initiate_payment/.test(create));
check("list route needs finance.view", /manager\.finance\.view/.test(create));
const cash = readFileSync("src/lib/data-access/rider-cash.ts", "utf8");
check("decideDeposit goes through ops_decide_cash_deposit", /ops_decide_cash_deposit/.test(cash));
check("...and never writes cod_handovers itself", !/from\(["']cod_handovers["']\)\s*\.insert/.test(cash));
const mc = readFileSync("src/lib/data-access/manager-cash.ts", "utf8");
check("deposit and dispute lists are scoped", /scopedRiderIds|riderVisible/.test(mc));
const pr = readFileSync("src/lib/data-access/payment-requests.ts", "utf8");
check("payment request list is scoped by zone", /applyZoneScope|scopeZoneIds/.test(pr));

console.log("\n── live (optional) ──");
const BASE = process.env.BASE ?? "http://localhost:3005";
async function live() {
  try {
    const x = await fetch(`${BASE}/api/manager/payments/requests`, { redirect: "manual" });
    if (x.status === 404) {
      console.log("  skip (the server on BASE does not serve this branch)");
      return;
    }
    check("unauthenticated → 401", x.status === 401);
  } catch {
    console.log("  skip (dev server unreachable)");
  }
}
void live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
