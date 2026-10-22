/**
 * QA — manager order actions: body validation, the permission each action
 * needs, RPC error mapping, and the structural rule that the admin console and
 * the web /manager portal now go through the same audited RPCs. Live section
 * runs against a dev server when BASE is reachable and QA_MANAGER_COOKIE /
 * QA_ORDER_ID / QA_OFFLINE_RIDER_ID are set.
 *
 * Usage: npx tsx scripts/qa/manager-order-actions.ts
 */
import { readFileSync } from "node:fs";
import { managerCookie } from "./_manager-session";
import { randomUUID } from "node:crypto";
import { ACTION_PERMISSION, mapRpcError, parseActionBody } from "../../src/lib/ops/order-actions";

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
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const CID = randomUUID();
const RIDER = randomUUID();

console.log("\n── body validation ──");
let p = parseActionBody({ action: "advance", expected: "placed" });
check("missing clientActionId → 400 bad_request", !p.ok && p.status === 400 && p.error === "bad_request" && p.field === "clientActionId");
p = parseActionBody({ action: "advance", expected: "placed", clientActionId: "nope" });
check("a non-uuid clientActionId → 400", !p.ok && p.field === "clientActionId");
p = parseActionBody({ action: "advance", expected: "placed", clientActionId: CID });
check("advance without a reason → reason_required (every manager status change has one)", !p.ok && p.error === "reason_required");
p = parseActionBody({ action: "advance", expected: "placed", reason: "Vendor confirmed by phone", clientActionId: CID });
check("advance with a reason", p.ok && p.action.action === "advance" && p.action.reason === "Vendor confirmed by phone");
p = parseActionBody({ action: "advance", expected: "eaten", reason: "Vendor confirmed by phone", clientActionId: CID });
check("advance with an unknown expected status → 400", !p.ok && p.field === "expected");
p = parseActionBody({ action: "cancel", clientActionId: CID });
check("cancel without a reason → reason_required", !p.ok && p.error === "reason_required");
p = parseActionBody({ action: "reassign", riderId: RIDER, reason: "ok", clientActionId: CID });
check("reassign with a 2-character reason → reason_required", !p.ok && p.error === "reason_required");
p = parseActionBody({ action: "reassign", riderId: RIDER, reason: "x".repeat(301), clientActionId: CID });
check("a 301-character reason → reason_required", !p.ok && p.error === "reason_required");
p = parseActionBody({ action: "reassign", riderId: RIDER, reason: "Flat tyre", clientActionId: CID });
check("reassign with a reason, afterPickup defaults to false",
  p.ok && p.action.action === "reassign" && p.action.afterPickup === false && p.action.riderId === RIDER);
p = parseActionBody({ action: "assign", riderId: "abc", clientActionId: CID });
check("assign with a bad rider id → 400 field riderId", !p.ok && p.field === "riderId");
p = parseActionBody({ action: "assign", riderId: RIDER, clientActionId: CID });
check("assign needs no reason, and is not an override", p.ok && p.action.action === "assign" && p.action.reason === null && p.action.override === false);
p = parseActionBody({ action: "assign", riderId: RIDER, override: true, clientActionId: CID });
check("an override without a reason → reason_required", !p.ok && p.error === "reason_required");
p = parseActionBody({ action: "assign", riderId: RIDER, override: true, reason: "Rider on the phone, GPS off", clientActionId: CID });
check("an override with a reason", p.ok && p.action.action === "assign" && p.action.override === true);
p = parseActionBody({ action: "reassign", riderId: RIDER, override: "yes", reason: "Flat tyre", clientActionId: CID });
check("override must be a boolean → 400 field override", !p.ok && p.field === "override");
p = parseActionBody({ action: "escalate", reason: "Kitchen silent", clientActionId: CID });
check("escalate defaults to high", p.ok && p.action.action === "escalate" && p.action.priority === "high");
p = parseActionBody({ action: "escalate", reason: "Kitchen silent", priority: "low", clientActionId: CID });
check("escalate with priority low → 400", !p.ok && p.field === "priority");
p = parseActionBody({ action: "correct", kind: "status", toStatus: "kitchen", reason: "Wrong tap", clientActionId: CID });
check("a status correction", p.ok && p.action.action === "correct" && p.action.kind === "status");
p = parseActionBody({ action: "correct", kind: "status", reason: "Wrong tap", clientActionId: CID });
check("a status correction without toStatus → 400", !p.ok && p.field === "toStatus");
p = parseActionBody({ action: "correct", kind: "item_unavailable", reason: "Ran out", clientActionId: CID });
check("item_unavailable without itemId → 400", !p.ok && p.field === "itemId");
p = parseActionBody({ action: "correct", kind: "address_note", reason: "Customer called", note: "Blue gate behind the temple", clientActionId: CID });
check("an address note correction carries the note", p.ok && p.action.action === "correct" && p.action.kind === "address_note" && p.action.note === "Blue gate behind the temple");
p = parseActionBody({ action: "correct", kind: "address_note", reason: "Customer called", clientActionId: CID });
check("an address note without a note → 400 field note", !p.ok && p.field === "note");
p = parseActionBody({ action: "correct", kind: "status", toStatus: "delivered", reason: "It arrived", clientActionId: CID });
check("correcting into delivered is accepted by the parser (the RPC answers use_advance)", p.ok);
p = parseActionBody({ action: "correct", kind: "price", reason: "Ran out", clientActionId: CID });
check("an unknown correction kind → 400", !p.ok && p.field === "kind");
p = parseActionBody({ action: "note", note: "Customer wants extra napkins", clientActionId: CID });
check("a note uses note, not reason", p.ok && p.action.action === "note" && p.action.note === "Customer wants extra napkins");
p = parseActionBody({ action: "note", note: "hi", clientActionId: CID });
check("a 2-character note → reason_required", !p.ok && p.error === "reason_required");
p = parseActionBody({ action: "teleport", clientActionId: CID });
check("an unknown action → 400 field action", !p.ok && p.field === "action");
p = parseActionBody(null);
check("no body → 400", !p.ok && p.status === 400);

console.log("\n── permissions ──");
check("each action's permission is the plan's", eq(ACTION_PERMISSION, {
  advance: "manager.move_status",
  cancel: "manager.move_status",
  assign: "manager.assign_rider",
  reassign: "manager.reassign_rider",
  escalate: "manager.orders.escalate",
  correct: "manager.orders.correct",
  note: "manager.orders.correct",
}));

console.log("\n── RPC errors ──");
const m = (message: string, code?: string, details?: string) => mapRpcError({ message, code, details });
check("forbidden (42501) → 404 not_found", eq(m("forbidden", "42501"), { ok: false, status: 404, error: "not_found" }));
check("stale → 409 stale", eq(m("stale", "40001"), { ok: false, status: 409, error: "stale" }));
check("reason_required → 400", eq(m("reason_required", "22023"), { ok: false, status: 400, error: "reason_required" }));
check("rider_ineligible carries the reason", eq(m("rider_ineligible", "22023", "stale_fix"),
  { ok: false, status: 409, error: "rider_ineligible", extra: { reasons: ["stale_fix"] } }));
for (const code of ["already_assigned", "picked_up", "terminal", "financially_closed", "invalid_transition", "use_advance"]) {
  check(`${code} → 409 ${code}`, eq(m(code), { ok: false, status: 409, error: code }));
}
check("someone else's client action id → 409 stale", m("client_action_id_conflict", "23505").ok === false
  && (m("client_action_id_conflict", "23505") as { error: string }).error === "stale");
check("a rider inserting the same delivery at the same moment (23505) → 409 already_assigned",
  eq(m('duplicate key value violates unique constraint "deliveries_order_id_key"', "23505"), { ok: false, status: 409, error: "already_assigned" }));
check("0081's delivery guard (23514) → 409 invalid_transition",
  eq(m("invalid_delivery_transition", "23514", "picked_up requires an assigned delivery"), { ok: false, status: 409, error: "invalid_transition" }));
check("refunds never above the total → 409 refund_exceeds_total",
  eq(m("refund_exceeds_total", "23514"), { ok: false, status: 409, error: "refund_exceeds_total" }));
check("anything else → 500 action_failed", eq(m("deadlock detected", "40P01"), { ok: false, status: 500, error: "action_failed" }));

console.log("\n── structure ──");
const admin = readFileSync("src/app/admin/orders/actions.ts", "utf8");
const cancelBody = admin.slice(admin.indexOf("export async function cancelOrderAsAdmin"));
check("cancelOrderAsAdmin goes through cancelOrderAsOps", /cancelOrderAsOps\(/.test(cancelBody) && !/cancelOrderRow\(/.test(cancelBody));
const web = readFileSync("src/app/manager/actions.ts", "utf8");
check("the web /manager portal advances and assigns through the RPCs",
  /opsAdvance\(/.test(web) && /opsAssign\(/.test(web) && !/\.from\("orders"\)\s*\.update/.test(web) && !/\.from\("deliveries"\)/.test(web));
const advanceBody = web.slice(web.indexOf("export async function advanceOrder"), web.indexOf("export async function assignRider"));
check("the web board's advance carries the manager's reason (no null reason)",
  /reason: string/.test(advanceBody) && !/,\s*null,\s*crypto\.randomUUID\(\)/.test(advanceBody));
check("the web board lists riders through the shared candidate list (eligibility and reasons)",
  /export async function riderCandidatesFor\(/.test(web) && /listRiderCandidates\(/.test(web));
const board = readFileSync("src/components/manager/manager-order-board.tsx", "utf8");
check("the board offers the shared quick reasons and an override with a reason",
  /ADVANCE_QUICK_REASONS/.test(board) && /override/.test(board) && /riderCandidatesFor\(/.test(board));
const page = readFileSync("src/app/manager/page.tsx", "utf8");
check("the board no longer lists every driver regardless of eligibility", !/listRiders\(/.test(page));
const route = readFileSync("src/app/api/manager/orders/[id]/actions/route.ts", "utf8");
check("the actions route opens with managerApiContext and rate-limits", /managerApiContext\(/.test(route) && /managerWriteLimit\(/.test(route));
const ridersRoute = readFileSync("src/app/api/manager/orders/[id]/riders/route.ts", "utf8");
check("the riders route opens with managerApiContext", /managerApiContext\(/.test(ridersRoute));
const cancellation = readFileSync("src/lib/data-access/order-cancellation.ts", "utf8");
check("cancelOrderAsOps has the Rider plan's signature",
  // The Rider branch's shape (reason optional, the result its CancelOpsResult),
  // plus the caller's idempotency key.
  /export async function cancelOrderAsOps\(\s*orderId: string,\s*opts: \{ by: "admin" \| "manager"; reason\?: string \| null; requestedBy: string; clientActionId\?: string \}\s*\): Promise<CancelOpsResult>/.test(cancellation));

async function live(): Promise<void> {
  console.log("\n── live (optional) ──");
  const BASE = process.env.BASE ?? "http://localhost:3005";
  const reachable = await fetch(`${BASE}/api/app-version?app=manager&versionCode=1`, { signal: AbortSignal.timeout(3000) })
    .then(() => true, () => false);
  if (!reachable) return void console.log(`  (skipped: ${BASE} unreachable)`);
  const anon = await fetch(`${BASE}/api/manager/orders/${RIDER}/actions`, { method: "POST", body: "{}" });
  check("unauthenticated action → 401", anon.status === 401);
  const cookie = await managerCookie();
  const { QA_ORDER_ID: orderId, QA_OFFLINE_RIDER_ID: offline } = process.env;
  if (!cookie || !orderId) return void console.log("  (skipped signed-in checks: needs a manager login and QA_ORDER_ID)");
  const post = (body: unknown) => fetch(`${BASE}/api/manager/orders/${orderId}/actions`,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const detail = await (await fetch(`${BASE}/api/manager/orders/${orderId}`, { headers: { cookie } })).json();
  const cid = randomUUID();
  const a = await post({ action: "advance", expected: detail.order.status, clientActionId: cid });
  const b = await post({ action: "advance", expected: detail.order.status, clientActionId: cid });
  const after = (await b.json()).order;
  check("the same clientActionId twice → both 200, moved once", a.status === 200 && b.status === 200 && after.status === detail.order.allowed.advance);
  if (offline) {
    const r = await post({ action: "reassign", riderId: offline, reason: "QA check", clientActionId: randomUUID() });
    check("reassigning to an offline rider → 409 rider_ineligible", r.status === 409 && (await r.json()).error === "rider_ineligible");
  }
}

void live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
