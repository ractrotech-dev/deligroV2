/**
 * QA — rider profile and documents (Phase 6 Task 2): the pure rules, the data
 * layer against a fake PostgREST + Storage, and the route contract.
 *
 *   npm run test:rider-profile   # tsx --conditions=react-server; the contract part needs `npm run dev`
 *
 *   BASE                                        default http://localhost:3005
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    any non-driver account (403 checks)
 *
 * Tiers:
 *
 *   1. Pure (`lib/rider/profile-rules.ts`): masking (Aadhaar keeps the last
 *      four only), document input and file rules (Review Focus 1's size and
 *      type), which fields need approval, the profile and change-request
 *      parsers (non-ASCII names and addresses intact), the documents-complete
 *      matrix by vehicle owner, the dispatch block (Review Focus 4) and the
 *      expiry-reminder stages. Always run.
 *   2. The data layer (`data-access/rider-profile.ts`,
 *      `data-access/rider-payout-accounts.ts`) against an in-memory PostgREST
 *      and Storage: Review Focus 1 (a 40 MB video renamed .pdf: nothing
 *      stored), Review Focus 2 (another rider's document id: no URL, no
 *      signing request), Review Focus 3 (a bank change is a request; the
 *      approved account is untouched and the rider sees it masked), the
 *      reminders (each sent once), the dispatch filter, and a database
 *      without 0086 (RiderSchemaPendingError -> 503). Always run.
 *   3. Route contract against the dev server: no cookie is 401 on every new
 *      route, a non-rider 403, the cron route 401 without its secret. SKIPs
 *      when the server or the QA account is missing (ruling R2: no database
 *      has 0086).
 *
 * Never sends push/SMS/OTP and never writes live data: every ONESIGNAL
 * variable is removed before any module loads, the fake is the only thing
 * written to, and the contract part sends no cookie-bearing writes.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./_env";
import { LOCKED_CATEGORIES, NOTIFICATION_CATEGORIES } from "../../src/lib/rider/notification-prefs";

for (const key of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?ONESIGNAL/i.test(key)) delete process.env[key];
}
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const BASE = (process.env.BASE ?? "http://localhost:3005").replace(/\/$/, "");
const CUSTOMER_EMAIL = process.env.QA_CUSTOMER_EMAIL ?? "";
const CUSTOMER_PASSWORD = process.env.QA_CUSTOMER_PASSWORD ?? "";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  }
}

function skip(why: string): void {
  console.log(`SKIP ${why}`);
}

async function group(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    check(name, true);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const D1 = "00000000-0000-4000-8000-0000000000d1";
const D2 = "00000000-0000-4000-8000-0000000000d2";
const TODAY = "2026-10-22";

// ---------------------------------------------------------------------------
// 1. pure rules
// ---------------------------------------------------------------------------
async function pureTier(): Promise<void> {
  const r = await import("../../src/lib/rider/profile-rules");

  await group("pure: masking — Aadhaar keeps the last four only; others XXXX + last four", () => {
    assert.equal(r.maskDocNumber("aadhaar", "1234 5678 9012"), "XXXX-XXXX-9012");
    assert.equal(r.maskDocNumber("aadhaar", "123456789012"), "XXXX-XXXX-9012");
    assert.equal(r.maskDocNumber("pan", "ABCDE1234F"), "XXXX234F");
    assert.equal(r.maskDocNumber("driving_licence", "MH1220110012345"), "XXXX2345");
    assert.equal(r.maskDocNumber("pan", "12"), "XXXX");
    assert.equal(r.maskDocNumber("photo", null), null);
    assert.equal(r.maskAccountNumber("123456789012"), "XXXX9012");
    assert.equal(r.maskUpiId("ravi.kumar@okhdfc"), "XXXXumar@okhdfc");
    assert.equal(r.maskUpiId("ab@ybl"), "XXXX@ybl");
    assert.equal(r.maskPayoutAccount({ kind: "bank", accountNumber: "000011112222", upiId: null }), "XXXX2222");
    assert.equal(r.maskPayoutAccount({ kind: "upi", accountNumber: null, upiId: "9876543210@ybl" }), "XXXX3210@ybl");
  });

  await group("pure: document input — numbers, expiry, Aadhaar never stored in full", () => {
    let v = r.validateDocumentInput({ type: "aadhaar", number: "1234 5678 9012" }, TODAY);
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.value.number, null, "the full Aadhaar is never handed to storage");
      assert.equal(v.value.numberMasked, "XXXX-XXXX-9012");
    }
    assert.deepEqual(r.validateDocumentInput({ type: "aadhaar", number: "1234 5678 901" }, TODAY), { ok: false, error: "invalid_number" });
    assert.deepEqual(r.validateDocumentInput({ type: "aadhaar" }, TODAY), { ok: false, error: "invalid_number" }, "Aadhaar needs its number");
    v = r.validateDocumentInput({ type: "pan", number: "abcde1234f" }, TODAY);
    assert.ok(v.ok && v.value.number === "ABCDE1234F" && v.value.numberMasked === "XXXX234F");
    assert.deepEqual(r.validateDocumentInput({ type: "pan", number: "ABCD1234F" }, TODAY), { ok: false, error: "invalid_number" });
    assert.deepEqual(r.validateDocumentInput({ type: "driving_licence", number: "MH12 20110012345" }, TODAY), { ok: false, error: "expiry_required" });
    assert.deepEqual(r.validateDocumentInput({ type: "driving_licence", number: "MH1220110012345", expiresOn: "2026-10-21" }, TODAY), { ok: false, error: "invalid_expiry" }, "already expired");
    assert.deepEqual(r.validateDocumentInput({ type: "driving_licence", number: "MH1220110012345", expiresOn: "2026-02-30" }, TODAY), { ok: false, error: "invalid_expiry" });
    v = r.validateDocumentInput({ type: "driving_licence", number: "MH1220110012345", expiresOn: TODAY }, TODAY);
    assert.ok(v.ok && v.value.expiresOn === TODAY, "valid through today");
    assert.deepEqual(r.validateDocumentInput({ type: "insurance" }, TODAY), { ok: false, error: "expiry_required" });
    assert.deepEqual(r.validateDocumentInput({ type: "puc" }, TODAY), { ok: false, error: "expiry_required" });
    assert.ok(r.validateDocumentInput({ type: "vehicle_rc" }, TODAY).ok, "RC number optional");
    v = r.validateDocumentInput({ type: "photo", number: "123" }, TODAY);
    assert.ok(v.ok && v.value.number === null && v.value.numberMasked === null, "a photo has no number");
    assert.deepEqual(r.validateDocumentInput({ type: "passport" }, TODAY), { ok: false, error: "bad_type" });
    assert.deepEqual(r.validateDocumentInput({ type: 7 }, TODAY), { ok: false, error: "bad_type" });
  });

  await group("pure: file rules — Review Focus 1 (40 MB, a video, empty), size before type; 4 MB cap (host body limit)", () => {
    const MB = 1024 * 1024;
    assert.deepEqual(r.checkDocumentFile({ type: "application/pdf", size: 40 * MB }), { ok: false, error: "too_large" });
    assert.deepEqual(r.checkDocumentFile({ type: "video/mp4", size: 40 * MB }), { ok: false, error: "too_large" });
    assert.deepEqual(r.checkDocumentFile({ type: "video/mp4", size: MB }), { ok: false, error: "bad_type" });
    assert.deepEqual(r.checkDocumentFile({ type: "application/pdf", size: 0 }), { ok: false, error: "bad_type" });
    assert.deepEqual(r.checkDocumentFile({ type: "image/webp", size: MB }), { ok: false, error: "bad_type" });
    assert.deepEqual(r.checkDocumentFile({ type: "application/pdf", size: 4 * MB }), { ok: true, ext: "pdf" });
    assert.deepEqual(r.checkDocumentFile({ type: "application/pdf", size: 4 * MB + 1 }), { ok: false, error: "too_large" });
    assert.deepEqual(r.checkDocumentFile({ type: "image/jpeg", size: 10 * MB }), { ok: false, error: "too_large" }, "10 MB no longer fits");
    assert.deepEqual(r.checkDocumentFile({ type: "image/jpeg", size: 1 }), { ok: true, ext: "jpg" });
    assert.deepEqual(r.checkDocumentFile({ type: "image/png", size: 1 }), { ok: true, ext: "png" });
  });

  await group("pure: which fields need approval — keyed on EVER verified (CRITICAL 1)", () => {
    for (const f of ["full_name", "licence", "vehicle"] as const) assert.equal(r.needsApproval(f, false), false, `${f} before any verification`);
    assert.equal(r.needsApproval("payout_account", false), true, "payout always");
    for (const f of r.CHANGE_FIELDS) assert.equal(r.needsApproval(f, true), true, `${f} once ever verified`);
    assert.equal(r.wasEverVerified({ verification_status: "pending", verified_at: "2026-10-01T00:00:00Z" }), true, "pending after an upload, but verified once");
    assert.equal(r.wasEverVerified({ verification_status: "verified", verified_at: null }), true);
    assert.equal(r.wasEverVerified({ verification_status: "rejected", verified_at: null }), false);
    assert.equal(r.wasEverVerified(null), false);
  });

  await group("pure: profile patch — validated, not cast; non-ASCII intact (Review Focus 5)", () => {
    let p = r.parseProfilePatch({
      address: { line: "  Flat 2, Rāma Nivās, शिवाजी नगर ", city: "Pune", pincode: "411 005" },
      emergency: { name: "Sunita Devi", phone: "+91 98765-43210", relation: "Mother" },
    });
    assert.ok(p.ok);
    if (p.ok) {
      assert.equal(p.value.address?.line, "Flat 2, Rāma Nivās, शिवाजी नगर");
      assert.equal(p.value.address?.pincode, "411005");
      assert.equal(p.value.emergency?.phone, "+919876543210");
    }
    p = r.parseProfilePatch({ address: { line: "", city: "", pincode: "" } });
    assert.ok(p.ok && p.value.address?.line === null && p.value.address?.pincode === null, "empty clears");
    assert.deepEqual(r.parseProfilePatch({ address: { pincode: "56001" } }), { ok: false, error: "invalid_value", field: "address.pincode" });
    assert.deepEqual(r.parseProfilePatch({ emergency: { phone: "12345" } }), { ok: false, error: "invalid_value", field: "emergency.phone" });
    assert.deepEqual(r.parseProfilePatch({ emergency: { name: "a\u0000b" } }), { ok: false, error: "invalid_value", field: "emergency.name" });
    assert.deepEqual(r.parseProfilePatch({ address: { line: "x".repeat(201) } }), { ok: false, error: "invalid_value", field: "address.line" });
    assert.deepEqual(r.parseProfilePatch({ licenceNumber: "X" }), { ok: false, error: "invalid_value", field: "licenceNumber" }, "unknown keys are refused");
    assert.deepEqual(r.parseProfilePatch({ vehicleType: "car" }), { ok: false, error: "invalid_value", field: "vehicleType" });
    assert.ok(r.parseProfilePatch({ vehicleType: "ev_bike" }).ok);
    assert.deepEqual(r.parseProfilePatch({}), { ok: false, error: "invalid_value", field: "body" }, "nothing to save");
    assert.deepEqual(r.parseProfilePatch([1]), { ok: false, error: "invalid_value", field: "body" });
    assert.deepEqual(r.parseProfilePatch({ address: "x" }), { ok: false, error: "invalid_value", field: "address" });
  });

  await group("pure: notificationPrefs patch — categories validated, locked can't go off, merge keeps the rest", async () => {
    const np = await import("../../src/lib/rider/notification-prefs");
    assert.deepEqual(r.parseProfilePatch({ notificationPrefs: { payouts: false, support: true } }), {
      ok: true,
      value: { notificationPrefs: { payouts: false, support: true } },
    });
    assert.deepEqual(r.parseProfilePatch({ notificationPrefs: {} }), { ok: true, value: { notificationPrefs: {} } });
    assert.deepEqual(r.parseProfilePatch({ notificationPrefs: { payouts: false }, vehicleType: "bike" }), {
      ok: true,
      value: { notificationPrefs: { payouts: false }, vehicleType: "bike" },
    });
    assert.deepEqual(r.parseProfilePatch({ notificationPrefs: { lottery: false } }), { ok: false, error: "invalid_value", field: "notificationPrefs.lottery" }, "unknown category");
    assert.deepEqual(r.parseProfilePatch({ notificationPrefs: { payouts: false, Offers: true } }), { ok: false, error: "invalid_value", field: "notificationPrefs.Offers" });
    assert.deepEqual(r.parseProfilePatch({ notificationPrefs: { payouts: "no" } }), { ok: false, error: "invalid_value", field: "notificationPrefs.payouts" }, "not a boolean");
    assert.deepEqual(r.parseProfilePatch({ notificationPrefs: { payouts: null } }), { ok: false, error: "invalid_value", field: "notificationPrefs.payouts" });
    assert.deepEqual(r.parseProfilePatch({ notificationPrefs: [] }), { ok: false, error: "invalid_value", field: "notificationPrefs" });
    assert.deepEqual(r.parseProfilePatch({ notificationPrefs: "off" }), { ok: false, error: "invalid_value", field: "notificationPrefs" });
    for (const c of np.LOCKED_CATEGORIES) {
      assert.deepEqual(r.parseProfilePatch({ notificationPrefs: { payouts: false, [c]: false } }), { ok: false, error: "locked_category", field: `notificationPrefs.${c}` }, `${c} cannot go off`);
      assert.ok(r.parseProfilePatch({ notificationPrefs: { [c]: true } }).ok, `${c}: true is accepted (a no-op)`);
    }
    // the merge: untouched categories keep their value; true removes the key; only false is stored
    assert.deepEqual(np.mergeNotificationPrefs({ payouts: false, cash: false }, { support: false }), { payouts: false, cash: false, support: false });
    assert.deepEqual(np.mergeNotificationPrefs({ payouts: false, cash: false }, { payouts: true }), { cash: false }, "true removes the key");
    assert.deepEqual(np.mergeNotificationPrefs({}, { documents: true }), {}, "true on an unset key stores nothing");
    assert.deepEqual(np.mergeNotificationPrefs({ offers: false, payouts: true, cash: "no" }, {}), {}, "locked, true and non-boolean entries are dropped");
    assert.deepEqual(np.mergeNotificationPrefs({ newer_category: false, cash: false }, { payouts: false }), { newer_category: false, cash: false, payouts: false }, "P7-R6: an unknown stored false is kept (a rollback must not unmute it)");
    assert.deepEqual(np.mergeNotificationPrefs({ newer_category: true, other: "x" }, {}), {}, "...but only a false");
    assert.deepEqual(np.mergeNotificationPrefs(JSON.parse('{"__proto__": false, "cash": false}'), {}), { cash: false }, "__proto__ is never copied");
    assert.equal(r.isNotificationPrefsOnly({ notificationPrefs: { cash: false } }), true, "P7-R5: prefs alone is not a profile edit");
    assert.equal(r.isNotificationPrefsOnly({ notificationPrefs: {} }), true);
    assert.equal(r.isNotificationPrefsOnly({ notificationPrefs: {}, vehicleType: "bike" }), false, "other fields keep the gate");
    assert.equal(r.isNotificationPrefsOnly({ notificationPrefs: {}, address: {} }), false);
    assert.equal(r.isNotificationPrefsOnly({ vehicleType: "bike" }), false);
    assert.equal(r.isNotificationPrefsOnly({}), false);
    assert.equal(r.isNotificationPrefsOnly(null), false, "an unreadable body is not 'prefs only'");
    assert.equal(r.isNotificationPrefsOnly([{ notificationPrefs: {} }]), false);
    assert.deepEqual(np.mergeNotificationPrefs(null, { cash: false }), { cash: false });
  });

  await group("pure: change requests — every field's shape", () => {
    let c = r.parseChangeRequest({ field: "full_name", value: { fullName: " रवि कुमार " } }, TODAY);
    assert.ok(c.ok && c.field === "full_name" && c.value.fullName === "रवि कुमार");
    assert.ok(r.parseChangeRequest({ field: "full_name", value: { fullName: "José O'Neil-Smith" } }, TODAY).ok);
    assert.deepEqual(r.parseChangeRequest({ field: "full_name", value: { fullName: "R2D2" } }, TODAY), { ok: false, error: "invalid_value", field: "fullName" });
    assert.deepEqual(r.parseChangeRequest({ field: "phone", value: {} }, TODAY), { ok: false, error: "invalid_field" });
    c = r.parseChangeRequest({ field: "licence", value: { number: "mh12 20110012345", expiresOn: "2031-01-01" } }, TODAY);
    assert.ok(c.ok && c.field === "licence" && c.value.number === "MH1220110012345");
    assert.deepEqual(r.parseChangeRequest({ field: "licence", value: { number: "MH1220110012345", expiresOn: "2020-01-01" } }, TODAY), { ok: false, error: "invalid_value", field: "expiresOn" });
    c = r.parseChangeRequest({ field: "vehicle", value: { type: "ev_bike", owner: "deligro", registration: "ka 01 ab 1234" } }, TODAY);
    assert.ok(c.ok && c.field === "vehicle" && c.value.registration === "KA01AB1234");
    assert.ok(r.parseChangeRequest({ field: "vehicle", value: { type: "bicycle", owner: "rider", registration: "" } }, TODAY).ok);
    assert.deepEqual(r.parseChangeRequest({ field: "vehicle", value: { type: "ev_bike", owner: "friend" } }, TODAY), { ok: false, error: "invalid_value", field: "owner" });
    c = r.parseChangeRequest({ field: "payout_account", value: { kind: "bank", holderName: "Ravi Kumar", accountNumber: "1234 5678 9012", confirmAccountNumber: "123456789012", ifsc: "hdfc0001234" } }, TODAY);
    assert.ok(c.ok && c.field === "payout_account" && c.value.kind === "bank" && c.value.accountNumber === "123456789012" && c.value.ifsc === "HDFC0001234");
    assert.deepEqual(
      r.parseChangeRequest({ field: "payout_account", value: { kind: "bank", holderName: "Ravi", accountNumber: "123456789012", confirmAccountNumber: "123456789013", ifsc: "HDFC0001234" } }, TODAY),
      { ok: false, error: "invalid_value", field: "confirmAccountNumber" }
    );
    assert.deepEqual(
      r.parseChangeRequest({ field: "payout_account", value: { kind: "bank", holderName: "Ravi", accountNumber: "123456789012", confirmAccountNumber: "123456789012", ifsc: "HDFC1001234" } }, TODAY),
      { ok: false, error: "invalid_value", field: "ifsc" }
    );
    c = r.parseChangeRequest({ field: "payout_account", value: { kind: "upi", upiId: " Ravi.Kumar@OkHDFC " } }, TODAY);
    assert.ok(c.ok && c.field === "payout_account" && c.value.kind === "upi" && c.value.upiId === "ravi.kumar@okhdfc");
    assert.deepEqual(r.parseChangeRequest({ field: "payout_account", value: { kind: "upi", upiId: "not-an-upi" } }, TODAY), { ok: false, error: "invalid_value", field: "upiId" });
    assert.deepEqual(r.parseChangeRequest({ field: "payout_account", value: { kind: "cash" } }, TODAY), { ok: false, error: "invalid_value", field: "kind" });
  });

  const doc = (type: string, status: string, expiresOn: string | null = null) => ({ type, status, expiresOn });
  await group("pure: documents complete — the matrix by vehicle owner", () => {
    const base = [doc("aadhaar", "verified"), doc("driving_licence", "verified", "2030-01-01"), doc("photo", "verified")];
    let s = r.documentsStatus(base, "deligro", TODAY);
    assert.deepEqual(s.required, ["aadhaar", "driving_licence", "photo"]);
    assert.equal(s.complete, true, "Deligro's bike: three documents");
    s = r.documentsStatus(base, "rider", TODAY);
    assert.deepEqual(s.required, ["aadhaar", "driving_licence", "photo", "vehicle_rc", "insurance", "puc"]);
    assert.deepEqual(s.missing, ["vehicle_rc", "insurance", "puc"], "own vehicle: RC, insurance and PUC too");
    assert.equal(s.complete, false);
    s = r.documentsStatus([...base, doc("vehicle_rc", "verified"), doc("insurance", "verified", "2027-01-01"), doc("puc", "pending", "2027-01-01")], "rider", TODAY);
    assert.deepEqual(s.awaitingReview, ["puc"]);
    assert.equal(s.complete, false);
    s = r.documentsStatus([doc("aadhaar", "rejected"), doc("aadhaar", "replaced"), doc("driving_licence", "verified", "2026-10-21"), doc("photo", "verified")], "deligro", TODAY);
    assert.deepEqual(s.rejected, ["aadhaar"]);
    assert.deepEqual(s.expired, ["driving_licence"], "past its day is expired, whatever the status says");
    assert.equal(r.documentsComplete([doc("aadhaar", "replaced"), doc("driving_licence", "verified", "2030-01-01"), doc("photo", "verified")], "deligro", TODAY), false, "a replaced row is not a document");
    assert.equal(r.documentsComplete(base, null, TODAY), true, "no owner recorded reads as Deligro's (the default)");
  });

  await group("pure: dispatch block — Review Focus 4 (off by default)", () => {
    const expiredLicence = [doc("driving_licence", "verified", "2026-10-21")];
    assert.equal(r.dispatchBlockedByDocuments(expiredLicence, "deligro", TODAY, false), false, "setting off: never blocked");
    assert.equal(r.dispatchBlockedByDocuments(expiredLicence, "deligro", TODAY, true), true);
    assert.equal(r.dispatchBlockedByDocuments([doc("driving_licence", "expired", "2026-10-21")], "deligro", TODAY, true), true);
    assert.equal(r.dispatchBlockedByDocuments([doc("driving_licence", "verified", TODAY)], "deligro", TODAY, true), false, "valid through today");
    const insurance = [doc("insurance", "verified", "2026-01-01")];
    assert.equal(r.dispatchBlockedByDocuments(insurance, "deligro", TODAY, true), false, "insurance on Deligro's bike does not apply");
    assert.equal(r.dispatchBlockedByDocuments(insurance, "rider", TODAY, true), true, "it does on the rider's own");
    assert.equal(r.dispatchBlockedByDocuments([], "deligro", TODAY, true), false, "a missing document is not an expired one");
    assert.equal(r.dispatchBlockedByDocuments([doc("driving_licence", "pending", "2030-01-01"), doc("aadhaar", "pending")], "deligro", TODAY, true), false,
      "a new rider whose documents wait for review never had one expire: not blocked by this switch");
  });

  await group("M3: a licence renewed BEFORE it expired never counts as expired - L1 renewed early, L2 verified, then a re-upload does not block", () => {
    const up = (type: string, status: string, expiresOn: string | null, uploadedAt: string) => ({ type, status, expiresOn, uploadedAt });
    const L1 = up("driving_licence", "replaced", "2026-10-10", "2026-01-01T09:00:00Z"); // renewed on 1 Sep, before 10 Oct
    const L2 = up("driving_licence", "replaced", "2030-01-01", "2026-09-01T09:00:00Z"); // verified, then replaced by L3
    const L3 = up("driving_licence", "pending", "2031-01-01", "2026-10-20T09:00:00Z");
    assert.equal(r.dispatchBlockedByDocuments([L1, L2, L3], "deligro", TODAY, true), false, "nothing was ever live past its date");
    assert.equal(r.dispatchBlockedByDocuments([L1, { ...L2, status: "verified" }], "deligro", TODAY, true), false, "with L2 still the live one");
    // L1 lapsed on 10 Oct and was only replaced on 15 Oct: it was live and expired.
    const lapsed = { ...L1, uploadedAt: "2026-01-01T09:00:00Z" };
    const late = up("driving_licence", "pending", "2031-01-01", "2026-10-15T09:00:00Z");
    assert.equal(r.dispatchBlockedByDocuments([lapsed, late], "deligro", TODAY, true), true, "replaced only after it lapsed: still blocks");
    // A row replaced on its last valid day was still in date (valid through that day).
    const lastDay = up("driving_licence", "pending", "2031-01-01", "2026-10-10T05:00:00Z");
    assert.equal(r.dispatchBlockedByDocuments([L1, lastDay], "deligro", TODAY, true), false, "replaced on its last valid day (IST)");
    // Without upload times the rule cannot tell, so it counts the row (fail closed).
    assert.equal(r.dispatchBlockedByDocuments([{ type: "driving_licence", status: "replaced", expiresOn: "2026-10-10" }], "deligro", TODAY, true), true);
  });

  await group("pure: P8-R8 - an expired type stays blocked until a VERIFIED, in-date document of it exists", () => {
    const expired = doc("driving_licence", "verified", "2026-10-01");
    // the three bypasses final review A found (block-probe.ts)
    assert.equal(r.dispatchBlockedByDocuments([expired], "deligro", TODAY, true), true, "verified licence expired");
    assert.equal(r.dispatchBlockedByDocuments([{ ...expired, status: "rejected" }], "deligro", TODAY, true), true,
      "an admin rejecting the expired licence does not clear it");
    assert.equal(r.dispatchBlockedByDocuments([{ ...expired, status: "replaced" }, doc("driving_licence", "pending", "2099-12-31")], "deligro", TODAY, true), true,
      "re-uploading anything with expiry 2099 (the old one replaced, the new one pending) does not clear it");
    assert.equal(r.dispatchBlockedByDocuments([doc("driving_licence", "replaced", "2020-01-01")], "deligro", TODAY, true), true,
      "an expired row stays on record when it is replaced");
    assert.equal(r.dispatchBlockedByDocuments([{ ...expired, status: "replaced" }, doc("driving_licence", "rejected", "2099-12-31")], "deligro", TODAY, true), true,
      "a rejected replacement does not clear it");
    // what clears it
    assert.equal(r.dispatchBlockedByDocuments([{ ...expired, status: "replaced" }, doc("driving_licence", "verified", "2030-01-01")], "deligro", TODAY, true), false,
      "staff verifying the in-date replacement clears it");
    assert.equal(r.dispatchBlockedByDocuments([{ ...expired, status: "replaced" }, doc("driving_licence", "expired", "2030-01-01")], "deligro", TODAY, true), true);
    assert.equal(r.dispatchBlockedByDocuments([doc("insurance", "rejected", "2026-01-01")], "deligro", TODAY, true), false,
      "a type that does not apply never blocks");
  });

  await group("pure: reminder stages — 30, 7, 1, expired; each once; the most urgent only", () => {
    const d = (expiresOn: string, stamps: Partial<Record<"r30" | "r7" | "r1" | "rx", boolean>> = {}, status = "verified") => ({
      expiresOn,
      status,
      reminded30: stamps.r30 ?? false,
      reminded7: stamps.r7 ?? false,
      reminded1: stamps.r1 ?? false,
      remindedExpired: stamps.rx ?? false,
    });
    assert.equal(r.reminderStage(d("2026-11-22"), TODAY), null, "31 days: nothing yet");
    assert.deepEqual(r.reminderStage(d("2026-11-21"), TODAY), { stage: 30, daysLeft: 30, stamps: ["reminded_30_at"] });
    assert.deepEqual(r.reminderStage(d("2026-11-03"), TODAY), { stage: 30, daysLeft: 12, stamps: ["reminded_30_at"] });
    assert.equal(r.reminderStage(d("2026-11-03", { r30: true }), TODAY), null, "sent once");
    assert.deepEqual(r.reminderStage(d("2026-10-29"), TODAY), { stage: 7, daysLeft: 7, stamps: ["reminded_30_at", "reminded_7_at"] }, "a late upload skips straight to 7");
    assert.deepEqual(r.reminderStage(d("2026-10-27", { r30: true }), TODAY), { stage: 7, daysLeft: 5, stamps: ["reminded_30_at", "reminded_7_at"] });
    assert.deepEqual(r.reminderStage(d("2026-10-23", { r30: true, r7: true }), TODAY), { stage: 1, daysLeft: 1, stamps: ["reminded_30_at", "reminded_7_at", "reminded_1_at"] });
    assert.deepEqual(r.reminderStage(d(TODAY, { r30: true, r7: true }), TODAY), { stage: 1, daysLeft: 0, stamps: ["reminded_30_at", "reminded_7_at", "reminded_1_at"] }, "expires today");
    assert.deepEqual(r.reminderStage(d("2026-10-21"), TODAY), {
      stage: "expired",
      daysLeft: -1,
      stamps: ["reminded_30_at", "reminded_7_at", "reminded_1_at", "reminded_expired_at"],
    });
    assert.equal(r.reminderStage(d("2026-10-21", { rx: true }), TODAY), null);
    assert.equal(r.reminderStage(d("2026-10-25", {}, "rejected"), TODAY), null, "a rejected document is not reminded");
    assert.equal(r.reminderStage(d("2026-10-25", {}, "replaced"), TODAY), null);
    assert.deepEqual(r.reminderStage(d("2026-10-21", { r30: true, r7: true, r1: true }, "expired"), TODAY)?.stage, "expired", "already marked expired still gets its one push");
  });

  await group("pure: needs attention", () => {
    const ok = [doc("aadhaar", "verified"), doc("driving_licence", "verified", "2030-01-01"), doc("photo", "verified")];
    assert.equal(r.profileNeedsAttention({ verification: "verified", docs: ok, owner: "deligro", today: TODAY }), false);
    assert.equal(r.profileNeedsAttention({ verification: "rejected", docs: ok, owner: "deligro", today: TODAY }), true);
    assert.equal(r.profileNeedsAttention({ verification: "unverified", docs: [], owner: "deligro", today: TODAY }), true, "documents missing");
    assert.equal(r.profileNeedsAttention({ verification: "verified", docs: [doc("aadhaar", "verified"), doc("driving_licence", "verified", "2026-11-01"), doc("photo", "verified")], owner: "deligro", today: TODAY }), true, "expiring within 30 days");
    assert.equal(r.profileNeedsAttention({ verification: "pending", docs: [doc("aadhaar", "pending"), doc("driving_licence", "pending", "2030-01-01"), doc("photo", "pending")], owner: "deligro", today: TODAY }), false, "waiting on Deligro is not the rider's to fix");
  });
}

// ---------------------------------------------------------------------------
// 2. data layer against a fake PostgREST + Storage
// ---------------------------------------------------------------------------
const db: Record<string, Row[]> = {};
const mode = {
  missingTables: new Set<string>(),
  missingColumns: new Set<string>(),
  failRpc: new Map<string, { code: string; message: string }>(),
  /** Runs once, just before the next PATCH is applied: another request's write landing in between. */
  beforePatch: null as null | (() => void),
  /** Runs before EVERY PATCH is applied: other requests keep winning the race. */
  interfere: null as null | (() => void),
  /** Runs once, just before the next POST (insert) is applied. */
  beforePost: null as null | (() => void),
  /** Every PATCH is refused with this PostgREST error. */
  patchError: null as null | { code: string; message: string },
};
const requests: { method: string; path: string; query: string; body: unknown }[] = [];
const rpcs: { name: string; args: Row }[] = [];
const storage = new Map<string, number>(); // path -> bytes
const t = (name: string): Row[] => (db[name] ??= []);
const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  mode.missingTables.clear();
  mode.missingColumns.clear();
  mode.failRpc.clear();
  mode.beforePatch = null;
  mode.patchError = null;
  mode.interfere = null;
  mode.beforePost = null;
  requests.length = 0;
  rpcs.length = 0;
  storage.clear();
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function compare(a: unknown, b: string): number {
  const n = Number(b);
  if (typeof a === "number" && Number.isFinite(n)) return a - n;
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
function canonicalText(text: string): string {
  try {
    return canonical(JSON.parse(text));
  } catch {
    return text;
  }
}

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (RESERVED.has(key)) continue;
    if (key === "or") throw new Error("fake PostgREST: or= is not supported");
    const value = row[key];
    const negate = raw.startsWith("not.");
    const body = negate ? raw.slice(4) : raw;
    const dot = body.indexOf(".");
    const op = body.slice(0, dot);
    const arg = body.slice(dot + 1);
    let hit: boolean;
    switch (op) {
      case "eq":
        // jsonb columns compare as JSON (key order does not matter), as Postgres does
        hit = value !== null && typeof value === "object" ? canonical(value) === canonicalText(arg) : String(value) === arg;
        break;
      case "neq": hit = String(value) !== arg; break;
      case "in": hit = arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(value)); break;
      case "is": hit = arg === "null" ? value === null || value === undefined : String(value) === arg; break;
      case "gt": hit = value != null && compare(value, arg) > 0; break;
      case "gte": hit = value != null && compare(value, arg) >= 0; break;
      case "lt": hit = value != null && compare(value, arg) < 0; break;
      case "lte": hit = value != null && compare(value, arg) <= 0; break;
      default: throw new Error(`fake PostgREST: unsupported filter ${key}=${raw}`);
    }
    if (negate ? hit : !hit) return false;
  }
  return true;
}

function ordered(rows: Row[], url: URL): Row[] {
  const spec = url.searchParams.get("order");
  if (!spec) return rows;
  const keys = spec.split(",").map((s) => {
    const [col, dir] = s.split(".");
    return { col, sign: dir === "desc" ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { col, sign } of keys) {
      const x = a[col];
      const y = b[col];
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * sign;
    }
    return 0;
  });
}

/** Only the selected columns, as PostgREST returns them (so a column the code forgets to select is missing). */
function project(rows: Row[], url: URL): Row[] {
  const sel = url.searchParams.get("select");
  if (!sel || sel === "*") return rows;
  const cols = sel.split(",").map((c) => c.trim()).filter(Boolean);
  return rows.map((row) => Object.fromEntries(cols.map((c) => [c, row[c] ?? null])));
}

/** The 0086 SQL functions, as the fake runs them. */
const RPC: Record<string, (args: Row) => { code: number; body: unknown }> = {
  rider_add_document(a) {
    const docs = t("rider_documents");
    for (const d of docs) if (d.driver_id === a.p_driver && d.doc_type === a.p_type && d.status !== "replaced") d.status = "replaced";
    const id = uid(9000 + docs.length + 1);
    docs.push({
      id,
      driver_id: a.p_driver,
      doc_type: a.p_type,
      // mask_rider_aadhaar, as the database does it
      number: a.p_type === "aadhaar" ? null : a.p_number,
      number_masked: a.p_number_masked,
      file_path: a.p_file_path,
      expires_on: a.p_expires_on,
      status: "pending",
      remarks: null,
      reviewed_by: null,
      reviewed_at: null,
      reminded_30_at: null,
      reminded_7_at: null,
      reminded_1_at: null,
      reminded_expired_at: null,
      created_at: new Date().toISOString(),
    });
    const prof = t("rider_profiles").find((p) => p.driver_id === a.p_driver);
    // P6-R1 / P8-R9: only an unverified rider moves to pending; rejected stays rejected.
    if (prof && prof.verification_status === "unverified") prof.verification_status = "pending";
    return { code: 200, body: id };
  },
  rider_decide_change_request(a) {
    const req = t("rider_profile_change_requests").find((x) => x.id === a.p_request);
    if (!req) return { code: 404, body: { code: "P0002", message: "not_found" } };
    if (req.status !== "pending") return { code: 400, body: { code: "22023", message: "already_decided" } };
    const prof = t("rider_profiles").find((p) => p.driver_id === req.driver_id);
    if (a.p_decision === "approve" && a.p_actor === null && (req.field === "payout_account" || prof?.verified_at)) {
      return { code: 403, body: { code: "42501", message: "approval_required" } };
    }
    if (a.p_decision === "approve") {
      const v = req.new_value;
      if (req.field === "licence" && prof) Object.assign(prof, { licence_number: v.number, licence_expires_on: v.expiresOn });
      if (req.field === "vehicle" && prof) Object.assign(prof, { vehicle_type: v.type, vehicle_owner: v.owner, vehicle_registration: v.registration || null });
      if (req.field === "full_name") {
        const p = t("profiles").find((x) => x.id === req.driver_id);
        if (p) p.full_name = v.fullName;
      }
      if (req.field === "payout_account") {
        const staged = t("rider_payout_accounts_staged").find((s) => s.id === v.stagedId && s.driver_id === req.driver_id);
        if (!staged) return { code: 400, body: { code: "22023", message: "staged_missing" } };
        const main = t("rider_payout_accounts");
        const at = main.findIndex((m) => m.driver_id === req.driver_id);
        const row = { driver_id: req.driver_id, kind: staged.kind, holder_name: staged.holder_name, account_number: staged.account_number, ifsc: staged.ifsc, upi_id: staged.upi_id, updated_at: new Date().toISOString(), updated_by: a.p_actor };
        if (at >= 0) main[at] = row;
        else main.push(row);
        db.rider_payout_accounts_staged = t("rider_payout_accounts_staged").filter((s) => s.id !== staged.id);
      }
    } else if (req.field === "payout_account") {
      db.rider_payout_accounts_staged = t("rider_payout_accounts_staged").filter((s) => !(s.id === req.new_value.stagedId && s.driver_id === req.driver_id));
    }
    Object.assign(req, {
      status: a.p_decision === "approve" ? "approved" : "rejected",
      decided_by: a.p_actor,
      decided_at: new Date().toISOString(),
      decision_note: a.p_note,
    });
    return { code: 200, body: { id: req.id, driverId: req.driver_id, field: req.field, status: req.status } };
  },
};

let seq = 0;
/** A UUID-shaped id, as the database issues them. */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };
    // ---- Storage ----
    if (url.pathname.startsWith("/storage/v1/")) {
      const rest = url.pathname.slice("/storage/v1/".length);
      requests.push({ method: req.method ?? "", path: `storage/${rest}`, query: url.search, body: raw.length });
      if (mode.missingTables.has("bucket:rider-documents")) return send(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
      if (req.method === "POST" && rest.startsWith("object/sign/rider-documents/")) {
        const path = decodeURIComponent(rest.slice("object/sign/rider-documents/".length));
        return send(200, { signedURL: `/object/sign/rider-documents/${path}?token=t${++seq}` });
      }
      if (req.method === "POST" && rest.startsWith("object/rider-documents/")) {
        const path = decodeURIComponent(rest.slice("object/rider-documents/".length));
        storage.set(path, raw.length);
        return send(200, { Key: `rider-documents/${path}`, Id: `obj-${++seq}` });
      }
      if (req.method === "DELETE" && rest === "object/rider-documents") {
        const body = JSON.parse(raw.toString() || "{}") as { prefixes?: string[] };
        for (const p of body.prefixes ?? []) storage.delete(p);
        return send(200, []);
      }
      return send(500, { message: `unhandled storage ${req.method} ${rest}` });
    }
    // ---- PostgREST ----
    const table = url.pathname.replace("/rest/v1/", "");
    let body: Row | Row[] | null = null;
    try {
      body = raw.length ? JSON.parse(raw.toString()) : null;
    } catch {
      body = null;
    }
    requests.push({ method: req.method ?? "", path: table, query: url.search, body });
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const respond = (rows: Row[], code = 200) => {
      if (!single) return send(code, rows);
      if (rows.length !== 1) return send(406, { code: "PGRST116", message: "0 rows" });
      return send(code, rows[0]);
    };
    if (table === "rpc/obs_ingest" || table === "rpc/rate_limit_hit") return send(200, null);
    if (table.startsWith("rpc/")) {
      const name = table.slice(4);
      rpcs.push({ name, args: (body ?? {}) as Row });
      if (mode.missingTables.has(table)) return send(404, { code: "PGRST202", message: `Could not find the function public.${name}` });
      const fail = mode.failRpc.get(name);
      if (fail) return send(400, fail);
      const fn = RPC[name];
      if (!fn) return send(200, null);
      const out = fn((body ?? {}) as Row);
      return send(out.code, out.body);
    }
    if (mode.missingTables.has(table)) {
      return send(404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` });
    }
    const sel = url.searchParams.get("select") ?? "";
    for (const col of mode.missingColumns) {
      const [tb, c] = col.split(".");
      if (tb === table && sel.split(",").map((s) => s.trim()).includes(c)) {
        return send(400, { code: "42703", message: `column ${table}.${c} does not exist` });
      }
    }
    if ((req.method === "PATCH" || req.method === "POST") && body && !Array.isArray(body)) {
      // PostgREST: a written column the schema cache lacks is PGRST204
      for (const col of mode.missingColumns) {
        const [tb, c] = col.split(".");
        if (tb === table && c in body) return send(400, { code: "PGRST204", message: `Could not find the '${c}' column of '${table}' in the schema cache` });
      }
    }
    if (req.method === "GET" || req.method === "HEAD") {
      let rows = ordered(t(table).filter((r) => matches(r, url)), url);
      const offset = Number(url.searchParams.get("offset"));
      if (offset > 0) rows = rows.slice(offset);
      const limit = Number(url.searchParams.get("limit"));
      if (limit > 0) rows = rows.slice(0, limit);
      // PostgREST's max-rows: no response carries more than 1000 rows.
      rows = rows.slice(0, 1000);
      return respond(project(rows, url));
    }
    if (req.method === "PATCH" && body && !Array.isArray(body)) {
      if (mode.patchError) return send(400, mode.patchError);
      mode.interfere?.();
      if (mode.beforePatch) {
        const fn = mode.beforePatch;
        mode.beforePatch = null;
        fn();
      }
      const hit = t(table).filter((r) => matches(r, url));
      for (const row of hit) Object.assign(row, body);
      return respond(project(hit, url));
    }
    if (req.method === "DELETE") {
      const keep = t(table).filter((r) => !matches(r, url));
      const gone = t(table).filter((r) => matches(r, url));
      db[table] = keep;
      return respond(project(gone, url));
    }
    if (req.method === "POST" && body) {
      if (mode.beforePost) {
        const fn = mode.beforePost;
        mode.beforePost = null;
        fn();
      }
      if (table === "rider_profiles" && (Array.isArray(body) ? body : [body]).some((r) => t(table).some((x) => x.driver_id === r.driver_id))) {
        return send(409, { code: "23505", message: 'duplicate key value violates unique constraint "rider_profiles_pkey"' });
      }
      const incoming = (Array.isArray(body) ? body : [body]).map((r) => ({ ...r }));
      const prefer = String(req.headers.prefer ?? "");
      const onConflict = url.searchParams.get("on_conflict");
      for (const row of incoming) {
        if (table === "rider_profile_change_requests") {
          if (row.status === undefined) row.status = "pending";
          const dup = t(table).some((x) => x.driver_id === row.driver_id && x.field === row.field && x.status === "pending");
          if (dup && row.status === "pending") return send(409, { code: "23505", message: "duplicate key value violates unique constraint \"rider_profile_change_requests_one_pending_idx\"" });
          row.created_at ??= new Date(Date.UTC(2026, 9, 22, 6, 0, ++seq)).toISOString();
          row.decided_by ??= null;
          row.decided_at ??= null;
          row.decision_note ??= null;
        }
        row.id ??= `${table}-${++seq}`;
        if (onConflict && prefer.includes("merge-duplicates")) {
          const at = t(table).findIndex((x) => x[onConflict] === row[onConflict]);
          if (at >= 0) {
            Object.assign(t(table)[at], row);
            continue;
          }
        }
        t(table).push(row);
      }
      return respond(project(incoming, url), 201);
    }
    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

function seedRider(driverId: string, over: Row = {}): void {
  t("profiles").push({ id: driverId, role: "driver", full_name: "Ravi Kumar", phone: "+919000000001", avatar_url: null });
  t("rider_profiles").push({
    driver_id: driverId,
    rider_code: driverId === D1 ? "DR-0001" : "DR-0002",
    address_line: null,
    city: null,
    pincode: null,
    vehicle_type: null,
    vehicle_owner: "deligro",
    vehicle_registration: null,
    licence_number: null,
    licence_expires_on: null,
    emergency_name: null,
    emergency_phone: null,
    emergency_relation: null,
    verification_status: "unverified",
    verified_at: null,
    verified_by: null,
    verification_note: null,
    notification_prefs: {}, // not null default '{}' (0086)
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  });
}

function docRow(driverId: string, type: string, over: Row = {}): Row {
  return {
    id: uid(++seq),
    driver_id: driverId,
    doc_type: type,
    number: null,
    number_masked: null,
    file_path: `${driverId}/${type}/f.pdf`,
    expires_on: null,
    status: "verified",
    remarks: null,
    reviewed_by: null,
    reviewed_at: null,
    reminded_30_at: null,
    reminded_7_at: null,
    reminded_1_at: null,
    reminded_expired_at: null,
    created_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

/** A File whose bytes start with `head` and whose declared type is `type`. */
function fileOf(name: string, type: string, head: number[], size = 2048): File {
  const bytes = new Uint8Array(size);
  bytes.set(head.slice(0, size));
  return new File([bytes], name, { type });
}
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const MP4 = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32];
const JPG = [0xff, 0xd8, 0xff, 0xe0];

async function dataTier(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const x = {
    ...(await import("../../src/lib/data-access/rider-profile")),
    ...(await import("../../src/lib/data-access/rider-document-block")),
  };
  const pay = await import("../../src/lib/data-access/rider-payout-accounts");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");
  const now = new Date("2026-10-22T10:00:00+05:30");

  await group("data: Review Focus 1 — a 40 MB video renamed .pdf is refused and nothing is stored", async () => {
    reset();
    seedRider(D1);
    const big = fileOf("licence.pdf", "application/pdf", MP4, 40 * 1024 * 1024);
    assert.deepEqual(await x.uploadRiderDocument(D1, { type: "pan", number: "ABCDE1234F", file: big }), { ok: false, error: "too_large" });
    const small = fileOf("licence.pdf", "application/pdf", MP4);
    assert.deepEqual(await x.uploadRiderDocument(D1, { type: "pan", number: "ABCDE1234F", file: small }), { ok: false, error: "bad_type" }, "the bytes are MP4, whatever the name says");
    const lying = fileOf("photo.jpg", "image/jpeg", PDF);
    assert.deepEqual(await x.uploadRiderDocument(D1, { type: "photo", file: lying }), { ok: false, error: "bad_type" }, "a PDF declared as JPEG");
    assert.equal(storage.size, 0, "no object written");
    assert.equal(requests.filter((q) => q.path.startsWith("storage/")).length, 0, "storage never called");
    assert.equal(rpcs.filter((q) => q.name === "rider_add_document").length, 0, "no row written");
  });

  await group("data: a valid upload — path built by the server, Aadhaar masked before it leaves", async () => {
    reset();
    seedRider(D1);
    const res = await x.uploadRiderDocument(D1, { type: "aadhaar", number: "1234 5678 9012", file: fileOf("../../etc/passwd.pdf", "application/pdf", PDF) });
    assert.ok(res.ok, JSON.stringify(res));
    const [path] = [...storage.keys()];
    assert.match(path, new RegExp(`^${D1}/aadhaar/[0-9a-f-]{36}\\.pdf$`), "nothing from the client shapes the path");
    const call = rpcs.find((q) => q.name === "rider_add_document");
    assert.equal(call?.args.p_number, null, "the twelve digits never reach the database");
    assert.equal(call?.args.p_number_masked, "XXXX-XXXX-9012");
    assert.equal(call?.args.p_file_path, path);
    assert.equal(t("rider_profiles")[0].verification_status, "pending");
    const lic = await x.uploadRiderDocument(D1, { type: "driving_licence", number: "MH1220110012345", file: fileOf("l.jpg", "image/jpeg", JPG) });
    assert.deepEqual(lic, { ok: false, error: "expiry_required" });
  });

  await group("data: a failed record removes the stored file", async () => {
    reset();
    seedRider(D1);
    mode.failRpc.set("rider_add_document", { code: "22023", message: "expiry_required" });
    const res = await x.uploadRiderDocument(D1, { type: "puc", expiresOn: "2027-01-01", file: fileOf("p.png", "image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    assert.deepEqual(res, { ok: false, error: "expiry_required" });
    assert.equal(storage.size, 0, "uploaded then removed");
  });

  await group("data: Review Focus 2 — another rider's document id gives no URL and no signing request", async () => {
    reset();
    seedRider(D1);
    seedRider(D2);
    const mine = docRow(D1, "pan");
    const theirs = docRow(D2, "pan");
    t("rider_documents").push(mine, theirs);
    assert.equal(await x.riderDocumentUrl(D1, theirs.id), null);
    assert.equal(await x.riderDocumentUrl(D1, "not-a-uuid"), null);
    assert.equal(requests.filter((q) => q.path.startsWith("storage/")).length, 0, "nothing was signed");
    const url = await x.riderDocumentUrl(D1, mine.id);
    assert.ok(url && url.includes(`/object/sign/rider-documents/${D1}/pan/f.pdf`), String(url));
    const sign = requests.find((q) => q.path.startsWith("storage/object/sign/"));
    assert.ok(sign, "signed once");
    const replaced = docRow(D1, "photo", { status: "replaced" });
    t("rider_documents").push(replaced);
    assert.equal(await x.riderDocumentUrl(D1, replaced.id), null, "a replaced file is not served");
  });

  await group("data: the profile — own rows only, payout masked, replaced documents hidden", async () => {
    reset();
    seedRider(D1, { address_line: "Flat 2, शिवाजी नगर", licence_number: "MH1220110012345", licence_expires_on: "2031-01-01", verification_status: "verified" });
    seedRider(D2);
    t("rider_documents").push(
      docRow(D1, "aadhaar", { number_masked: "XXXX-XXXX-9012" }),
      docRow(D1, "pan", { status: "replaced" }),
      docRow(D1, "pan", { status: "pending", number: "ABCDE1234F", number_masked: "XXXX234F" }),
      docRow(D2, "photo")
    );
    t("rider_payout_accounts").push({ driver_id: D1, kind: "bank", holder_name: "Ravi Kumar", account_number: "123456789012", ifsc: "HDFC0001234", upi_id: null });
    const p = await x.getRiderProfile(D1, now);
    assert.equal(p.riderCode, "DR-0001");
    assert.equal(p.address.line, "Flat 2, शिवाजी नगर");
    assert.equal(p.licence.number, "MH1220110012345", "the rider sees their own licence number");
    assert.deepEqual(p.payoutAccount, { kind: "bank", masked: "XXXX9012" });
    assert.equal(JSON.stringify(p).includes("123456789012"), false, "the account number never leaves");
    assert.equal(JSON.stringify(p).includes("HDFC0001234"), false, "nor the IFSC");
    assert.equal(JSON.stringify(p).includes("ABCDE1234F"), false, "document numbers are masked");
    assert.deepEqual(p.documents.map((d) => d.type).sort(), ["aadhaar", "pan"], "another rider's and replaced rows never show");
    assert.equal(p.verification, "verified");
    assert.ok(requests.filter((q) => q.path === "rider_documents").every((q) => q.query.includes(`driver_id=eq.${D1}`)));
  });

  await group("data: Review Focus 3 — a bank change is a request; the approved account is untouched", async () => {
    reset();
    seedRider(D1, { verification_status: "verified" });
    t("rider_payout_accounts").push({ driver_id: D1, kind: "bank", holder_name: "Ravi Kumar", account_number: "123456789012", ifsc: "HDFC0001234", upi_id: null });
    const res = await x.requestProfileChange(D1, "payout_account", { kind: "bank", holderName: "Ravi Kumar", accountNumber: "999900001111", confirmAccountNumber: "999900001111", ifsc: "ICIC0004321" });
    assert.ok(res.ok && res.status === "pending", JSON.stringify(res));
    assert.equal(t("rider_payout_accounts")[0].account_number, "123456789012", "a payout still goes to the approved account");
    const req = t("rider_profile_change_requests")[0];
    assert.deepEqual(Object.keys(req.new_value), ["stagedId"], "the request carries only a reference");
    assert.equal(t("rider_payout_accounts_staged")[0].account_number, "999900001111");
    const p = await x.getRiderProfile(D1, now);
    assert.deepEqual(p.payoutAccount, { kind: "bank", masked: "XXXX9012" });
    assert.equal(p.pendingChanges.length, 1);
    assert.equal(p.pendingChanges[0].field, "payout_account");
    assert.equal(p.pendingChanges[0].summary, "XXXX1111", "the pending one is masked too");
    const view = await pay.getPayoutAccountForAdmin(D1);
    assert.equal(view.account?.accountNumber, "123456789012", "the admin sees the approved account in full");
    assert.equal(view.pending?.accountNumber, "999900001111", "...and the pending one beside it");
    const again = await x.requestProfileChange(D1, "payout_account", { kind: "upi", upiId: "ravi@ybl" });
    assert.deepEqual(again, { ok: false, error: "duplicate_pending" });
    assert.equal(t("rider_payout_accounts_staged").length, 1, "the refused second proposal left no staged copy");
  });

  await group("data: unverified fields save directly (recorded); verified ones wait", async () => {
    reset();
    seedRider(D1);
    let res = await x.requestProfileChange(D1, "licence", { number: "MH1220110012345", expiresOn: "2031-01-01" });
    assert.ok(res.ok && res.status === "applied", JSON.stringify(res));
    assert.equal(t("rider_profiles")[0].licence_number, "MH1220110012345");
    const rec = t("rider_profile_change_requests")[0];
    assert.equal(rec.status, "approved");
    assert.equal(rec.decided_by, null, "applied by the server, not an admin");
    t("rider_profiles")[0].verification_status = "verified";
    res = await x.requestProfileChange(D1, "vehicle", { type: "ev_bike", owner: "deligro", registration: "KA01AB1234" });
    assert.ok(res.ok && res.status === "pending");
    assert.equal(t("rider_profiles")[0].vehicle_type, null, "not applied");
    assert.deepEqual(await x.requestProfileChange(D1, "vehicle", { type: "bike", owner: "deligro" }), { ok: false, error: "duplicate_pending" });
    assert.deepEqual(await x.requestProfileChange(D1, "licence", { number: "??", expiresOn: "2031-01-01" }), { ok: false, error: "invalid_value", field: "number" });
    assert.deepEqual(await x.updateRiderProfileDirect(D1, { vehicleType: "bike" }), { ok: false, error: "needs_approval", field: "vehicleType" });
    assert.deepEqual(await x.updateRiderProfileDirect(D1, { address: { line: "Flat 9", city: "Pune", pincode: "411005" } }), { ok: true });
    assert.equal(t("rider_profiles")[0].pincode, "411005");
    const list = await x.listChangeRequests(D1);
    assert.equal(list.length, 2);
    assert.ok(list.every((c) => !("new_value" in c) && !("newValue" in c)), "the stored value is not echoed");
  });

  await group("data: CRITICAL 1 — a verified rider's upload cannot reopen verified fields", async () => {
    reset();
    seedRider(D1, { verification_status: "verified", verified_at: "2026-10-01T00:00:00Z", vehicle_owner: "deligro", vehicle_type: "ev_bike" });
    const up = await x.uploadRiderDocument(D1, { type: "photo", file: fileOf("p.jpg", "image/jpeg", JPG) });
    assert.ok(up.ok);
    assert.equal(t("rider_profiles")[0].verification_status, "verified", "P6-R1: still verified; only the document waits");
    // Even if the status reads pending (an older upload, the other surface), verified_at decides.
    t("rider_profiles")[0].verification_status = "pending";
    for (const [field, value] of [
      ["full_name", { fullName: "Somebody Else" }],
      ["licence", { number: "MH1420250099999", expiresOn: "2036-05-01" }],
      ["vehicle", { type: "bike", owner: "rider", registration: "KA01AB1234" }],
    ] as const) {
      const res = await x.requestProfileChange(D1, field, value);
      assert.ok(res.ok && res.status === "pending", `${field}: ${JSON.stringify(res)}`);
    }
    const p = t("rider_profiles")[0];
    assert.equal(p.vehicle_owner, "deligro", "vehicle_owner not flipped");
    assert.equal(p.licence_number, null, "licence not applied");
    assert.equal(t("profiles")[0].full_name, "Ravi Kumar", "name not applied");
    assert.deepEqual(await x.updateRiderProfileDirect(D1, { vehicleType: "bike" }), { ok: false, error: "needs_approval", field: "vehicleType" });
    assert.ok(rpcs.filter((q) => q.name === "rider_decide_change_request").length === 0, "nothing applied without an admin");
  });

  await group("data: the database's approval_required wins over a stale read (request stays pending)", async () => {
    reset();
    seedRider(D1);
    // The server read 'unverified'; the database has verified_at by the time it applies.
    const orig = RPC.rider_decide_change_request;
    RPC.rider_decide_change_request = () => ({ code: 403, body: { code: "42501", message: "approval_required" } });
    try {
      const res = await x.requestProfileChange(D1, "licence", { number: "MH1220110012345", expiresOn: "2031-01-01" });
      assert.ok(res.ok && res.status === "pending", JSON.stringify(res));
      assert.equal(t("rider_profile_change_requests")[0].status, "pending");
    } finally {
      RPC.rider_decide_change_request = orig;
    }
  });

  await group("data: expiry reminders — each sent once, the most urgent only, expiry marked", async () => {
    reset();
    seedRider(D1);
    seedRider(D2);
    t("rider_documents").push(
      docRow(D1, "driving_licence", { expires_on: "2026-11-10" }), // 19 days -> 30
      docRow(D2, "driving_licence", { expires_on: "2026-10-25" }), // 3 days -> 7
      docRow(D2, "insurance", { expires_on: "2026-10-20", status: "pending" }), // expired
      docRow(D1, "puc", { expires_on: "2026-10-20", status: "replaced" }), // ignored
      docRow(D1, "pan", { expires_on: "2027-12-01" }) // far off
    );
    const pushes: { driverId: string; type: string; daysLeft: number }[] = [];
    const push = async (driverId: string, d: { type: string; daysLeft: number }) => {
      pushes.push({ driverId, ...d });
    };
    const n = await x.sendDocumentExpiryReminders(now, { push });
    assert.equal(n, 3);
    assert.deepEqual(pushes.map((p) => `${p.driverId.slice(-2)}:${p.type}:${p.daysLeft}`).sort(), ["d1:driving_licence:19", "d2:driving_licence:3", "d2:insurance:-2"]);
    const ins = t("rider_documents").find((d) => d.doc_type === "insurance");
    assert.equal(ins?.status, "expired", "past its day: marked expired");
    assert.ok(ins?.reminded_expired_at && ins.reminded_1_at && ins.reminded_7_at && ins.reminded_30_at, "every earlier stage stamped with it");
    const n2 = await x.sendDocumentExpiryReminders(now, { push });
    assert.equal(n2, 0, "a second run the same day sends nothing");
    assert.equal(pushes.length, 3);
  });

  await group("data: dispatch filter (Review Focus 4) — off reads nothing; on blocks only expired riders", async () => {
    reset();
    seedRider(D1);
    seedRider(D2, { vehicle_owner: "rider" });
    t("platform_settings").push({ id: true, block_dispatch_on_expired_docs: false });
    t("rider_documents").push(docRow(D1, "driving_licence", { expires_on: "2026-10-01" }), docRow(D2, "insurance", { expires_on: "2026-10-01" }));
    let blocked = await x.loadDocumentBlockedRiders([D1, D2], now);
    assert.equal(blocked.size, 0, "off: nobody");
    assert.equal(requests.filter((q) => q.path === "rider_documents").length, 0, "off: documents not even read");
    t("platform_settings")[0].block_dispatch_on_expired_docs = true;
    blocked = await x.loadDocumentBlockedRiders([D1, D2], now);
    assert.deepEqual([...blocked].sort(), [D1, D2].sort());
    t("rider_profiles")[1].vehicle_owner = "deligro";
    blocked = await x.loadDocumentBlockedRiders([D1, D2], now);
    assert.deepEqual([...blocked], [D1], "insurance does not apply on Deligro's bike");
    assert.equal(await x.riderBlockedByDocuments(D1, now), true, "the accept path asks the same question");
    assert.equal(await x.riderBlockedByDocuments(D2, now), false);
    mode.missingColumns.add("platform_settings.block_dispatch_on_expired_docs");
    blocked = await x.loadDocumentBlockedRiders([D1, D2], now);
    assert.equal(blocked.size, 0, "before 0086 there is no setting to be on");
  });

  await group("M3 (data): the loader passes upload times - an early renewal followed by a re-upload does not block", async () => {
    reset();
    seedRider(D1);
    t("platform_settings").push({ id: true, block_dispatch_on_expired_docs: true });
    t("rider_documents").push(
      docRow(D1, "driving_licence", { expires_on: "2026-10-10", status: "replaced", created_at: "2026-01-01T09:00:00Z" }),
      docRow(D1, "driving_licence", { expires_on: "2030-01-01", status: "replaced", created_at: "2026-09-01T09:00:00Z" }),
      docRow(D1, "driving_licence", { expires_on: "2031-01-01", status: "pending", created_at: "2026-10-20T09:00:00Z" })
    );
    assert.equal(await x.riderBlockedByDocuments(D1, now), false);
  });

  await group("M1: more than 1000 document rows in one chunk - the expired licence past row 1000 is still found (paged read)", async () => {
    reset();
    seedRider(D1);
    seedRider(D2);
    t("platform_settings").push({ id: true, block_dispatch_on_expired_docs: true });
    // 1000 harmless rows of D2's first, then D1's expired licence: an unpaged read stops at row 1000.
    for (let i = 0; i < 1000; i++) t("rider_documents").push(docRow(D2, "photo", { status: "replaced" }));
    t("rider_documents").push(docRow(D1, "driving_licence", { expires_on: "2026-10-01" }));
    assert.deepEqual([...(await x.loadDocumentBlockedRiders([D1, D2], now))], [D1]);
    assert.equal(await x.riderBlockedByDocuments(D1, now), true);
  });

  await group("data: P8-R8 - re-uploading or a rejection does not unblock; verifying an in-date replacement does", async () => {
    reset();
    seedRider(D1);
    seedRider(D2);
    t("platform_settings").push({ id: true, block_dispatch_on_expired_docs: true });
    t("rider_documents").push(
      // D1 re-uploaded junk with expiry 2099: the old one replaced, the new one pending
      docRow(D1, "driving_licence", { expires_on: "2026-10-01", status: "replaced" }),
      docRow(D1, "driving_licence", { expires_on: "2099-12-31", status: "pending" }),
      // D2's expired licence was rejected by an admin
      docRow(D2, "driving_licence", { expires_on: "2026-10-01", status: "rejected" })
    );
    assert.deepEqual([...(await x.loadDocumentBlockedRiders([D1, D2], now))].sort(), [D1, D2].sort());
    assert.equal(await x.riderBlockedByDocuments(D1, now), true, "the accept path too");
    t("rider_documents")[1].status = "verified";
    assert.deepEqual([...(await x.loadDocumentBlockedRiders([D1, D2], now))], [D2], "D1's replacement verified and in date: clear");
  });

  await group("data: a database without 0086 is RiderSchemaPendingError (503), reads and writes", async () => {
    reset();
    seedRider(D1);
    mode.missingTables.add("rider_documents");
    await assert.rejects(x.getRiderProfile(D1, now), (e: unknown) => isRiderSchemaPending(e));
    reset();
    seedRider(D1);
    mode.missingColumns.add("rider_profiles.verification_status");
    await assert.rejects(x.getRiderProfile(D1, now), (e: unknown) => isRiderSchemaPending(e));
    assert.equal(await x.getRiderProfileStatus(D1, now), null, "/api/rider/me degrades to null, not an error");
    reset();
    seedRider(D1);
    mode.missingTables.add("rpc/rider_add_document");
    await assert.rejects(
      x.uploadRiderDocument(D1, { type: "photo", file: fileOf("p.jpg", "image/jpeg", JPG) }),
      (e: unknown) => isRiderSchemaPending(e)
    );
    assert.equal(storage.size, 0, "the uploaded file is removed again");
    reset();
    seedRider(D1);
    mode.missingTables.add("bucket:rider-documents");
    await assert.rejects(
      x.uploadRiderDocument(D1, { type: "photo", file: fileOf("p.jpg", "image/jpeg", JPG) }),
      (e: unknown) => isRiderSchemaPending(e)
    );
    reset();
    seedRider(D1);
    mode.missingTables.add("rider_payout_accounts_staged");
    await assert.rejects(
      x.requestProfileChange(D1, "payout_account", { kind: "upi", upiId: "ravi@ybl" }),
      (e: unknown) => isRiderSchemaPending(e)
    );
  });

  const ALL_ON = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, true]));
  const storedPrefs = (id: string) => t("rider_profiles").find((p) => p.driver_id === id)?.notification_prefs;

  await group("data: GET shape - profile.notificationPrefs has every category as a boolean; locked always true", async () => {
    reset();
    seedRider(D1);
    let p = await x.getRiderProfile(D1, now);
    assert.deepEqual(p.notificationPrefs, ALL_ON, "nothing stored: everything on");
    assert.deepEqual(Object.keys(p.notificationPrefs), [...NOTIFICATION_CATEGORIES], "every category, in the app's order");
    reset();
    seedRider(D1, { notification_prefs: { payouts: false, offers: false, safety: false, cash: "no", junk: false } });
    p = await x.getRiderProfile(D1, now);
    const json = JSON.parse(JSON.stringify(p)) as { notificationPrefs: Record<string, unknown> };
    assert.deepEqual(json.notificationPrefs, { ...ALL_ON, payouts: false }, "stored locked falses and junk are ignored; only a real false mutes");
    assert.ok(Object.values(json.notificationPrefs).every((v) => typeof v === "boolean"));
    for (const c of LOCKED_CATEGORIES) assert.equal(json.notificationPrefs[c], true);
  });

  await group("data: P6-R3 - the profile exposes everVerified (verified_at set, or verified now)", async () => {
    const ever = async (over: Row) => {
      reset();
      seedRider(D1, over);
      const p = await x.getRiderProfile(D1, now);
      return JSON.parse(JSON.stringify(p)).everVerified;
    };
    assert.equal(await ever({ verification_status: "verified", verified_at: "2026-09-01T00:00:00Z" }), true, "verified");
    assert.equal(await ever({ verification_status: "pending", verified_at: null }), false, "pending, never verified");
    assert.equal(await ever({ verification_status: "rejected", verified_at: "2026-09-01T00:00:00Z" }), true, "rejected after having been verified");
    assert.equal(await ever({ verification_status: "unverified", verified_at: null }), false);
    reset();
    assert.equal((await x.getRiderProfile(D1, now)).everVerified, false, "no profile row");
  });

  await group("data: notification prefs - merge keeps the other switches; true removes the key; nothing else is touched", async () => {
    reset();
    seedRider(D1, { address_line: "Flat 2", verification_status: "verified", verified_at: "2026-09-01T00:00:00Z" });
    seedRider(D2);
    let out = await x.updateNotificationPrefs(D1, { payouts: false });
    assert.deepEqual(storedPrefs(D1), { payouts: false });
    assert.deepEqual(out, { ...ALL_ON, payouts: false }, "returns the effective prefs");
    out = await x.updateNotificationPrefs(D1, { cash: false, support: false });
    assert.deepEqual(storedPrefs(D1), { payouts: false, cash: false, support: false }, "merged, not replaced");
    out = await x.updateNotificationPrefs(D1, { payouts: true });
    assert.deepEqual(storedPrefs(D1), { cash: false, support: false }, "true removes the key");
    assert.deepEqual(out, { ...ALL_ON, cash: false, support: false });
    out = await x.updateNotificationPrefs(D1, { offers: true, cash: true, support: true });
    assert.deepEqual(storedPrefs(D1), {}, "locked true is a no-op; the rest switched back on");
    assert.deepEqual(out, ALL_ON);
    assert.deepEqual(storedPrefs(D2), {}, "another rider is untouched");
    const mine = t("rider_profiles").find((p) => p.driver_id === D1)!;
    assert.equal(mine.address_line, "Flat 2");
    assert.equal(mine.verification_status, "verified", "verification state is not involved");
    const patches = requests.filter((q) => q.method === "PATCH");
    assert.ok(patches.length > 0 && patches.every((q) => q.query.includes(`driver_id=eq.${D1}`)), "every write is scoped to the rider");
  });

  await group("data: notification prefs - a concurrent write is not lost (compare-and-swap retries)", async () => {
    reset();
    seedRider(D1, { notification_prefs: { cash: false } });
    // another request switches `support` off after this one has read, before it writes
    mode.beforePatch = () => {
      t("rider_profiles")[0].notification_prefs = { cash: false, support: false };
    };
    const out = await x.updateNotificationPrefs(D1, { payouts: false });
    assert.deepEqual(storedPrefs(D1), { cash: false, support: false, payouts: false }, "both writers' switches survive");
    assert.deepEqual(out, { ...ALL_ON, cash: false, support: false, payouts: false });
    assert.equal(requests.filter((q) => q.method === "PATCH").length, 2, "the first write matched nothing and re-read");
  });

  await group("data: notification prefs - a rider without a profile row gets one; a database without the column is pending", async () => {
    reset();
    t("profiles").push({ id: D1, role: "driver", full_name: "Ravi Kumar", phone: "+919000000001", avatar_url: null });
    const out = await x.updateNotificationPrefs(D1, { documents: false });
    assert.deepEqual(out, { ...ALL_ON, documents: false });
    assert.deepEqual(storedPrefs(D1), { documents: false });
    // 0086 not applied: the profile still reads, all on; the write is migration_pending
    reset();
    seedRider(D1);
    mode.missingColumns.add("rider_profiles.notification_prefs");
    const p = await x.getRiderProfile(D1, now);
    assert.deepEqual(p.notificationPrefs, ALL_ON, "a missing column reads as everything on");
    await assert.rejects(x.updateNotificationPrefs(D1, { payouts: false }), (e: unknown) => isRiderSchemaPending(e), "42703 on read");
  });

  await group("data: notification prefs - an empty change writes nothing and creates no row", async () => {
    reset();
    seedRider(D1, { notification_prefs: { cash: false } });
    t("profiles").push({ id: D2, role: "driver", full_name: "No row", phone: null, avatar_url: null });
    const before = requests.length;
    assert.deepEqual(await x.updateNotificationPrefs(D1, {}), { ...ALL_ON, cash: false });
    assert.deepEqual(await x.updateNotificationPrefs(D2, {}), ALL_ON);
    assert.equal(requests.slice(before).filter((q) => q.method !== "GET").length, 0, "reads only");
    assert.equal(t("rider_profiles").length, 1, "no row created");
  });

  await group("data: notification prefs - retry exhaustion (5 lost races) is a conflict, and the other writers' values stand", async () => {
    reset();
    seedRider(D1);
    let n = 0;
    mode.interfere = () => {
      n++;
      t("rider_profiles")[0].notification_prefs = { [n % 2 ? "cash" : "documents"]: false, support: false }; // different every time
    };
    await assert.rejects(x.updateNotificationPrefs(D1, { payouts: false }), (e: unknown) => e instanceof x.NotificationPrefsConflictError);
    assert.equal(requests.filter((q) => q.method === "PATCH").length, 5, "five attempts, then it stops");
    assert.equal(storedPrefs(D1).payouts, undefined, "nothing of ours was written over theirs");
    // and it is not a migration_pending / 500 shaped error
    mode.interfere = null;
    assert.ok(!isRiderSchemaPending(new x.NotificationPrefsConflictError()));
    // a lost race four times in a row still succeeds on the fifth
    reset();
    seedRider(D1);
    let k = 0;
    mode.interfere = () => {
      if (++k <= 4) t("rider_profiles")[0].notification_prefs = { support: false, [`x${k}`]: false };
    };
    await x.updateNotificationPrefs(D1, { payouts: false });
    assert.equal(storedPrefs(D1).payouts, false, "the fifth attempt wins");
    assert.equal(storedPrefs(D1).support, false);
  });

  await group("data: notification prefs - an insert that loses to a concurrent insert (23505) retries as an update", async () => {
    reset();
    t("profiles").push({ id: D1, role: "driver", full_name: "Ravi Kumar", phone: "+919000000001", avatar_url: null });
    // the row appears (written by someone else, with cash off) between our read and our insert
    mode.beforePost = () => {
      t("rider_profiles").push({ driver_id: D1, notification_prefs: { cash: false }, verification_status: "unverified", updated_at: "2026-10-01T00:00:00Z" });
    };
    const out = await x.updateNotificationPrefs(D1, { payouts: false });
    assert.deepEqual(storedPrefs(D1), { cash: false, payouts: false }, "their value and ours");
    assert.deepEqual(out, { ...ALL_ON, cash: false, payouts: false });
    assert.equal(t("rider_profiles").length, 1, "one row");
    assert.equal(requests.filter((q) => q.method === "POST" && q.path === "rider_profiles").length, 1, "one insert attempt, refused with 23505");
  });

  await group("data: migration_pending is only for columns 0086 added; the database error is kept as the cause", async () => {
    reset();
    seedRider(D1);
    // a PGRST204 on a column 0086 did NOT add: a bug, not a missing migration
    mode.patchError = { code: "PGRST204", message: "Could not find the 'notification_prefz' column of 'rider_profiles' in the schema cache" };
    await assert.rejects(
      x.updateNotificationPrefs(D1, { payouts: false }),
      (e: unknown) => !isRiderSchemaPending(e) && (e as { code?: string }).code === "PGRST204",
      "an unrelated column surfaces as the original (server) error"
    );
    mode.patchError = { code: "PGRST204", message: "Could not find the 'rider_code' column of 'rider_profiles' in the schema cache" };
    await assert.rejects(x.updateNotificationPrefs(D1, { payouts: false }), (e: unknown) => !isRiderSchemaPending(e), "0081's column is not 0086's");
    // a column 0086 added: pending, and the cause is the database error
    mode.patchError = { code: "PGRST204", message: "Could not find the 'notification_prefs' column of 'rider_profiles' in the schema cache" };
    await assert.rejects(x.updateNotificationPrefs(D1, { payouts: false }), (e: unknown) => {
      if (!isRiderSchemaPending(e)) return false;
      const cause = (e as Error).cause as { code?: string; message?: string } | undefined;
      return cause?.code === "PGRST204" && /notification_prefs/.test(cause.message ?? "");
    });
    mode.patchError = null;
    reset();
    seedRider(D1);
    mode.missingColumns.add("rider_profiles.verification_status");
    await assert.rejects(x.getRiderProfile(D1, now), (e: unknown) => {
      const cause = isRiderSchemaPending(e) ? ((e as Error).cause as { code?: string } | undefined) : undefined;
      return cause?.code === "42703";
    }, "42703 naming a 0086 column keeps its cause too");
    // the missing notification_prefs column itself still reads as 'all on'
    reset();
    seedRider(D1);
    mode.missingColumns.add("rider_profiles.notification_prefs");
    assert.deepEqual((await x.getRiderProfile(D1, now)).notificationPrefs, ALL_ON);
  });

  await group("data: notification prefs - PGRST204 on the write is also migration_pending", async () => {
    reset();
    seedRider(D1);
    mode.patchError = { code: "PGRST204", message: "Could not find the 'notification_prefs' column of 'rider_profiles' in the schema cache" };
    await assert.rejects(x.updateNotificationPrefs(D1, { payouts: false }), (e: unknown) => isRiderSchemaPending(e));
  });

  await group("data: profile status for /api/rider/me", async () => {
    reset();
    seedRider(D1, { verification_status: "pending" });
    t("rider_documents").push(docRow(D1, "aadhaar"), docRow(D1, "driving_licence", { expires_on: "2030-01-01" }), docRow(D1, "photo", { status: "pending" }));
    assert.deepEqual(await x.getRiderProfileStatus(D1, now), { verification: "pending", documentsComplete: false, needsAttention: false });
  });
}

// ---------------------------------------------------------------------------
// 3. route contract (needs `npm run dev`)
// ---------------------------------------------------------------------------
const ROUTES: { method: string; path: string }[] = [
  { method: "GET", path: "/api/rider/profile" },
  { method: "PATCH", path: "/api/rider/profile" },
  { method: "GET", path: "/api/rider/profile/change-requests" },
  { method: "POST", path: "/api/rider/profile/change-requests" },
  { method: "GET", path: "/api/rider/documents" },
  { method: "POST", path: "/api/rider/documents" },
  { method: "GET", path: "/api/rider/documents/00000000-0000-4000-8000-000000000000/url" },
];

async function call(method: string, path: string, cookie?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: "application/json", ...(cookie ? { cookie } : {}), ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  });
  let json: Row | null = null;
  try {
    json = (await res.json()) as Row;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function sessionCookie(email: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    isSingleton: false,
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function contract(): Promise<void> {
  try {
    await fetch(`${BASE}/api/rider/me`, { redirect: "manual", signal: AbortSignal.timeout(90_000) });
  } catch {
    skip(`dev server unreachable at ${BASE} - start it with \`npm run dev\` (contract checks)`);
    return;
  }
  for (const r of ROUTES) {
    const res = await call(r.method, r.path);
    check(`no cookie -> 401  ${r.method} ${r.path}`, res.status === 401 && res.json?.error === "unauthenticated", res);
  }
  const cron = await call("GET", "/api/cron/rider-documents");
  check("cron without its secret -> 401", cron.status === 401, cron);
  const wrong = await call("GET", "/api/cron/rider-documents", undefined, { authorization: "Bearer not-the-secret-not-the-secret" });
  check("cron with a wrong secret -> 401", wrong.status === 401, wrong);

  if (CUSTOMER_EMAIL && CUSTOMER_PASSWORD) {
    const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    for (const r of ROUTES.filter((x) => x.method === "GET")) {
      const res = await call(r.method, r.path, cookie);
      check(`customer -> 403 not_rider  ${r.method} ${r.path}`, res.status === 403 && res.json?.error === "not_rider", res);
    }
  } else {
    skip("customer 403 checks: QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
  }
  skip("rider session checks (200 shapes / 503 migration_pending, upload refusals end to end): need a QA rider and would write to the live project (ruling R2) - the data tier covers them");
}

async function main(): Promise<void> {
  console.log("-- 1. pure rules");
  await pureTier();
  console.log("-- 2. data layer (fake PostgREST + Storage)");
  await dataTier();
  console.log("-- 3. route contract");
  await contract();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
