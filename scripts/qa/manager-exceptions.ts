/**
 * QA — delivery exception decisions (§5, deferred from Phase 3): which
 * decisions a viewer is offered per kind, body validation, the error mapping,
 * and structural rules (the route needs manager.exceptions.decide; the
 * decision RPC runs before any effect; cancelling happens only inside a state
 * re-check; the web manager action delegates to decideException).
 *
 * Usage: npx tsx scripts/qa/manager-exceptions.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { serializeException, type ExceptionRow, type Names } from "../../src/lib/ops/rider-serialize";
import { parseExceptionDecision, mapExceptionError } from "../../src/lib/ops/exception-actions";

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
const names: Names = {
  person: (id) => (id ? { id, name: "Staff" } : null),
  rider: (id) => ({ id, name: "Ravi", code: "DR-0007", phone: "+919800000000" }),
  zone: () => null,
};
const row = (kind: string, status = "pending"): ExceptionRow => ({
  id: randomUUID(), order_id: "abcdef12-0000-0000-0000-000000000000", driver_id: randomUUID(), kind, reason: "Called 3 times",
  notes: null, photo_path: null, lat: null, lng: null, status, decided_by: null, decided_at: null, decision_note: null,
  created_at: "2026-10-21T09:00:00Z",
});
const can = { "manager.exceptions.decide": true };

console.log("\n── decisions offered ──");
check("request kind → approve, reject", serializeException(row("customer_unreachable"), names, can).decisions.join() === "approve,reject");
check("report kind → acknowledge", serializeException(row("vendor_delay"), names, can).decisions.join() === "acknowledge");
check("decided → none", serializeException(row("failed_delivery", "approved"), names, can).decisions.length === 0);
check("without manager.exceptions.decide → none", serializeException(row("failed_delivery"), names, {}).decisions.length === 0);
check("the kind is what 0082 stores (other_issue)", serializeException(row("other_issue"), names, can).kind === "other_issue");
check("order code from the order id", serializeException(row("wrong_address"), names, can).orderCode === "ABCDEF12");

console.log("\n── bodies ──");
let p = parseExceptionDecision({ clientActionId: randomUUID(), decision: "reject" });
check("reject without a note → note_required", !p.ok && p.error === "note_required");
p = parseExceptionDecision({ clientActionId: randomUUID(), decision: "approve" });
check("approve needs no note", p.ok);
p = parseExceptionDecision({ clientActionId: randomUUID(), decision: "maybe" });
check("an unknown decision → bad_request", !p.ok && p.error === "bad_request");
p = parseExceptionDecision({ clientActionId: "x", decision: "approve" });
check("a non-uuid clientActionId → bad_request", !p.ok && p.field === "clientActionId");

console.log("\n── errors ──");
const e = (m: string, code?: string) => mapExceptionError({ message: m, code, details: null });
check("already_resolved → 409", (() => { const x = e("already_resolved"); return !x.ok && x.status === 409; })());
check("invalid_transition (approve on a report) → 409", (() => { const x = e("invalid_transition"); return !x.ok && x.status === 409; })());
check("note_required → 400", (() => { const x = e("note_required"); return !x.ok && x.status === 400; })());
check("forbidden → 404", (() => { const x = e("forbidden", "42501"); return !x.ok && x.status === 404; })());

console.log("\n── structural ──");
const route = readFileSync("src/app/api/manager/exceptions/[id]/decide/route.ts", "utf8");
check("decide route needs manager.exceptions.decide", /managerApiContext\("manager\.exceptions\.decide"\)/.test(route));
check("decide route answers 502 effect_failed", /502/.test(route) && /effect_failed/.test(route));
const list = readFileSync("src/app/api/manager/exceptions/route.ts", "utf8");
check("list route needs manager.riders.view", /managerApiContext\("manager\.riders\.view"\)/.test(list));
const da = readFileSync("src/lib/data-access/delivery-exceptions.ts", "utf8");
// The merged module (the Rider branch's, writing through 0152): the decision
// is recorded by the RPC before any effect runs, and every effect re-reads the
// delivery before it acts.
const decideBody = da.slice(da.indexOf("export async function decideException("));
const approveAt = decideBody.indexOf('recordDecision(supabase, x.id, "approve"');
const runAt = decideBody.indexOf("run({ delivery: d");
check("decisions are written by the 0152 RPC", /rpc\("ops_decide_delivery_exception"/.test(da));
check("decideException records the approval before any effect runs", approveAt > 0 && runAt > approveAt);
const applyBody = da.slice(da.indexOf("async function applyApproval("), da.indexOf("async function redispatch("));
check("the cancellation runs only after re-reading the delivery",
  applyBody.indexOf("readDelivery(") > 0 && applyBody.indexOf("effects.cancelOrder(") > applyBody.indexOf("readDelivery("));
check("the list is scoped", /scopedRiderIds|scopeAllows|riderVisible/.test(da));
const web = readFileSync("src/app/manager/actions.ts", "utf8");
check("the web manager action delegates to decideException", /decideExceptionAction/.test(web) && /decideException\(/.test(web));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
