/**
 * QA — manager vendor actions, onboarding, document uploads and ticket replies:
 * body validation, the permission each action needs, RPC error mapping, upload
 * checks, and the structural rules that the admin console and the onboarding
 * wizard now go through the same audited RPCs. Live section: a dev server at
 * BASE with QA_MANAGER_COOKIE and QA_VENDOR_ID set.
 *
 * Usage: npx tsx scripts/qa/manager-vendor-actions.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  TICKET_MESSAGE_PERMISSION,
  VENDOR_ACTION_PERMISSION,
  checkUpload,
  mapVendorRpcError,
  parseOnboardBody,
  parseTicketMessageBody,
  parseTicketStatusBody,
  parseVendorActionBody,
} from "../../src/lib/ops/vendor-actions";
import { toTicketSummary } from "../../src/lib/ops/vendor-contract";

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

console.log("\n── vendor action bodies ──");
let p = parseVendorActionBody({ action: "suspend", expected: "active", reason: "Hygiene issue", clientActionId: CID });
check("a valid suspend", p.ok && p.action.action === "suspend" && p.action.expected === "active");
p = parseVendorActionBody({ action: "suspend", expected: "active", reason: "ok", clientActionId: CID });
check("a 2-character reason → reason_required", !p.ok && p.error === "reason_required");
p = parseVendorActionBody({ action: "suspend", reason: "Hygiene issue", clientActionId: CID });
check("a status action without expected → 400 expected", !p.ok && p.error === "bad_request" && p.field === "expected");
p = parseVendorActionBody({ action: "approve", expected: "pending", reason: "All good", clientActionId: CID, override: "yes" });
check("override must be a boolean", !p.ok && p.field === "override");
p = parseVendorActionBody({ action: "approve", expected: "pending", reason: "All good", clientActionId: CID, override: true });
check("approve with override", p.ok && p.action.action === "approve" && p.action.override === true);
p = parseVendorActionBody({ action: "verify_document", documentId: "x", clientActionId: CID });
check("a non-uuid documentId → 400 documentId", !p.ok && p.field === "documentId");
p = parseVendorActionBody({ action: "verify_document", documentId: randomUUID(), clientActionId: CID });
check("verify needs no reason", p.ok && p.action.action === "verify_document");
p = parseVendorActionBody({ action: "reject_document", documentId: randomUUID(), reason: "", clientActionId: CID });
check("rejecting a document needs remarks", !p.ok && p.error === "reason_required");
p = parseVendorActionBody({ action: "delete", clientActionId: CID });
check("an unknown action → 400 action", !p.ok && p.field === "action");
p = parseVendorActionBody({ action: "suspend", expected: "active", reason: "Hygiene issue" });
check("a missing clientActionId → 400", !p.ok && p.field === "clientActionId");
p = parseVendorActionBody({ action: "suspend", expected: "sleeping", reason: "Hygiene issue", clientActionId: CID });
check("an unknown expected status → 400 expected", !p.ok && p.field === "expected");

console.log("\n── permissions ──");
check("permissions match the plan", eq(VENDOR_ACTION_PERMISSION, {
  approve: "manager.vendors.status", reject: "manager.vendors.status", suspend: "manager.vendors.status",
  reactivate: "manager.vendors.status", verify_document: "manager.vendors.status", reject_document: "manager.vendors.status",
}));
check("ticket replies and status need manager.support.manage", TICKET_MESSAGE_PERMISSION === "manager.support.manage");

console.log("\n── onboarding bodies ──");
const ZONE = randomUUID();
const good = {
  clientActionId: CID, zoneId: ZONE, shopName: "Ravi Rolls", ownerName: "Ravi", mobile: "9800000000",
  email: "ravi@example.com", address: "Station road", lat: 21.7, lng: 81.5, weeklyOff: ["monday"],
};
let o = parseOnboardBody(good);
check("a valid onboarding body", o.ok && o.input.shopName === "Ravi Rolls" && o.input.password === null);
o = parseOnboardBody({ ...good, mobile: "980000000" });
check("a 9-digit mobile → field mobile", !o.ok && o.field === "mobile");
o = parseOnboardBody({ ...good, zoneId: undefined });
check("no zoneId → field zoneId", !o.ok && o.field === "zoneId");
o = parseOnboardBody({ ...good, email: "not-an-email" });
check("a bad email → field email", !o.ok && o.field === "email");
o = parseOnboardBody({ ...good, password: "short" });
check("a short password → field password", !o.ok && o.field === "password");
o = parseOnboardBody({ ...good, lat: 200 });
check("latitude out of range → field lat", !o.ok && o.field === "lat");
o = parseOnboardBody({ ...good, openingTime: "25:00" });
check("an impossible time → field openingTime", !o.ok && o.field === "openingTime");
o = parseOnboardBody({ ...good, weeklyOff: ["funday"] });
check("an unknown weekday → field weeklyOff", !o.ok && o.field === "weeklyOff");
o = parseOnboardBody({ ...good, commissionPct: 1, bankAccountNumber: "1" } as Record<string, unknown>);
check("money terms in the body are ignored, never passed on", o.ok && !("commissionPct" in o.input) && !("bankAccountNumber" in o.input));

console.log("\n── uploads ──");
check("text/html refused", checkUpload("fssai", "text/html", 100) === "bad_file");
check("11 MB refused", checkUpload("fssai", "application/pdf", 11 * 1024 * 1024) === "bad_file");
check("an unknown type refused", checkUpload("passport", "application/pdf", 100) === "bad_file");
check("a 1 MB PDF accepted", checkUpload("fssai", "application/pdf", 1024 * 1024) === null);

console.log("\n── ticket bodies ──");
let t = parseTicketMessageBody({ body: "  ", clientActionId: CID });
check("an empty reply → reason_required", !t.ok && t.error === "reason_required");
t = parseTicketMessageBody({ body: "x".repeat(4001), clientActionId: CID });
check("a 4001-character reply → reason_required", !t.ok && t.error === "reason_required");
t = parseTicketMessageBody({ body: "Checking", internal: true, clientActionId: CID });
check("an internal note", t.ok && t.message.internal === true);
let s = parseTicketStatusBody({ status: "resolved", clientActionId: CID });
check("resolved without a resolution → reason_required", !s.ok && s.error === "reason_required");
s = parseTicketStatusBody({ status: "open", clientActionId: CID });
check("open is not a status a manager sets → 400 status", !s.ok && s.field === "status");
s = parseTicketStatusBody({ status: "in_progress", clientActionId: CID });
check("in_progress needs no resolution", s.ok && s.status.resolution === null);
check("requester roles use the contract's names",
  toTicketSummary({ id: CID, number: 1, subject: "s", category: "c", priority: "normal", status: "open", requester_role: "vendor",
    order_id: null, created_at: "a", updated_at: "b" }).requesterRole === "restaurant"
  && toTicketSummary({ id: CID, number: 1, subject: "s", category: "c", priority: "normal", status: "open", requester_role: "rider",
    order_id: null, created_at: "a", updated_at: "b" }).requesterRole === "driver");

console.log("\n── RPC errors ──");
check("forbidden → 404", eq(mapVendorRpcError({ message: "forbidden", code: "42501" }), { ok: false, status: 404, error: "not_found" }));
check("stale → 409", eq(mapVendorRpcError({ message: "stale" }), { ok: false, status: 409, error: "stale" }));
check("invalid_transition → 409", eq(mapVendorRpcError({ message: "invalid_transition" }), { ok: false, status: 409, error: "invalid_transition" }));
check("needs_map_pin → 409", eq(mapVendorRpcError({ message: "needs_map_pin" }), { ok: false, status: 409, error: "needs_map_pin" }));
check("documents_unverified → 409 with the missing list",
  eq(mapVendorRpcError({ message: "documents_unverified", details: "fssai,bank_proof" }),
    { ok: false, status: 409, error: "documents_unverified", extra: { missing: ["fssai", "bank_proof"] } }));
check("reason_required → 400", eq(mapVendorRpcError({ message: "reason_required" }), { ok: false, status: 400, error: "reason_required" }));
check("anything else → 500", eq(mapVendorRpcError({ message: "boom" }), { ok: false, status: 500, error: "action_failed" }));

console.log("\n── structural ──");
const reg = readFileSync("src/lib/data-access/vendor-registration.ts", "utf8");
check("onboarding writes the shop through ops_onboard_vendor", reg.includes("ops_onboard_vendor"));
check("...and never inserts into restaurants directly", !/from\("restaurants"\)\s*\.insert/.test(reg));
const adminVendors = readFileSync("src/lib/data-access/admin-vendors.ts", "utf8");
check("admin status changes go through the audited status RPC", adminVendors.includes("ops_admin_set_vendor_status"));
check("...and never update restaurants.status directly", !/\.update\(\{\s*status\s*\}\)/.test(adminVendors));
for (const f of ["src/app/api/manager/tickets/[id]/route.ts", "src/app/api/manager/tickets/[id]/messages/route.ts",
  "src/app/api/manager/tickets/[id]/status/route.ts"]) {
  check(`${f} opens with managerApiContext("manager.support.manage")`, readFileSync(f, "utf8").includes('managerApiContext("manager.support.manage")'));
}
for (const f of ["src/app/api/manager/vendors/[id]/actions/route.ts", "src/app/api/manager/vendors/[id]/documents/route.ts"]) {
  const src = readFileSync(f, "utf8");
  check(`${f} rate-limits its writes`, src.includes("managerWriteLimit("));
}
check("onboarding requires manager.vendors.onboard",
  readFileSync("src/app/api/manager/vendors/route.ts", "utf8").includes('managerApiContext("manager.vendors.onboard")'));

console.log("\n── live (optional) ──");
const BASE = process.env.BASE ?? "http://localhost:3005";
async function live() {
  const cookie = process.env.QA_MANAGER_COOKIE;
  const vendor = process.env.QA_VENDOR_ID;
  try {
    await fetch(BASE, { redirect: "manual" });
  } catch {
    console.log("  skip (dev server unreachable)");
    return;
  }
  if (!cookie || !vendor) {
    console.log("  skip (QA_MANAGER_COOKIE / QA_VENDOR_ID unset)");
    return;
  }
  const body = { action: "suspend", expected: "pending", reason: "QA stale check", clientActionId: randomUUID() };
  const r = await fetch(`${BASE}/api/manager/vendors/${vendor}/actions`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  check("a stale expected status → 409", r.status === 409);
}
void live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
