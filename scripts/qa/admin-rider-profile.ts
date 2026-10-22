/**
 * QA — admin rider verification, documents and change approvals (Phase 6
 * Task 3): the action parsers, the server-action structure, the data layer
 * against a fake PostgREST + Storage, and the route contract.
 *
 *   npm run test:admin-rider-profile   # tsx --conditions=react-server; the contract part needs `npm run dev`
 *
 *   BASE                                        default http://localhost:3005
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    any non-admin account
 *
 * Tiers:
 *
 *   1. Pure (`lib/rider/admin-profile.ts`): every action's form parser (a
 *      rejection needs remarks or a note, ids are UUIDs, the payout account is
 *      the same shape the rider submits), the verification transitions (the
 *      same as the Manager branch's `ops_set_rider_verification`), and the
 *      required-documents rule.
 *   2. Structure: `profile-actions.ts` is `"use server"`, exports only async
 *      functions, and each one's FIRST statement is `await
 *      requireRole("admin")`, with a rate limit after it (AGENTS.md rule 3) —
 *      the action-level `forbidden` for a non-admin, since server actions have
 *      no stable URL to call from a script. The document viewer route checks
 *      the role before anything else too.
 *   3. The data layer (`data-access/admin-rider-profile.ts`) against an
 *      in-memory PostgREST: document review writes the same columns as 0151's
 *      `ops_review_rider_document` (status, remarks, reviewed_by,
 *      reviewed_at; pending only); verification writes the same as
 *      `ops_set_rider_verification` (verified_at / verified_by on verify;
 *      the three required documents verified unless overridden; a rejection
 *      refused while the rider carries an order, and takes them offline);
 *      change decisions go through `rider_decide_change_request` with the
 *      admin as actor; the Profile tab shows the payout account in full with
 *      "change pending" beside it (Review Focus 3); the Riders list flags.
 *   4. Route contract against the dev server: signed out (and a non-admin)
 *      are turned away from the new tabs and the document viewer. SKIPs
 *      without the server or the QA account (ruling R2).
 *
 * Never sends push/SMS/OTP and never writes live data.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./_env";

for (const key of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?ONESIGNAL/i.test(key)) delete process.env[key];
}
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const BASE = (process.env.BASE ?? "http://localhost:3005").replace(/\/$/, "");
const CUSTOMER_EMAIL = process.env.QA_CUSTOMER_EMAIL ?? "";
const CUSTOMER_PASSWORD = process.env.QA_CUSTOMER_PASSWORD ?? "";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = uid(0xad);
const R1 = uid(0xd1);
const R2 = uid(0xd2);
const NOW = new Date("2026-10-22T10:00:00+05:30");

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

// ---------------------------------------------------------------------------
// 1. pure
// ---------------------------------------------------------------------------
async function pureTier(): Promise<void> {
  const a = await import("../../src/lib/rider/admin-profile");

  await group("pure: document review — ids are UUIDs; a rejection needs remarks", () => {
    const ok = a.parseDocumentReview(form({ driverId: R1, documentId: uid(1), remarks: "" }), "verify");
    assert.ok(ok.ok && ok.value.remarks === null);
    assert.equal(a.parseDocumentReview(form({ driverId: R1, documentId: "1; drop", remarks: "" }), "verify").ok, false);
    assert.equal(a.parseDocumentReview(form({ driverId: "x", documentId: uid(1) }), "verify").ok, false);
    const noRemarks = a.parseDocumentReview(form({ driverId: R1, documentId: uid(1), remarks: "  " }), "reject");
    assert.ok(!noRemarks.ok && /reason/i.test(noRemarks.error), "reject without remarks");
    assert.equal(a.parseDocumentReview(form({ driverId: R1, documentId: uid(1), remarks: "no" }), "reject").ok, false, "too short");
    const rej = a.parseDocumentReview(form({ driverId: R1, documentId: uid(1), remarks: "Photo is blurred — शीर्षक" }), "reject");
    assert.ok(rej.ok && rej.value.remarks === "Photo is blurred — शीर्षक", "non-ASCII remarks intact");
    assert.equal(a.parseDocumentReview(form({ driverId: R1, documentId: uid(1), remarks: "x".repeat(501) }), "reject").ok, false);
  });

  await group("pure: verification — decision, expected state, a note to reject or override", () => {
    const v = a.parseVerificationDecision(form({ driverId: R1, decision: "verify", expected: "pending", note: "" }));
    assert.ok(v.ok && v.value.decision === "verify" && v.value.override === false && v.value.note === null);
    assert.equal(a.parseVerificationDecision(form({ driverId: R1, decision: "maybe", expected: "pending" })).ok, false);
    assert.equal(a.parseVerificationDecision(form({ driverId: R1, decision: "verify", expected: "approved" })).ok, false);
    const r = a.parseVerificationDecision(form({ driverId: R1, decision: "reject", expected: "pending", note: "" }));
    assert.ok(!r.ok && /reason/i.test(r.error));
    const o = a.parseVerificationDecision(form({ driverId: R1, decision: "verify", expected: "pending", override: "on", note: "" }));
    assert.ok(!o.ok && /reason/i.test(o.error), "an override says why");
    const o2 = a.parseVerificationDecision(form({ driverId: R1, decision: "verify", expected: "pending", override: "on", note: "Checked the originals at the hub" }));
    assert.ok(o2.ok && o2.value.override === true);
  });

  await group("pure: transitions mirror ops_set_rider_verification", () => {
    assert.equal(a.verificationTarget("unverified", "verify"), "verified");
    assert.equal(a.verificationTarget("pending", "verify"), "verified");
    assert.equal(a.verificationTarget("rejected", "verify"), "verified");
    assert.equal(a.verificationTarget("verified", "verify"), null);
    assert.equal(a.verificationTarget("unverified", "reject"), "rejected");
    assert.equal(a.verificationTarget("pending", "reject"), "rejected");
    assert.equal(a.verificationTarget("verified", "reject"), null, "a verified rider is suspended, not un-verified");
    assert.equal(a.verificationTarget("rejected", "reject"), null);
  });

  await group("pure: required documents (aadhaar, driving_licence, photo) verified", () => {
    const d = (type: string, status: string) => ({ type, status, expiresOn: null });
    assert.deepEqual(a.unverifiedRequired([d("aadhaar", "verified"), d("driving_licence", "pending"), d("photo", "replaced")]), ["driving_licence", "photo"]);
    assert.deepEqual(a.unverifiedRequired([d("aadhaar", "verified"), d("driving_licence", "verified"), d("photo", "verified")]), []);
  });

  await group("pure: change decision and payout edit", () => {
    const c = a.parseChangeDecision(form({ driverId: R1, requestId: uid(5), decision: "approve", note: "" }));
    assert.ok(c.ok && c.value.note === null);
    const cr = a.parseChangeDecision(form({ driverId: R1, requestId: uid(5), decision: "reject", note: "" }));
    assert.ok(!cr.ok && /reason/i.test(cr.error));
    assert.equal(a.parseChangeDecision(form({ driverId: R1, requestId: uid(5), decision: "apply" })).ok, false);
    const p = a.parsePayoutEdit(form({ driverId: R1, kind: "bank", holderName: "Ravi Kumar", accountNumber: "123456789012", confirmAccountNumber: "123456789012", ifsc: "hdfc0001234" }));
    assert.ok(p.ok && p.value.account.kind === "bank" && p.value.account.ifsc === "HDFC0001234");
    const pm = a.parsePayoutEdit(form({ driverId: R1, kind: "bank", holderName: "Ravi Kumar", accountNumber: "123456789012", confirmAccountNumber: "123456789013", ifsc: "HDFC0001234" }));
    assert.ok(!pm.ok && /match/i.test(pm.error));
    const pu = a.parsePayoutEdit(form({ driverId: R1, kind: "upi", upiId: "ravi@ybl" }));
    assert.ok(pu.ok && pu.value.account.kind === "upi");
  });

  await group("pure: every error code reads as a sentence", () => {
    for (const code of ["not_found", "already_decided", "stale", "invalid_transition", "documents_unverified", "active_delivery", "invalid_value", "staged_missing", "migration_pending"]) {
      const m = a.adminProfileError(code);
      assert.ok(m.length > 10 && !/_/.test(m), `${code}: ${m}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 2. structure
// ---------------------------------------------------------------------------
const ACTIONS = "src/app/admin/riders/[id]/profile-actions.ts";
const VIEWER = "src/app/admin/riders/[id]/documents/[docId]/route.ts";

function exportedFunctions(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export\s+async\s+function\s+(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", src.indexOf(")", m.index + m[0].length) + 1);
    out.push({ name: m[1], body: src.slice(open + 1, open + 1 + 400) });
  }
  return out;
}

async function structureTier(): Promise<void> {
  let src = "";
  try {
    src = readFileSync(join(root, ACTIONS), "utf8");
  } catch {
    check(`${ACTIONS} exists`, false);
    return;
  }
  check(`${ACTIONS} is "use server"`, /^\s*"use server";/.test(src));
  check(`${ACTIONS} exports nothing but async functions`, !/export\s+(const|let|var|class|default)\b/.test(src) && !/export\s+function\b/.test(src));
  const fns = exportedFunctions(src);
  const names = fns.map((f) => f.name).sort();
  check(
    `${ACTIONS} has the five actions`,
    JSON.stringify(names) === JSON.stringify(["decideChangeRequestAction", "editPayoutAccountAction", "rejectDocumentAction", "setVerificationAction", "verifyDocumentAction"]),
    names
  );
  for (const fn of fns) {
    const first = fn.body.replace(/\/\/.*$/gm, "").trim();
    check(`${fn.name}: first statement is requireRole("admin")`, /^(const\s+\w+\s*=\s*)?await\s+requireRole\(\s*"admin"\s*\)/.test(first), first.slice(0, 80));
    check(`${fn.name}: rate-limited`, /rateLimit\(/.test(fn.body), fn.body.slice(0, 200));
  }
  check(`${ACTIONS} never imports the payout module's full readers into a client path`, !/use client/.test(src));
  let viewer = "";
  try {
    viewer = readFileSync(join(root, VIEWER), "utf8");
  } catch {
    check(`${VIEWER} exists`, false);
    return;
  }
  const get = exportedFunctions(viewer).find((f) => f.name === "GET");
  check(`${VIEWER} GET opens with requireRole("admin")`, !!get && /^(const\s+\w+\s*=\s*)?await\s+requireRole\(\s*"admin"\s*\)/.test(get.body.replace(/\/\/.*$/gm, "").trim()));
  check(`${VIEWER} GET is rate-limited`, !!get && /rateLimit\(/.test(get.body));
  for (const file of ["src/app/admin/riders/[id]/profile-tab.tsx", "src/app/admin/riders/[id]/documents-tab.tsx"]) {
    let s = "";
    try {
      s = readFileSync(join(root, file), "utf8");
    } catch {
      check(`${file} exists`, false);
      continue;
    }
    check(`${file} is not a client component (full payout details never ship as props to the browser bundle)`, !/^\s*"use client"/.test(s));
    check(`${file} renders no raw HTML`, !/dangerouslySetInnerHTML/.test(s));
  }
}

// ---------------------------------------------------------------------------
// 3. data layer
// ---------------------------------------------------------------------------
const db: Record<string, Row[]> = {};
const requests: { method: string; path: string; query: string; body: unknown }[] = [];
const t = (name: string): Row[] => (db[name] ??= []);
const missing = new Set<string>();
let seq = 100;
const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  requests.length = 0;
  missing.clear();
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (RESERVED.has(key)) continue;
    const value = row[key];
    const negate = raw.startsWith("not.");
    const body = negate ? raw.slice(4) : raw;
    const dot = body.indexOf(".");
    const op = body.slice(0, dot);
    const arg = body.slice(dot + 1);
    let hit: boolean;
    switch (op) {
      case "eq": hit = String(value) === arg; break;
      case "neq": hit = String(value) !== arg; break;
      case "in": hit = arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(value)); break;
      case "is": hit = arg === "null" ? value === null || value === undefined : String(value) === arg; break;
      case "gt": hit = value != null && String(value) > arg; break;
      case "lte": hit = value != null && String(value) <= arg; break;
      case "lt": hit = value != null && String(value) < arg; break;
      default: throw new Error(`fake PostgREST: unsupported filter ${key}=${raw}`);
    }
    if (negate ? hit : !hit) return false;
  }
  return true;
}
function ordered(rows: Row[], url: URL): Row[] {
  const spec = url.searchParams.get("order");
  if (!spec) return rows;
  const keys = spec.split(",").map((k) => {
    const [col, dir] = k.split(".");
    return { col, sign: dir === "desc" ? -1 : 1 };
  });
  return [...rows].sort((x, y) => {
    for (const { col, sign } of keys) {
      if (x[col] === y[col]) continue;
      if (x[col] == null) return 1;
      if (y[col] == null) return -1;
      return (x[col] < y[col] ? -1 : 1) * sign;
    }
    return 0;
  });
}
function project(rows: Row[], url: URL): Row[] {
  const sel = url.searchParams.get("select");
  if (!sel || sel === "*") return rows;
  const cols = sel.split(",").map((c) => c.trim()).filter(Boolean);
  return rows.map((row) => Object.fromEntries(cols.map((c) => [c, row[c] ?? null])));
}

/** rider_decide_change_request, as the 0086 proof shows it behaves. */
function decide(args: Row): { code: number; body: unknown } {
  const req = t("rider_profile_change_requests").find((x) => x.id === args.p_request);
  if (!req) return { code: 404, body: { code: "P0002", message: "not_found" } };
  if (req.status !== "pending") return { code: 400, body: { code: "22023", message: "already_decided" } };
  if (args.p_decision === "reject" && (!args.p_note || String(args.p_note).trim().length < 3)) return { code: 400, body: { code: "22023", message: "reason_required" } };
  if (args.p_decision === "approve" && req.field === "payout_account") {
    const staged = t("rider_payout_accounts_staged").find((s) => s.id === req.new_value.stagedId && s.driver_id === req.driver_id);
    if (!staged) return { code: 400, body: { code: "22023", message: "staged_missing" } };
    db.rider_payout_accounts = t("rider_payout_accounts").filter((m) => m.driver_id !== req.driver_id);
    t("rider_payout_accounts").push({ driver_id: req.driver_id, kind: staged.kind, holder_name: staged.holder_name, account_number: staged.account_number, ifsc: staged.ifsc, upi_id: staged.upi_id, updated_at: NOW.toISOString(), updated_by: args.p_actor });
    db.rider_payout_accounts_staged = t("rider_payout_accounts_staged").filter((s) => s.id !== staged.id);
  }
  if (args.p_decision === "approve" && req.field === "licence") {
    const p = t("rider_profiles").find((x) => x.driver_id === req.driver_id);
    if (p) Object.assign(p, { licence_number: req.new_value.number, licence_expires_on: req.new_value.expiresOn });
  }
  Object.assign(req, { status: args.p_decision === "approve" ? "approved" : "rejected", decided_by: args.p_actor, decided_at: NOW.toISOString(), decision_note: args.p_note });
  return { code: 200, body: { id: req.id, driverId: req.driver_id, field: req.field, status: req.status } };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/storage/v1/")) {
      const rest = url.pathname.slice("/storage/v1/".length);
      requests.push({ method: req.method ?? "", path: `storage/${rest}`, query: url.search, body: raw });
      if (req.method === "POST" && rest === "object/sign/rider-documents") {
        const { paths } = JSON.parse(raw || "{}") as { paths?: string[] };
        return send(200, (paths ?? []).map((p) => ({ path: p, signedURL: `/object/sign/rider-documents/${p}?token=t${++seq}`, error: null })));
      }
      if (req.method === "POST" && rest.startsWith("object/sign/rider-documents/")) {
        return send(200, { signedURL: `/object/sign/rider-documents/${rest.slice("object/sign/rider-documents/".length)}?token=t${++seq}` });
      }
      return send(500, { message: `unhandled storage ${rest}` });
    }
    const table = url.pathname.replace("/rest/v1/", "");
    const body: Row | Row[] | null = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method ?? "", path: table, query: url.search, body });
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const respond = (rows: Row[], code = 200) => {
      if (!single) return send(code, rows);
      if (rows.length !== 1) return send(406, { code: "PGRST116", message: "0 rows" });
      return send(code, rows[0]);
    };
    if (table === "rpc/obs_ingest") return send(200, null);
    if (table === "rpc/rider_decide_change_request") {
      const out = decide((body ?? {}) as Row);
      return send(out.code, out.body);
    }
    if (table.startsWith("rpc/")) return send(404, { code: "PGRST202", message: "Could not find the function" });
    if (missing.has(table)) return send(404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` });
    if (req.method === "GET" || req.method === "HEAD") {
      let rows = ordered(t(table).filter((r) => matches(r, url)), url);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const limit = Number(url.searchParams.get("limit"));
      rows = rows.slice(offset, offset + (limit > 0 ? limit : 1000));
      return respond(project(rows, url));
    }
    if (req.method === "PATCH" && body && !Array.isArray(body)) {
      const hit = t(table).filter((r) => matches(r, url));
      for (const row of hit) Object.assign(row, body);
      return respond(project(hit, url));
    }
    if (req.method === "POST" && body) {
      const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ ...r }));
      const prefer = String(req.headers.prefer ?? "");
      const onConflict = url.searchParams.get("on_conflict");
      for (const row of rows) {
        const at = onConflict && prefer.includes("merge-duplicates") ? t(table).findIndex((x) => x[onConflict] === row[onConflict]) : -1;
        if (at >= 0) Object.assign(t(table)[at], row);
        else t(table).push(row);
      }
      return respond(project(rows, url), 201);
    }
    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

function seed(): void {
  t("profiles").push(
    { id: R1, role: "driver", full_name: "Ravi Kumar", phone: "+919000000001", avatar_url: null, created_at: "2026-01-01T00:00:00Z" },
    { id: R2, role: "driver", full_name: "Sunita", phone: "+919000000002", avatar_url: null, created_at: "2026-01-02T00:00:00Z" },
    { id: ADMIN, role: "admin", full_name: "Admin One", phone: null, avatar_url: null, created_at: "2026-01-01T00:00:00Z" }
  );
  const prof = (id: string, code: string, over: Row = {}) => ({
    driver_id: id,
    rider_code: code,
    address_line: "Flat 2, शिवाजी नगर",
    city: "Pune",
    pincode: "411005",
    vehicle_type: "ev_bike",
    vehicle_owner: "deligro",
    vehicle_registration: null,
    licence_number: "MH1220110012345",
    licence_expires_on: "2031-01-01",
    emergency_name: "Sunita Devi",
    emergency_phone: "+919876543210",
    emergency_relation: "Mother",
    verification_status: "pending",
    verified_at: null,
    verified_by: null,
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  });
  t("rider_profiles").push(prof(R1, "DR-0001"), prof(R2, "DR-0002", { verification_status: "unverified" }));
}
const doc = (driver: string, type: string, over: Row = {}): Row => ({
  id: uid(++seq),
  driver_id: driver,
  doc_type: type,
  number: type === "aadhaar" ? null : `${type.toUpperCase().slice(0, 4)}12345678`,
  number_masked: type === "aadhaar" ? "XXXX-XXXX-9012" : "XXXX5678",
  file_path: `${driver}/${type}/${uid(seq)}.${type === "photo" ? "jpg" : "pdf"}`,
  expires_on: null,
  status: "pending",
  remarks: null,
  reviewed_by: null,
  reviewed_at: null,
  reminded_30_at: null,
  reminded_7_at: null,
  reminded_1_at: null,
  reminded_expired_at: null,
  created_at: "2026-10-20T00:00:00Z",
  ...over,
});

async function dataTier(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);
  const x = await import("../../src/lib/data-access/admin-rider-profile");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");

  await group("data: document review writes what ops_review_rider_document writes, pending only", async () => {
    reset();
    seed();
    const d = doc(R1, "pan");
    const other = doc(R2, "pan");
    t("rider_documents").push(d, other);
    const r = await x.reviewDocument(ADMIN, R1, d.id, "verify", null, NOW);
    assert.deepEqual(r, { ok: true, docType: "pan" });
    assert.equal(d.status, "verified");
    assert.equal(d.reviewed_by, ADMIN, "the session admin");
    assert.equal(d.reviewed_at, NOW.toISOString());
    assert.equal(d.remarks, null);
    assert.deepEqual(await x.reviewDocument(ADMIN, R1, d.id, "reject", "Too late", NOW), { ok: false, error: "already_decided" });
    assert.deepEqual(await x.reviewDocument(ADMIN, R1, other.id, "verify", null, NOW), { ok: false, error: "not_found" }, "the URL's rider must own the document");
    assert.equal(other.status, "pending");
    const e = doc(R1, "photo");
    t("rider_documents").push(e);
    await x.reviewDocument(ADMIN, R1, e.id, "reject", "Face not visible", NOW);
    assert.equal(e.status, "rejected");
    assert.equal(e.remarks, "Face not visible");
  });

  await group("data: verification — required documents, override, stale, transitions", async () => {
    reset();
    seed();
    t("rider_documents").push(doc(R1, "aadhaar", { status: "verified" }), doc(R1, "driving_licence", { status: "pending", expires_on: "2031-01-01" }));
    let r = await x.setVerification(ADMIN, { driverId: R1, decision: "verify", expected: "pending", note: null, override: false }, NOW);
    assert.deepEqual(r, { ok: false, error: "documents_unverified", missing: ["driving_licence", "photo"] });
    assert.equal(t("rider_profiles")[0].verification_status, "pending", "nothing written");
    r = await x.setVerification(ADMIN, { driverId: R1, decision: "verify", expected: "unverified", note: null, override: true }, NOW);
    assert.deepEqual(r, { ok: false, error: "stale" }, "the page was out of date");
    r = await x.setVerification(ADMIN, { driverId: R1, decision: "verify", expected: "pending", note: "Originals seen", override: true }, NOW);
    assert.deepEqual(r, { ok: true, status: "verified" });
    const p = t("rider_profiles")[0];
    assert.equal(p.verified_by, ADMIN);
    assert.equal(p.verified_at, NOW.toISOString());
    assert.equal(p.verification_note, "Originals seen", "the note is stored, not only pushed");
    r = await x.setVerification(ADMIN, { driverId: R1, decision: "reject", expected: "verified", note: "Fake", override: false }, NOW);
    assert.deepEqual(r, { ok: false, error: "invalid_transition" }, "verified -> rejected is a suspension, not this");
  });

  await group("data: rejecting verification is refused mid-delivery, and takes the rider offline", async () => {
    reset();
    seed();
    t("deliveries").push({ id: uid(900), driver_id: R2, status: "picked_up", assigned_at: NOW.toISOString() });
    t("rider_status").push({ driver_id: R2, is_online: true, break_until: null, online_since: NOW.toISOString(), last_fix_at: NOW.toISOString(), last_lat: 1, last_lng: 1, updated_at: NOW.toISOString() });
    let r = await x.setVerification(ADMIN, { driverId: R2, decision: "reject", expected: "unverified", note: "Documents fake", override: false }, NOW);
    assert.deepEqual(r, { ok: false, error: "active_delivery" });
    assert.equal(t("rider_profiles")[1].verification_status, "unverified");
    t("deliveries")[0].status = "delivered";
    r = await x.setVerification(ADMIN, { driverId: R2, decision: "reject", expected: "unverified", note: "Documents fake", override: false }, NOW);
    assert.deepEqual(r, { ok: true, status: "rejected" });
    assert.equal(t("rider_profiles")[1].verified_by, null, "verified_* untouched on a rejection");
    assert.equal(t("rider_profiles")[1].verification_note, "Documents fake", "the rejection reason is stored");
    assert.equal(t("rider_status")[0].is_online, false, "taken offline");
  });

  await group("data: Review Focus 3 — the Profile tab: account in full, change pending beside it; approve applies", async () => {
    reset();
    seed();
    t("rider_payout_accounts").push({ driver_id: R1, kind: "bank", holder_name: "Ravi Kumar", account_number: "123456789012", ifsc: "HDFC0001234", upi_id: null, updated_at: "2026-10-01T00:00:00Z", updated_by: ADMIN });
    t("rider_payout_accounts_staged").push({ id: uid(700), driver_id: R1, kind: "bank", holder_name: "Ravi Kumar", account_number: "999900001111", ifsc: "ICIC0004321", upi_id: null });
    t("rider_profile_change_requests").push(
      { id: uid(701), driver_id: R1, field: "payout_account", new_value: { stagedId: uid(700) }, status: "pending", decided_by: null, decided_at: null, decision_note: null, created_at: "2026-10-21T08:00:00Z" },
      { id: uid(702), driver_id: R1, field: "licence", new_value: { number: "MH1420250099999", expiresOn: "2036-05-01" }, status: "pending", decided_by: null, decided_at: null, decision_note: null, created_at: "2026-10-21T09:00:00Z" }
    );
    t("rider_documents").push(doc(R1, "aadhaar", { status: "verified" }), doc(R1, "pan", { status: "replaced" }), doc(R1, "pan"));
    const view = await x.getRiderProfileForAdmin(R1, NOW);
    assert.ok(view);
    assert.equal(view.payout.account?.accountNumber, "123456789012", "in full, for the admin");
    assert.equal(view.payout.pending?.accountNumber, "999900001111", "change pending beside it");
    assert.equal(view.licence.number, "MH1220110012345");
    const lic = view.changes.find((c) => c.field === "licence");
    assert.equal(lic?.current, "MH1220110012345 · valid to 2031-01-01");
    assert.equal(lic?.proposed, "MH1420250099999 · valid to 2036-05-01", "old vs new, in full for the admin");
    const pay = view.changes.find((c) => c.field === "payout_account");
    assert.ok(pay?.current.includes("123456789012") && pay.proposed.includes("999900001111"));
    assert.deepEqual(view.documents.map((d) => d.type).sort(), ["aadhaar", "pan"], "live documents only");
    assert.equal(view.history.length, 1, "the replaced PAN is history");
    assert.ok(view.documents.every((d) => d.viewUrl === null || d.viewUrl.includes("/object/sign/rider-documents/")));
    assert.equal(view.documents.find((d) => d.type === "aadhaar")?.number, null, "no full Aadhaar exists to show");
    const r = await x.decideChangeRequest(ADMIN, R1, uid(701), "approve", null);
    assert.deepEqual(r, { ok: true, field: "payout_account", status: "approved" });
    assert.equal(t("rider_payout_accounts")[0].account_number, "999900001111");
    assert.equal(t("rider_payout_accounts")[0].updated_by, ADMIN);
    assert.deepEqual(await x.decideChangeRequest(ADMIN, R1, uid(701), "reject", "again"), { ok: false, error: "already_decided" });
    assert.deepEqual(await x.decideChangeRequest(ADMIN, R2, uid(702), "approve", null), { ok: false, error: "not_found" }, "the URL's rider must own the request");
    const rpc = requests.filter((q) => q.path === "rpc/rider_decide_change_request");
    assert.ok(rpc.every((q) => (q.body as Row).p_actor === ADMIN), "the admin is the actor");
  });

  await group("data: the document viewer signs only this rider's documents", async () => {
    reset();
    seed();
    const mine = doc(R1, "photo");
    const theirs = doc(R2, "photo");
    t("rider_documents").push(mine, theirs);
    assert.ok((await x.adminDocumentUrl(R1, mine.id))?.includes(mine.file_path));
    assert.equal(await x.adminDocumentUrl(R1, theirs.id), null);
    assert.equal(await x.adminDocumentUrl(R1, "nope"), null);
  });

  await group("data: the Riders list flags — needs review, expiring", async () => {
    reset();
    seed();
    t("rider_documents").push(doc(R1, "driving_licence", { status: "verified", expires_on: "2026-11-01" }), doc(R2, "pan", { status: "verified" }));
    t("rider_profile_change_requests").push({ id: uid(800), driver_id: R2, field: "vehicle", new_value: {}, status: "pending", created_at: "2026-10-21T00:00:00Z" });
    t("rider_profiles")[1].verification_status = "verified";
    const flags = await x.listReviewFlags(NOW);
    assert.deepEqual(flags.get(R1), { verification: "pending", pendingDocuments: 0, pendingChanges: 0, expiringDocuments: 1, needsReview: true });
    assert.deepEqual(flags.get(R2), { verification: "verified", pendingDocuments: 0, pendingChanges: 1, expiringDocuments: 0, needsReview: true });
    t("rider_profile_change_requests")[0].status = "approved";
    assert.equal((await x.listReviewFlags(NOW)).get(R2)?.needsReview, false);
    missing.add("rider_documents");
    assert.equal((await x.listReviewFlags(NOW)).size, 0, "before 0086 there is nothing to flag");
    await assert.rejects(x.getRiderProfileForAdmin(R1, NOW), (e: unknown) => isRiderSchemaPending(e));
  });
}

// ---------------------------------------------------------------------------
// 4. contract
// ---------------------------------------------------------------------------
const PAGES = [
  `/admin/riders/${uid(0xaa)}?tab=profile`,
  `/admin/riders/${uid(0xaa)}?tab=documents`,
  `/admin/riders/${uid(0xaa)}/documents/${uid(0xbb)}`,
  "/admin/riders?filter=review",
];

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

async function getPage(path: string, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(180_000) });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}
const turnedAway = (r: { status: number; location: string }) => [301, 302, 303, 307, 308].includes(r.status) && /login|denied/.test(r.location);

async function contract(): Promise<void> {
  try {
    await fetch(`${BASE}/api/rider/me`, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  } catch {
    skip(`dev server unreachable at ${BASE} - start it with \`npm run dev\` (contract checks)`);
    return;
  }
  for (const page of PAGES) {
    const r = await getPage(page);
    check(`signed out is turned away  GET ${page}`, turnedAway(r), r);
  }
  if (!CUSTOMER_EMAIL || !CUSTOMER_PASSWORD) {
    skip("non-admin checks: QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
  for (const page of PAGES) {
    const r = await getPage(page, cookie);
    check(`a non-admin is turned away  GET ${page}`, turnedAway(r) && /denied=1/.test(r.location), r);
  }
}

async function main(): Promise<void> {
  console.log("-- 1. parsers and rules");
  await pureTier();
  console.log("-- 2. server-action structure");
  await structureTier();
  console.log("-- 3. data layer (fake PostgREST)");
  await dataTier();
  console.log("-- 4. route contract");
  await contract();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
