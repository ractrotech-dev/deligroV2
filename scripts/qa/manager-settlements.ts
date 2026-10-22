/**
 * QA — maker–checker vendor settlements and audited refund decisions (§7,
 * migration 0156): error mapping, and structural rules that keep every money
 * path on the audited RPCs with no one-person vendor payment anywhere.
 *
 * Usage: npx tsx scripts/qa/manager-settlements.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { mapPaymentRpcError } from "../../src/lib/ops/payment-actions";
import { classifyGatewayFailure } from "../../src/lib/payments/refund-failure";
import { RazorpayError } from "../../src/lib/payments/razorpay";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail === undefined ? "" : `\n         ${JSON.stringify(detail).slice(0, 400)}`}`); }
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

console.log("\n── RPC errors → answers ──");
const m = (message: string, details?: string) => mapPaymentRpcError({ message, details });
check("amount_changed → 409 with the new amount", JSON.stringify(m("amount_changed", "14944")) === JSON.stringify({ ok: false, status: 409, error: "amount_changed", extra: { amount: 14944 } }));
check("negative_net → 409 with netPayable", JSON.stringify(m("negative_net", "-340")) === JSON.stringify({ ok: false, status: 409, error: "negative_net", extra: { netPayable: -340 } }));
check("same_person → 403", (m("same_person") as { status: number }).status === 403);
for (const code of ["duplicate_pending", "nothing_to_pay", "not_draft", "rebuilding", "already_decided"]) {
  check(`${code} → 409`, (m(code) as { status: number; error: string }).status === 409 && (m(code) as { error: string }).error === code);
}

console.log("\n── no one-person vendor payment ──");
const settlements = read("src/lib/data-access/admin-settlements.ts");
check("admin-settlements no longer exports markSettlementPaid", !/export async function markSettlementPaid/.test(settlements));
check("writeSettlement can no longer create a paid settlement", !/paidRef/.test(settlements) && !/status = "paid"|status: "paid"/.test(settlements.replace(/\.eq\("status", "paid"\)/g, "")));
check("markOrderPaid is gone (one-order payouts are drafts sent for approval)", !/export async function markOrderPaid/.test(settlements));
check("no code updates vendor_settlements to paid outside the RPC",
  !/from\("vendor_settlements"\)\s*\.update\(\{[^}]*status:\s*"paid"/s.test(settlements + read("src/lib/data-access/settlement-requests.ts") + read("src/lib/data-access/payment-requests.ts")));
check("voidSettlement goes through ops_void_settlement", /rpc\("ops_void_settlement"/.test(settlements));
const requests = read("src/lib/data-access/settlement-requests.ts");
check("approval goes through ops_decide_payment_request", /rpc\("ops_decide_payment_request"/.test(requests));
check("approval re-checks the draft (isDraftStale) before deciding", /isDraftStale\(settlementId\)/.test(requests));
check("a requester is refused before any rebuild — unless the one-admin switch lets an admin self-approve",
  /requested_by === actorId/.test(requests) && /mayApproveOwn\(/.test(requests));
check("a stale draft caught by the RPC (stale_draft) is rebuilt, then the approver confirms", /stale_draft/.test(requests) && /rebuildUnderRequest\(/.test(requests));
check("one-order initiation checks the order is the vendor's and in the caller's zone before building a draft",
  /orderForInitiation\(/.test(requests) && /restaurantId !== input\.vendorId/.test(requests));
check("a replayed approval is answered before already_decided", requests.indexOf("replayedRequest(") > -1
  && requests.indexOf("replayedRequest(") < requests.indexOf('error: "already_decided"'));
check("a replayed initiation is answered before a draft is built", requests.indexOf("replayedRequest(") > -1
  && requests.indexOf("replayedRequest(") < requests.indexOf("createInstantDraft({ orderId: input.orderId"));
check("an admin 'Unpaid' on a paid payout asks for a reversal, never voids it",
  /ops_request_settlement_reversal/.test(read("src/lib/data-access/admin-settlements.ts") + requests));
const adminActions = read("src/app/admin/settlements/actions.ts");
check("admin actions call the request flow, not a direct pay", /adminPayOrRequestSettlement/.test(adminActions) && /adminRequestOrderPayout/.test(adminActions) && !/markOrderPaid/.test(adminActions));
check("admin void asks for a reason", /voidSettlementAction\(\s*id: string,\s*reason: string/.test(adminActions));

console.log("\n── refunds ──");
const refunds = read("src/lib/data-access/refunds.ts");
check("decideRefund takes an actor and a reason", /export async function decideRefund\(\s*actor: \{ id: string \},\s*id: string,\s*decision: Exclude<RefundStatus, "pending">,\s*reason: string/.test(refunds));
check("decideRefund writes through ops_decide_refund", /rpc\("ops_decide_refund"/.test(refunds));
check("decideRefund no longer updates refunds.status directly", !/from\("refunds"\)\s*\.update\(\{\s*status/.test(refunds));
check("no fixed-window limiter stands in for the refund lock", !/rateLimit\(`refund-decide/.test(refunds));
check("decideRefund claims the refund in the database before the gateway call",
  refunds.indexOf('rpc("ops_claim_refund"') > -1 && refunds.indexOf('rpc("ops_claim_refund"') < refunds.indexOf("await settleApprovedRefund(refund"));
check("the gateway id is recorded before the decision",
  refunds.indexOf('rpc("ops_record_refund_gateway"') > -1 && refunds.indexOf('rpc("ops_record_refund_gateway"') < refunds.indexOf('rpc("ops_decide_refund"'));
check("a resumed claim never calls the gateway again", /state === "resume"/.test(refunds));
check("a definite gateway refusal gives the claim back; an unknown outcome keeps it",
  /ops_release_refund_claim/.test(refunds) && /gateway_unknown/.test(refunds));

console.log("\n── gateway failures: definite or unknown ──");
check("not configured → definite", classifyGatewayFailure(new RazorpayError("razorpay_not_configured", 503)) === "definite");
check("a 400 from Razorpay → definite", classifyGatewayFailure(new RazorpayError("razorpay_refund_failed_400", 502)) === "definite");
check("a 502 from Razorpay → unknown", classifyGatewayFailure(new RazorpayError("razorpay_refund_failed_502", 502)) === "unknown");
check("a 500 from Razorpay → unknown", classifyGatewayFailure(new RazorpayError("razorpay_refund_failed_500", 502)) === "unknown");
check("a network error → unknown", classifyGatewayFailure(new TypeError("fetch failed")) === "unknown");
check("the admin refund action passes a reason", /decideRefund\(\{ id: admin\.id \}, id, decision, reason\)/.test(read("src/app/admin/actions.ts")));

console.log("\n── routes ──");
const list = read("src/app/api/manager/finance/settlements/route.ts");
check("GET settlements needs finance.view", /managerApiContext\("manager\.finance\.view"\)/.test(list));
check("POST settlements needs initiate_payment", /manager\.finance\.initiate_payment/.test(list));
check("POST settlements checks the shop is in scope", /shopInScope\(/.test(list));
check("POST settlements is rate-limited", /managerWriteLimit\(/.test(list));
const detail = read("src/app/api/manager/finance/settlements/[id]/route.ts");
check("settlement detail answers 404 out of scope", /not_found/.test(detail) && /getSettlementFor\(/.test(detail));
const decide = read("src/app/api/manager/finance/refunds/[id]/decide/route.ts");
check("refund decide needs finance.adjust", /manager\.finance\.adjust/.test(decide));
check("refund decide checks the refund is in scope first", /getRefundFor\(/.test(decide));
check("refund decide is rate-limited", /managerWriteLimit\(/.test(decide));
check("refund decide answers effect_failed / already_decided", /already_decided/.test(decide) && /effect_failed|record_failed/.test(decide));
check("money sent but not recorded has its own answer (no retry)", /recorded_failed_after_gateway/.test(decide));
check("an unknown gateway outcome has its own answer", /gateway_unknown/.test(decide));
const refundList = read("src/app/api/manager/finance/refunds/route.ts");
check("refund list needs finance.view", /managerApiContext\("manager\.finance\.view"\)/.test(refundList));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
