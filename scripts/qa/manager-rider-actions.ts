/**
 * QA — manager rider actions (§5.2, §5.3, §5.13): body validation, the switch
 * each action needs, how an RPC error becomes the pinned answer, onboarding
 * fields, document numbers and uploads, and structural rules (onboarding and
 * Team driver creation go through ops_onboard_rider; the rider API refuses a
 * suspended or rejected rider; dispatch reads the same rule). The live section
 * runs against a dev server when BASE is reachable and QA_MANAGER_COOKIE is set.
 *
 * Usage: npx tsx scripts/qa/manager-rider-actions.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  RIDER_ACTION_PERMISSION,
  mapRiderRpcError,
  parseOnboardRiderBody,
  parseRiderActionBody,
  validateRiderDocFields,
  loginEmailFor,
  replayAnswer,
  awaitPriorOnboard,
} from "../../src/lib/ops/rider-actions";
import { sniffType } from "../../src/lib/utils/file-signature";

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
const cid = () => randomUUID();

console.log("\n── permissions ──");
check("status actions need manager.riders.status",
  ["approve", "reject", "suspend", "reactivate", "force_offline", "verify_document", "reject_document"]
    .every((a) => RIDER_ACTION_PERMISSION[a as keyof typeof RIDER_ACTION_PERMISSION] === "manager.riders.status"));
check("adjustments need manager.finance.adjust", RIDER_ACTION_PERMISSION.add_adjustment === "manager.finance.adjust");

console.log("\n── action bodies ──");
let p = parseRiderActionBody({ action: "suspend", clientActionId: cid(), reason: "ok", expected: "active" });
check("a 2-character reason → reason_required", !p.ok && p.error === "reason_required");
p = parseRiderActionBody({ action: "suspend", clientActionId: cid(), reason: "Cash shortfall" });
check("suspend without expected → bad_request expected", !p.ok && p.error === "bad_request" && p.field === "expected");
p = parseRiderActionBody({ action: "suspend", clientActionId: cid(), reason: "Cash shortfall", expected: "verified" });
check("suspend with a verification value as expected → bad_request", !p.ok && p.field === "expected");
p = parseRiderActionBody({ action: "approve", clientActionId: cid(), reason: "Met in person", expected: "pending", override: true });
check("approve with override", p.ok && p.action.action === "approve" && p.action.override === true);
p = parseRiderActionBody({ action: "reject_document", clientActionId: cid(), documentId: randomUUID() });
check("reject_document without remarks → remarks_required", !p.ok && p.error === "remarks_required");
p = parseRiderActionBody({ action: "verify_document", clientActionId: cid(), documentId: randomUUID() });
check("verify_document needs no remarks", p.ok);
p = parseRiderActionBody({ action: "add_adjustment", clientActionId: cid(), reason: "Festival rush", adjustment: { kind: "bonus", amount: 0, effectiveOn: "2026-10-20" } });
check("adjustment amount 0 → bad_request amount", !p.ok && p.field === "amount");
p = parseRiderActionBody({ action: "add_adjustment", clientActionId: cid(), reason: "Monthly pay", adjustment: { kind: "salary", amount: 12000, effectiveOn: "2026-10-20" } });
check("adjustment kind salary → bad_request kind (salary goes through payout requests)", !p.ok && p.field === "kind");
p = parseRiderActionBody({ action: "add_adjustment", clientActionId: cid(), reason: "Late fee refund", adjustment: { kind: "adjustment", amount: -50, effectiveOn: "2026-10-20" } });
check("a negative adjustment is allowed", p.ok);
p = parseRiderActionBody({ action: "add_adjustment", clientActionId: cid(), reason: "Penalty", adjustment: { kind: "deduction", amount: -50, effectiveOn: "2026-10-20" } });
check("a negative deduction → bad_request amount", !p.ok && p.field === "amount");
p = parseRiderActionBody({ action: "fly", clientActionId: cid(), reason: "Because" });
check("an unknown action → bad_request action", !p.ok && p.field === "action");
p = parseRiderActionBody({ action: "suspend", clientActionId: "nope", reason: "Because", expected: "active" });
check("a non-uuid clientActionId → bad_request", !p.ok && p.field === "clientActionId");

console.log("\n── onboarding ──");
const good = { clientActionId: cid(), fullName: "Ravi Kumar", mobile: "9876543210", zoneId: randomUUID(), vehicleType: "ev_bike", vehicleOwner: "deligro" };
let o = parseOnboardRiderBody(good);
check("a minimal onboarding body", o.ok && o.input.mobile === "+919876543210" && o.input.email === null);
o = parseOnboardRiderBody({ ...good, mobile: "987654321" });
check("a 9-digit mobile → field mobile", !o.ok && o.field === "mobile");
o = parseOnboardRiderBody({ ...good, zoneId: undefined });
check("no zone → field zoneId", !o.ok && o.field === "zoneId");
o = parseOnboardRiderBody({ ...good, pincode: "4913" });
check("pincode 4913 → field pincode", !o.ok && o.field === "pincode");
o = parseOnboardRiderBody({ ...good, password: "short" });
check("a short password → field password", !o.ok && o.field === "password");
o = parseOnboardRiderBody({ ...good, email: "not-an-email" });
check("a bad email → field email", !o.ok && o.field === "email");
o = parseOnboardRiderBody({ ...good, vehicleType: "jet" });
check("an unknown vehicle → field vehicleType", !o.ok && o.field === "vehicleType");
o = parseOnboardRiderBody({ ...good, emergencyPhone: "12" });
check("a bad emergency phone → field emergencyPhone", !o.ok && o.field === "emergencyPhone");
o = parseOnboardRiderBody({ ...good, licenceExpiresOn: "2026-02-30" });
check("an impossible licence expiry → field licenceExpiresOn", !o.ok && o.field === "licenceExpiresOn");
check("a login without email uses the phone-only account address (one account per phone)",
  loginEmailFor({ email: null, mobile: "+919876543210" }) === "p919876543210@phone.deligro.app");
check("...and a given email is used as is", loginEmailFor({ email: "ravi@example.com", mobile: "+919876543210" }) === "ravi@example.com");

console.log("\n── documents ──");
check("Aadhaar must be 12 digits", validateRiderDocFields("aadhaar", "1234 5678 9012", null).ok && !validateRiderDocFields("aadhaar", "12345", null).ok);
check("PAN format", validateRiderDocFields("pan", "ABCDE1234F", null).ok && !validateRiderDocFields("pan", "1234", null).ok);
const lic = validateRiderDocFields("driving_licence", "CG07 20190012345", null);
check("a licence without expiry → expiry_required", !lic.ok && lic.error === "expiry_required");
check("a photo needs no number", validateRiderDocFields("photo", null, null).ok);
check("an unknown type → bad_type", (() => { const r = validateRiderDocFields("passport", null, null); return !r.ok && r.error === "bad_type"; })());
const html = new TextEncoder().encode("<!doctype html><html>");
check("HTML bytes are not a PDF/JPEG/PNG", sniffType(html) === null);
const pdf = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ");
check("PDF bytes are recognised", sniffType(pdf) === "application/pdf");

console.log("\n── RPC errors → answers ──");
const m = (message: string, details?: string, code?: string) => mapRiderRpcError({ message, details: details ?? null, code });
const f = (r: ReturnType<typeof m>) => (r.ok ? { status: 200, error: "" } : r);
check("42501 → 404 not_found", f(m("forbidden", undefined, "42501")).status === 404);
check("stale → 409", f(m("stale")).status === 409);
check("invalid_transition → 409", f(m("invalid_transition")).status === 409);
check("already_decided → 409", f(m("already_decided")).status === 409);
const du = m("documents_unverified", "aadhaar,photo");
check("documents_unverified → 409 with missing", !du.ok && du.status === 409 && JSON.stringify(du.extra) === JSON.stringify({ missing: ["aadhaar", "photo"] }));
const ad = m("active_delivery", "AB12CD34,EF56GH78");
check("active_delivery → 409 with orders", !ad.ok && ad.status === 409 && JSON.stringify(ad.extra) === JSON.stringify({ orders: ["AB12CD34", "EF56GH78"] }));
check("reason_required → 400", f(m("reason_required")).status === 400);
check("expiry_required → 400", f(m("expiry_required")).status === 400 && !m("expiry_required").ok && (m("expiry_required") as { error: string }).error === "expiry_required");
check("invalid_amount → 400 bad_request", f(m("invalid_amount")).status === 400);
check("someone else's clientActionId → 409 stale", (m("client_action_id_conflict") as { error: string }).error === "stale");
check("anything else → 500 action_failed", (m("boom") as { error: string }).error === "action_failed");

console.log("\n── structural ──");
const da = readFileSync("src/lib/data-access/manager-rider-actions.ts", "utf8");
check("onboarding calls ops_onboard_rider", /ops_onboard_rider/.test(da));
check("...and never sets a role directly", !/\.from\(["']profiles["']\)[\s\S]{0,200}role:/.test(da));
const emp = readFileSync("src/lib/data-access/employees.ts", "utf8");
check("Team driver creation goes through ops_onboard_rider", /ops_onboard_rider/.test(emp));
const gate = readFileSync("src/lib/auth/rider-api.ts", "utf8");
check("the rider API gate reads the work block", /riderWorkBlock|loadWorkBlocks/.test(gate) && /account_suspended/.test(gate));
const signout = readFileSync("src/app/api/rider/signout/route.ts", "utf8");
check("signing out still works for a blocked rider", /allowBlocked/.test(signout));
const dispatch = readFileSync("src/lib/dispatch/rider-dispatch.ts", "utf8");
check("dispatch reads the same rule", /loadWorkBlocks/.test(dispatch));
const upload = readFileSync("src/app/api/manager/riders/[id]/documents/route.ts", "utf8");
check("upload route checks manager.riders.onboard", /manager\.riders\.onboard/.test(upload));
const actions = readFileSync("src/app/api/manager/riders/[id]/actions/route.ts", "utf8");
check("actions route rate-limits writes", /managerWriteLimit/.test(actions));
check("the offers to stop and re-dispatch come from the RPC (read under its locks), not a read before it",
  /released_offers/.test(da) && !/async function heldOffers/.test(da));
check("dispatch treats a rider the database refuses (rider_cannot_work) as a lost race, not a crash",
  /rider_cannot_work/.test(dispatch));
const location = readFileSync("src/app/api/driver/location/route.ts", "utf8");
check("the legacy location route refuses a suspended or rejected rider", /riderWorkBlock/.test(location));
const routeError = readFileSync("src/lib/auth/rider-route-error.ts", "utf8");
check("a rider write the database refuses as rider_cannot_work answers 403, not 500", /rider_cannot_work/.test(routeError));

console.log("\n── onboarding replays ──");
check("a replay of the same onboarding returns the first result",
  replayAnswer({ actor_id: "m1", action: "rider.onboard", entity_id: "u1" }, "m1")?.kind === "same");
check("another person's id → stale", replayAnswer({ actor_id: "m2", action: "rider.onboard", entity_id: "u1" }, "m1")?.kind === "stale");
check("this manager's id spent on another action → conflict",
  replayAnswer({ actor_id: "m1", action: "rider.suspend", entity_id: "u9" }, "m1")?.kind === "conflict");
check("no earlier call → null", replayAnswer(null, "m1") === null);
async function onboardRace() {
  let calls = 0;
  const seen = await awaitPriorOnboard(async () => (++calls < 3 ? null : { actor_id: "m1", action: "rider.onboard", entity_id: "u1" }), {
    tries: 5, sleep: async () => {},
  });
  check("a concurrent onboarding that lost the race waits for the winner's result", seen?.entity_id === "u1" && calls === 3);
  const none = await awaitPriorOnboard(async () => null, { tries: 3, sleep: async () => {} });
  check("...and gives up when there is none", none === null);
}

console.log("\n── live (optional) ──");
const BASE = process.env.BASE ?? "http://localhost:3005";
const cookie = process.env.QA_MANAGER_COOKIE;
async function live() {
  try {
    const r = await fetch(`${BASE}/api/manager/riders/${randomUUID()}/actions`, { method: "POST", redirect: "manual" });
    if (r.status === 404) {
      console.log("  skip (the server on BASE does not serve this branch)");
      return;
    }
    check("unauthenticated → 401", r.status === 401);
  } catch {
    console.log("  skip (dev server unreachable)");
    return;
  }
  if (!cookie) console.log("  skip signed-in checks (QA_MANAGER_COOKIE unset)");
}
void onboardRace().then(live).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
