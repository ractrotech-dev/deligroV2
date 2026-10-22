/**
 * QA — maker–checker vendor settlements and audited refund decisions (§7,
 * migration 0156): error mapping, and structural rules that keep every money
 * path on the audited RPCs with no one-person vendor payment anywhere.
 *
 * Usage: npx tsx scripts/qa/manager-settlements.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { mapPaymentRpcError } from "../../src/lib/ops/payment-actions";

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
check("a requester is refused before any rebuild", /requested_by === actorId\) return \{ ok: false, status: 403, error: "same_person" \}/.test(requests));
const adminActions = read("src/app/admin/settlements/actions.ts");
check("admin actions call the request flow, not a direct pay", /adminPayOrRequestSettlement/.test(adminActions) && /adminRequestOrderPayout/.test(adminActions) && !/markOrderPaid/.test(adminActions));
check("admin void asks for a reason", /voidSettlementAction\(\s*id: string,\s*reason: string/.test(adminActions));

console.log("\n── refunds ──");
const refunds = read("src/lib/data-access/refunds.ts");
check("decideRefund takes an actor and a reason", /export async function decideRefund\(\s*actor: \{ id: string \},\s*id: string,\s*decision: Exclude<RefundStatus, "pending">,\s*reason: string/.test(refunds));
check("decideRefund writes through ops_decide_refund", /rpc\("ops_decide_refund"/.test(refunds));
check("decideRefund no longer updates refunds.status directly", !/from\("refunds"\)\s*\.update\(\{\s*status/.test(refunds));
check("the one-decision-per-refund lock lives in decideRefund", /rateLimit\(`refund-decide:\$\{id\}`, 1, 15_000\)/.test(refunds));
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
const refundList = read("src/app/api/manager/finance/refunds/route.ts");
check("refund list needs finance.view", /managerApiContext\("manager\.finance\.view"\)/.test(refundList));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
