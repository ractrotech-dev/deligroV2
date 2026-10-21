/**
 * QA — delivery exceptions: the pure rules, the data layer against a fake
 * PostgREST, and the route contract.
 *
 *   npm run test:delivery-exceptions   # tsx --conditions=react-server; the contract part needs `npm run dev`
 *
 *   BASE                                        default http://localhost:3005
 *   QA_RIDER_EMAIL / QA_RIDER_PASSWORD          a driver account
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    any non-driver account
 *
 * Three tiers:
 *
 *   1. Pure rules (`lib/rider/exception-rules.ts`): which kind may be raised
 *      from where, call_first, wait_longer with minutesLeft, and which
 *      decision each family takes. Always run.
 *   2. The data layer (`data-access/delivery-exceptions.ts`) against an
 *      in-memory PostgREST that emulates what 0082 enforces here:
 *      guard_delivery_transition (failed / ops_approved / manual need an
 *      approval raised by the current rider during the current assignment; a
 *      release is a correction that clears the stamps and the offer),
 *      guard_delivery_exception_update (a decision is final), the one-pending
 *      index, the audit rows, and storage signing. Always run.
 *   3. Route contract against the dev server: no cookie is 401; the
 *      session-dependent checks (403 for a non-rider, 400 invalid_kind, 404 /
 *      503 for an order the rider does not hold) need QA accounts — SKIP
 *      without them, and SKIP when the server is not running.
 *
 * Never sends OTP/SMS/push and never writes live data: the fake is the only
 * thing written to, every ONESIGNAL variable is removed before any module
 * loads, and the live requests are unauthenticated or refused first.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./_env";

for (const key of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?ONESIGNAL/i.test(key)) delete process.env[key];
}
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const BASE = (process.env.BASE ?? "http://localhost:3005").replace(/\/$/, "");
const RIDER_EMAIL = process.env.QA_RIDER_EMAIL ?? "";
const RIDER_PASSWORD = process.env.QA_RIDER_PASSWORD ?? "";
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
    check(name, false, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// 1. pure rules
// ---------------------------------------------------------------------------
async function pureTier(): Promise<void> {
  const r = await import("../../src/lib/rider/exception-rules");
  const T0 = Date.parse("2026-10-21T10:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const ctx = (over: Partial<Parameters<typeof r.exceptionAllowed>[2]> = {}) => ({
    now: T0 + 12 * 60_000,
    arrivedDropAt: iso(T0),
    lastCustomerCallAt: iso(T0 + 60_000),
    unreachableWaitMinutes: 10,
    ...over,
  });

  await group("eleven kinds: six requests, five reports", () => {
    assert.equal(r.EXCEPTION_KINDS.length, 11);
    assert.deepEqual([...r.REQUEST_KINDS], [
      "customer_unreachable", "wrong_address", "complete_without_code", "failed_delivery", "manual_pickup", "go_offline",
    ]);
    assert.deepEqual([...r.REPORT_KINDS], ["return_to_shop", "missing_items", "wrong_package", "vendor_delay", "other_issue"]);
    assert.equal(r.isExceptionKind("teleport"), false);
    assert.equal(r.isExceptionKind(null), false);
    for (const k of r.EXCEPTION_KINDS) assert.equal(r.isExceptionKind(k), true, k);
  });

  await group("state gates: manual_pickup only at assigned", () => {
    assert.deepEqual(r.exceptionAllowed("manual_pickup", "assigned", ctx()), { ok: true });
    for (const s of ["offered", "picked_up", "delivered", "failed", "cancelled"] as const) {
      assert.deepEqual(r.exceptionAllowed("manual_pickup", s, ctx()), { ok: false, error: "bad_state" }, s);
    }
  });

  await group("state gates: complete_without_code / failed_delivery / wrong_address / customer_unreachable only at picked_up", () => {
    for (const k of ["complete_without_code", "failed_delivery", "wrong_address", "customer_unreachable"] as const) {
      assert.deepEqual(r.exceptionAllowed(k, "picked_up", ctx()), { ok: true }, k);
      for (const s of ["offered", "assigned", "delivered", "failed", "cancelled"] as const) {
        assert.deepEqual(r.exceptionAllowed(k, s, ctx()), { ok: false, error: "bad_state" }, `${k} at ${s}`);
      }
    }
  });

  await group("state gates: go_offline only before pickup — an offer, or assigned (ruling P2-R9)", () => {
    for (const s of ["offered", "assigned"] as const) {
      assert.deepEqual(r.exceptionAllowed("go_offline", s, ctx()), { ok: true }, s);
    }
    for (const s of ["picked_up", "delivered", "failed", "cancelled"] as const) {
      assert.deepEqual(r.exceptionAllowed("go_offline", s, ctx()), { ok: false, error: "bad_state" }, s);
    }
  });

  await group("reports: while the rider holds the job; return_to_shop also after a failure; never on a bare offer", () => {
    for (const k of r.REPORT_KINDS) {
      assert.deepEqual(r.exceptionAllowed(k, "assigned", ctx()), { ok: true }, k);
      assert.deepEqual(r.exceptionAllowed(k, "picked_up", ctx()), { ok: true }, k);
      assert.deepEqual(r.exceptionAllowed(k, "offered", ctx()), { ok: false, error: "bad_state" }, k);
      assert.deepEqual(r.exceptionAllowed(k, "delivered", ctx()), { ok: false, error: "bad_state" }, k);
    }
    assert.deepEqual(r.exceptionAllowed("return_to_shop", "failed", ctx()), { ok: true });
    assert.deepEqual(r.exceptionAllowed("missing_items", "failed", ctx()), { ok: false, error: "bad_state" });
  });

  await group("customer_unreachable: call_first without a customer call after arriving", () => {
    assert.deepEqual(r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ lastCustomerCallAt: null })), { ok: false, error: "call_first" });
    assert.deepEqual(
      r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ lastCustomerCallAt: iso(T0 - 60_000) })),
      { ok: false, error: "call_first" },
      "a call before arriving does not count"
    );
    assert.deepEqual(r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ lastCustomerCallAt: iso(T0) })), { ok: true }, "a call at the arrival instant counts");
  });

  await group("customer_unreachable: not arrived at the door yet -> bad_state", () => {
    assert.deepEqual(r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ arrivedDropAt: null })), { ok: false, error: "bad_state" });
  });

  await group("customer_unreachable: wait_longer with minutesLeft, rounded up, never 0", () => {
    assert.deepEqual(r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ now: T0 + 2 * 60_000 })), { ok: false, error: "wait_longer", minutesLeft: 8 });
    assert.deepEqual(r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ now: T0 + 9 * 60_000 + 1 })), { ok: false, error: "wait_longer", minutesLeft: 1 });
    assert.deepEqual(r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ now: T0 + 10 * 60_000 - 1 })), { ok: false, error: "wait_longer", minutesLeft: 1 });
    assert.deepEqual(r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ now: T0 + 10 * 60_000 })), { ok: true });
    assert.deepEqual(r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ now: T0 + 60_000, unreachableWaitMinutes: 3 })), { ok: false, error: "wait_longer", minutesLeft: 2 });
    assert.deepEqual(
      r.exceptionAllowed("customer_unreachable", "picked_up", ctx({ now: T0 + 2 * 60_000, lastCustomerCallAt: null })),
      { ok: false, error: "call_first" },
      "call_first is answered before wait_longer"
    );
  });

  await group("decisions: a request is approved or rejected, a report only acknowledged", () => {
    for (const k of r.REQUEST_KINDS) {
      assert.equal(r.decisionAllowed(k, "approve"), true, k);
      assert.equal(r.decisionAllowed(k, "reject"), true, k);
      assert.equal(r.decisionAllowed(k, "acknowledge"), false, k);
    }
    for (const k of r.REPORT_KINDS) {
      assert.equal(r.decisionAllowed(k, "approve"), false, k);
      assert.equal(r.decisionAllowed(k, "reject"), false, k);
      assert.equal(r.decisionAllowed(k, "acknowledge"), true, k);
    }
    assert.equal(r.decisionStatus("approve"), "approved");
    assert.equal(r.decisionStatus("reject"), "rejected");
    assert.equal(r.decisionStatus("acknowledge"), "acknowledged");
    assert.equal(r.isExceptionDecision("approve"), true);
    assert.equal(r.isExceptionDecision("maybe"), false);
  });
}

// ---------------------------------------------------------------------------
// 2. the fake PostgREST (0082 emulated where it matters here)
// ---------------------------------------------------------------------------
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const db: Record<string, Row[]> = {};
const storage: Record<string, string[]> = {};
const signed: string[][] = [];
const mode = {
  missingTables: new Set<string>(),
  /** Run once, just before the next PATCH on that table is applied (a race). */
  beforePatch: {} as Record<string, (() => void) | undefined>,
  /** Answer the next PATCH on that table with a server error (an outage). */
  failPatch: new Set<string>(),
  /** Run once, just before the next call of that RPC is answered (a race). */
  beforeRpc: {} as Record<string, (() => void) | undefined>,
};
let eventSeq = 0;
const t = (name: string): Row[] => (db[name] ??= []);
const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(storage)) delete storage[k];
  signed.length = 0;
  mode.missingTables.clear();
  mode.beforePatch = {};
  mode.failPatch.clear();
  mode.beforeRpc = {};
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns", "or", "and"]);

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (RESERVED.has(key) || key.includes(".")) continue;
    const value = row[key];
    const negate = raw.startsWith("not.");
    const body = negate ? raw.slice(4) : raw;
    const dot = body.indexOf(".");
    const op = body.slice(0, dot);
    const arg = body.slice(dot + 1);
    let hit: boolean;
    switch (op) {
      case "eq":
        hit = String(value) === arg;
        break;
      case "neq":
        hit = String(value) !== arg;
        break;
      case "in":
        hit = arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(value));
        break;
      case "is":
        hit = arg === "null" ? value === null || value === undefined : String(value) === arg;
        break;
      case "gte":
        hit = value != null && String(value) >= arg;
        break;
      case "lt":
        hit = value != null && String(value) < arg;
        break;
      default:
        throw new Error(`fake PostgREST: unsupported filter ${key}=${raw}`);
    }
    if (negate ? hit : !hit) return false;
  }
  return true;
}

function ordered(rows: Row[], url: URL): Row[] {
  const order = url.searchParams.get("order");
  if (!order) return rows;
  const [col, dir] = order.split(",")[0].split(".");
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -sign : String(a[col]) > String(b[col]) ? sign : 0));
}

const TERMINAL = new Set(["delivered", "failed", "cancelled"]);
const STAMPS = ["arrived_pickup_at", "departed_pickup_at", "arrived_drop_at", "picked_up_at"];
const nowIso = () => new Date().toISOString();

/** An approval by the row's rider during its current assignment (0082 rules 7–9, 11). */
function approved(row: Row, kinds: string[]): boolean {
  return t("delivery_exceptions").some(
    (x) =>
      x.delivery_id === row.id &&
      x.driver_id === row.driver_id &&
      x.status === "approved" &&
      row.assigned_at != null &&
      x.created_at >= row.assigned_at &&
      kinds.includes(x.kind)
  );
}

/** guard_delivery_transition (0082). Mutates `next` (stamps). */
function guard(old: Row, next: Row): string | null {
  const correction = (next.correction_reason ?? null) !== (old.correction_reason ?? null);
  const moved = next.status !== old.status;
  const release = old.driver_id != null && next.driver_id == null;
  if (release) {
    if (!correction) return "releasing a delivery back to dispatch is a correction";
    if (old.status !== "assigned") return `only an assigned delivery can be released (was ${old.status})`;
    if (next.status !== "unassigned") return "a released delivery must become unassigned";
  }
  if (!correction) {
    if (moved && TERMINAL.has(old.status)) return `a ${old.status} delivery cannot become ${next.status}`;
    for (const s of STAMPS) if (old[s] != null && next[s] !== old[s]) return `${s} is already set`;
    if (moved && next.status === "delivered" && old.status !== "picked_up") return "delivered requires picked_up";
  }
  if (moved && next.status === "picked_up" && (old.status !== "assigned" || !next.driver_id)) return "picked_up requires assigned";
  if (moved && next.status === "failed" && !String(next.failure_reason ?? "").trim()) return "failed requires a failure_reason";
  if (moved && next.status === "failed" && !["assigned", "picked_up"].includes(old.status)) return "only assigned/picked_up can fail";
  if (!correction) {
    if (moved && next.status === "failed" && !approved(next, ["failed_delivery", "customer_unreachable", "wrong_address"])) {
      return "failed requires an approved failed_delivery, customer_unreachable or wrong_address exception";
    }
    if (next.delivery_method === "ops_approved" && next.delivery_method !== old.delivery_method && !approved(next, ["complete_without_code"])) {
      return "ops_approved requires an approved complete_without_code";
    }
    if (next.pickup_method === "manual" && next.pickup_method !== old.pickup_method && !approved(next, ["manual_pickup"])) {
      return "manual requires an approved manual_pickup";
    }
  }
  if (release) {
    for (const s of ["assigned_at", ...STAMPS, "pickup_method", "offered_driver_id", "offered_at"]) next[s] = null;
  } else if (!correction && next.driver_id != null && next.driver_id !== old.driver_id) {
    next.assigned_at = nowIso();
  }
  if (moved && next.status === "delivered") next.delivered_at ??= nowIso();
  if (moved && next.status === "picked_up") next.picked_up_at ??= nowIso();
  if (moved && next.status === "failed") next.failed_at ??= nowIso();
  return null;
}

/** log_delivery_event's rows (0082), the action id on the first. */
function eventsFor(old: Row, next: Row, actionInSet: boolean): Row[] {
  const out: Row[] = [];
  const add = (kind: string, driver: unknown, method: unknown = null, reason: unknown = null) =>
    out.push({ delivery_id: next.id, order_id: next.order_id, driver_id: driver, kind, method, reason, lat: next.driver_lat ?? null, lng: next.driver_lng ?? null });
  if (old.driver_id && !next.driver_id) add("released", old.driver_id, null, next.correction_reason);
  if (next.arrived_pickup_at && !old.arrived_pickup_at) add("arrived_pickup", next.driver_id);
  if (next.status === "picked_up" && old.status !== "picked_up") add("picked_up", next.driver_id, next.pickup_method ?? null);
  if (next.departed_pickup_at && !old.departed_pickup_at) add("departed", next.driver_id);
  if (next.arrived_drop_at && !old.arrived_drop_at) add("arrived_drop", next.driver_id);
  if (next.status === "delivered" && old.status !== "delivered") add("delivered", next.driver_id, next.delivery_method ?? null);
  if (next.status === "failed" && old.status !== "failed") add("failed", next.driver_id, null, next.failure_reason);
  if (next.status === "cancelled" && old.status !== "cancelled") add("cancelled", next.driver_id);
  if ((next.correction_reason ?? null) !== (old.correction_reason ?? null)) add("corrected", next.driver_id, null, next.correction_reason);
  if (out[0] && actionInSet && next.last_action_id) out[0].client_action_id = next.last_action_id;
  return out;
}

/** guard_delivery_exception_update (0082 §1a) and the decided CHECK. */
function exceptionGuard(old: Row, next: Row): string | null {
  for (const c of ["delivery_id", "driver_id", "kind", "created_at"]) if (next[c] !== old[c]) return "delivery_exception_immutable";
  if (old.status !== "pending") {
    for (const c of ["status", "decided_by", "decided_at", "decision_note"]) {
      if ((next[c] ?? null) !== (old[c] ?? null)) return "delivery_exception_decided";
    }
  }
  if (next.status !== "pending" && !next.decided_at) return "delivery_exceptions_decided_check";
  const report = ["return_to_shop", "missing_items", "wrong_package", "vendor_delay", "other_issue"].includes(next.kind);
  const allowed = report ? ["pending", "acknowledged"] : ["pending", "approved", "rejected"];
  if (!allowed.includes(next.status)) return "delivery_exceptions_status_for_kind";
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };
    const raw = Buffer.concat(chunks).toString();

    // --- storage: signing only ---------------------------------------------
    if (url.pathname.startsWith("/storage/v1/object/sign/")) {
      const bucket = decodeURIComponent(url.pathname.slice("/storage/v1/object/sign/".length));
      const body = JSON.parse(raw || "{}") as { expiresIn?: number; paths?: string[] };
      signed.push(body.paths ?? []);
      return send(
        200,
        (body.paths ?? []).map((p) =>
          (storage[bucket] ?? []).includes(p)
            ? { path: p, signedURL: `/object/sign/${bucket}/${p}?token=t${body.expiresIn}`, error: null }
            : { path: p, signedURL: null, error: "Object not found" }
        )
      );
    }
    if (url.pathname.startsWith("/storage/")) return send(400, { message: "unsupported storage call" });

    const table = url.pathname.replace("/rest/v1/", "");
    const body: Row | Row[] | null = raw ? JSON.parse(raw) : null;
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const respond = (rows: Row[], code = 200) => {
      if (!single) return send(code, rows);
      if (rows.length !== 1) return send(406, { code: "PGRST116", message: "0 rows" });
      return send(code, rows[0]);
    };

    if (table.startsWith("rpc/")) {
      const fn = table.slice(4);
      const args = (body && !Array.isArray(body) ? body : {}) as Row;
      const hook = mode.beforeRpc[fn];
      if (hook) {
        mode.beforeRpc[fn] = undefined;
        hook();
      }
      const raise = (code: string, message: string, details?: string) => send(400, { code, message, details: details ?? null });
      // _ops_replayed: this actor already used this action id.
      const replayed = () =>
        t("ops_audit_log").some((a) => a.actor_id === args.p_actor && a.client_action_id === args.p_client_action_id);

      if (fn === "ops_decide_delivery_exception") {
        // 0152's decision RPC (the zone check is the real database's; every
        // fake actor is in zone).
        const ex = t("delivery_exceptions").find((x) => x.id === args.p_exception);
        if (!ex) return raise("42501", "forbidden");
        const state = (status: unknown, again: boolean) => ({
          exception_id: ex.id, kind: ex.kind, delivery_id: ex.delivery_id, order_id: ex.order_id,
          driver_id: ex.driver_id, status, replayed: again,
        });
        if (replayed()) return send(200, state(ex.status, true));
        const report = ["return_to_shop", "missing_items", "wrong_package", "vendor_delay", "other_issue"].includes(String(ex.kind));
        const target =
          report && args.p_decision === "acknowledge" ? "acknowledged"
          : !report && args.p_decision === "approve" ? "approved"
          : !report && args.p_decision === "reject" ? "rejected"
          : null;
        if (!target) return raise("22023", "invalid_transition");
        const note = String(args.p_note ?? "").trim() || null;
        if (target === "rejected" && (!note || note.length < 3)) return raise("22023", "note_required");
        if (ex.status !== "pending") return raise("22023", "already_resolved");
        if (target === "approved") {
          const d = t("deliveries").find((r) => r.id === ex.delivery_id);
          const stint = d && d.driver_id === ex.driver_id && d.assigned_at != null && String(ex.created_at) >= String(d.assigned_at);
          const live = !d
            ? false
            : ex.kind === "go_offline"
              ? (stint && d.status === "assigned") ||
                (d.driver_id == null && d.status === "unassigned" && d.offered_driver_id === ex.driver_id)
              : !stint
                ? false
                : ex.kind === "manual_pickup"
                  ? d.status === "assigned"
                  : ex.kind === "complete_without_code"
                    ? d.status === "picked_up"
                    : d.status === "assigned" || d.status === "picked_up";
          if (!live) return raise("22023", "moved_on", `the delivery is ${d?.status ?? "gone"}`);
        }
        Object.assign(ex, { status: target, decided_by: args.p_actor, decided_at: nowIso(), decision_note: note });
        t("delivery_events").push({
          id: ++eventSeq, created_at: nowIso(), delivery_id: ex.delivery_id, order_id: ex.order_id, driver_id: ex.driver_id,
          kind: "exception_decided", method: args.p_decision, reason: `${ex.kind}${note ? `: ${note}` : ""}`,
          lat: null, lng: null, actor_id: args.p_actor, client_action_id: null,
        });
        t("ops_audit_log").push({ actor_id: args.p_actor, action: `delivery.exception.${args.p_decision}`, entity_id: ex.id, client_action_id: args.p_client_action_id });
        return send(200, state(target, false));
      }

      if (fn === "ops_cancel_order") {
        // 0142's cancellation: refund of a paid order (the rest of the total),
        // order cancelled by the actor's role with the reason, any live
        // delivery cancelled, a failed one left — one transaction.
        const order = t("orders").find((o) => o.id === args.p_order);
        if (!order) return raise("42501", "forbidden");
        if (replayed()) return send(200, { replayed: true, refund_amount: null });
        if (order.status === "delivered" || order.status === "cancelled") return raise("22023", "terminal");
        const role = (t("profiles").find((x) => x.id === args.p_actor)?.role as string | undefined) ?? "manager";
        let refund: number | null = null;
        if (order.payment_status === "paid") {
          const already = t("refunds")
            .filter((r) => r.order_id === order.id && (r.status === "pending" || r.status === "approved"))
            .reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
          const rest = Number(order.total ?? 0) - already;
          if (rest > 0) {
            refund = rest;
            t("refunds").push({
              id: randomUUID(), order_id: order.id, amount: rest, status: "pending", reason: args.p_reason,
              requested_by: args.p_actor, origin: role,
            });
          }
        }
        Object.assign(order, { status: "cancelled", cancelled_by: role, cancellation_reason: args.p_reason });
        for (const d of t("deliveries").filter((r) => r.order_id === order.id)) {
          if (["unassigned", "assigned", "picked_up"].includes(String(d.status))) d.status = "cancelled";
        }
        t("ops_audit_log").push({ actor_id: args.p_actor, action: "order.cancel", entity_id: order.id, client_action_id: args.p_client_action_id });
        return send(200, { replayed: false, refund_amount: refund });
      }

      return send(200, null);
    }
    if (mode.missingTables.has(table)) {
      return send(404, { code: "PGRST205", message: "Could not find the table in the schema cache" });
    }

    if (req.method === "GET") {
      let rows = ordered(t(table).filter((r) => matches(r, url)), url);
      const limit = Number(url.searchParams.get("limit"));
      if (limit > 0) rows = rows.slice(0, limit);
      return respond(rows);
    }

    if (req.method === "DELETE") {
      const keep = t(table).filter((r) => !matches(r, url));
      const gone = t(table).filter((r) => matches(r, url));
      db[table] = keep;
      return send(200, gone);
    }

    if (req.method === "POST" && body) {
      const incoming = Array.isArray(body) ? body : [body];
      const out: Row[] = [];
      for (const item of incoming) {
        if (table === "delivery_events") {
          const row = { id: ++eventSeq, created_at: nowIso(), method: null, reason: null, lat: null, lng: null, actor_id: null, client_action_id: null, ...item };
          t(table).push(row);
          out.push(row);
        } else if (table === "delivery_exceptions") {
          const row = { id: randomUUID(), status: "pending", created_at: nowIso(), notes: null, photo_path: null, lat: null, lng: null, decided_by: null, decided_at: null, decision_note: null, ...item };
          if (t(table).some((x) => x.status === "pending" && row.status === "pending" && x.delivery_id === row.delivery_id && x.kind === row.kind)) {
            return send(409, { code: "23505", message: "duplicate key value violates unique constraint \"delivery_exceptions_one_pending_idx\"" });
          }
          const why = exceptionGuard({ ...row, status: "pending", decided_at: null }, row);
          if (why && why !== "delivery_exception_immutable") return send(400, { code: "23514", message: why });
          t(table).push(row);
          out.push(row);
        } else {
          const row = { id: item.id ?? randomUUID(), ...item };
          t(table).push(row);
          out.push(row);
        }
      }
      return respond(out, 201);
    }

    if (req.method === "PATCH" && body && !Array.isArray(body)) {
      if (mode.failPatch.delete(table)) return send(500, { code: "XX000", message: "forced outage" });
      const hook = mode.beforePatch[table];
      if (hook) {
        mode.beforePatch[table] = undefined;
        hook();
      }
      const hit = t(table).filter((r) => matches(r, url));
      if (table === "delivery_exceptions") {
        for (const row of hit) {
          const why = exceptionGuard(row, { ...row, ...body });
          if (why) return send(400, { code: "23514", message: why });
        }
        for (const row of hit) Object.assign(row, body);
        return send(200, hit);
      }
      if (table !== "deliveries") {
        for (const row of hit) Object.assign(row, body);
        return send(200, hit);
      }
      const staged: { row: Row; next: Row; events: Row[] }[] = [];
      for (const row of hit) {
        const next = { ...row, ...body };
        const why = guard(row, next);
        if (why) return send(400, { code: "23514", message: "invalid_delivery_transition", details: why });
        staged.push({ row, next, events: eventsFor(row, next, "last_action_id" in body) });
      }
      for (const s of staged) {
        Object.assign(s.row, s.next);
        for (const e of s.events) t("delivery_events").push({ id: ++eventSeq, created_at: nowIso(), client_action_id: null, actor_id: null, ...e });
      }
      return send(200, staged.map((s) => s.row));
    }

    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const MGR = "00000000-0000-0000-0000-0000000000e1";
const ADM = "00000000-0000-0000-0000-0000000000a1";
const OWNER = "00000000-0000-0000-0000-0000000000f1";
const O1 = "10000000-0000-4000-8000-000000000001";
const O2 = "10000000-0000-4000-8000-000000000002";
const D1 = "d0000000-0000-4000-8000-000000000001";
const D2 = "d0000000-0000-4000-8000-000000000002";
const NEAR = { lat: 21.2514, lng: 81.6296 }; // inside the service area (isPlausibleFix)
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

function seedOrder(over: Row = {}): Row {
  const row: Row = {
    id: O1,
    status: "on_the_way",
    total: 350,
    payment_method: "cod",
    payment_status: "pending",
    restaurant_id: "r1",
    address: { label: "Home", line: "12 Lane, Civil Lines", area: "Civil Lines", lat: 21.25, lng: 81.63 },
    restaurants: { name: "Saffron Kitchen", owner_id: OWNER },
    pickup_otp: "1234",
    delivery_otp: "5678",
    ...over,
  };
  t("orders").push(row);
  return row;
}

function seedDelivery(over: Row = {}): Row {
  const row: Row = {
    id: D1,
    order_id: O1,
    status: "picked_up",
    driver_id: A,
    offered_driver_id: null,
    offered_at: null,
    assigned_at: ago(40 * MIN),
    picked_up_at: ago(30 * MIN),
    delivered_at: null,
    failed_at: null,
    failure_reason: null,
    arrived_pickup_at: ago(35 * MIN),
    departed_pickup_at: ago(29 * MIN),
    arrived_drop_at: ago(15 * MIN),
    pickup_method: "code",
    delivery_method: null,
    last_action_id: null,
    correction_reason: null,
    pod_photo_path: null,
    cod_collected_amount: null,
    cod_collected_at: null,
    driver_lat: null,
    driver_lng: null,
    ...over,
  };
  t("deliveries").push(row);
  return row;
}

function seedPeople(): void {
  t("profiles").push({ id: A, full_name: "Ravi Rider", phone: "+919800000001", role: "driver" });
  t("profiles").push({ id: B, full_name: "Other Rider", phone: "+919800000002", role: "driver" });
  t("profiles").push({ id: MGR, full_name: "Mona Manager", phone: null, role: "manager" });
  t("profiles").push({ id: ADM, full_name: "Ada Admin", phone: null, role: "admin" });
}

function callCustomer(at: string, driver = A, deliveryId = D1, orderId = O1): void {
  t("delivery_events").push({ id: ++eventSeq, delivery_id: deliveryId, order_id: orderId, driver_id: driver, kind: "contact_attempt", method: "customer", reason: null, created_at: at, actor_id: null, client_action_id: null });
}

const delivery = (id = D1) => t("deliveries").find((d) => d.id === id)!;
const order = (id = O1) => t("orders").find((o) => o.id === id)!;
const exceptions = () => t("delivery_exceptions");
const events = (kind?: string) => t("delivery_events").filter((e) => !kind || e.kind === kind);

async function dataTier(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const x = await import("../../src/lib/data-access/delivery-exceptions");
  const actions = await import("../../src/lib/data-access/rider-delivery-actions");
  const cancellation = await import("../../src/lib/data-access/order-cancellation");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");
  const { DEFAULT_SETTINGS } = await import("../../src/lib/settings-defaults");

  const log: string[] = [];
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const settingsWith = (over: Partial<typeof DEFAULT_SETTINGS> = {}) => ({ ...DEFAULT_SETTINGS, unreachableWaitMinutes: 10, ...over });
  const notify = {
    opsRequested: async (id: string, info: { orderId: string; kind: string; riderName?: string | null }) =>
      void log.push(`ops:${info.kind}:${info.orderId}:${info.riderName}:${id}`),
    stopOpsRing: async (id: string) => void log.push(`stopOps:${id}`),
    driverDecided: async (driverId: string, info: { kind: string; status: string; note?: string | null }) =>
      void log.push(`driver:${driverId}:${info.kind}:${info.status}:${info.note ?? ""}`),
    delivery: {
      onTheWay: async () => void log.push("onTheWay"),
      delivered: async (orderId: string) => void log.push(`delivered:${orderId}`),
      riderArrived: async () => void log.push("arrived"),
      riderHandedOver: async () => void log.push("handedOver"),
    },
  };
  const effects = {
    cancelOrder: async (orderId: string, o: { by: string; reason?: string | null; requestedBy: string }) => {
      log.push(`cancel:${orderId}:${o.by}:${o.reason}:${o.requestedBy}`);
      order(orderId).status = "cancelled";
      return { ok: true as const, refundQueued: false };
    },
    dispatch: async (orderId: string, stage: string, o: { excludeRiderIds?: string[] } = {}) => {
      log.push(`dispatch:${orderId}:${stage}:${(o.excludeRiderIds ?? []).join("+")}`);
      return { rider: null, offered: false };
    },
    forceOffline: async (driverId: string) => void log.push(`offline:${driverId}`),
    rejectOffer: async (driverId: string, orderId: string) => {
      log.push(`rejectOffer:${driverId}:${orderId}`);
      const d = t("deliveries").find((r) => r.order_id === orderId);
      if (d) Object.assign(d, { offered_driver_id: null, offered_at: null });
      return { ok: true as const };
    },
  };
  const opts = (over: Row = {}) => ({ settings: settingsWith(), notify, effects, ...over });
  const raise = (input: Row, driver = A, o: Row = opts()) =>
    x.raiseException(driver, { orderId: O1, reason: "test", ...input } as Parameters<typeof x.raiseException>[1], o);
  const manager = { id: MGR, role: "manager" as const };
  const admin = { id: ADM, role: "admin" as const };
  const decide = (id: string, decision: "approve" | "reject" | "acknowledge", note?: string, actor = manager, o: Row = opts()) =>
    x.decideException(actor, id, decision, note, o);
  const fresh = (orderOver: Row = {}, deliveryOver: Row = {}) => {
    reset();
    log.length = 0;
    seedPeople();
    seedOrder(orderOver);
    seedDelivery(deliveryOver);
  };
  /** A pending exception, as if raised a moment ago by `driver`. */
  const pending = (kind: string, over: Row = {}) => {
    const row = { id: randomUUID(), delivery_id: D1, order_id: O1, driver_id: A, kind, reason: "test", status: "pending", created_at: nowIso(), notes: null, photo_path: null, lat: null, lng: null, decided_by: null, decided_at: null, decision_note: null, ...over };
    exceptions().push(row);
    return row;
  };

  // ---- raising --------------------------------------------------------------

  await group("raise: invalid_kind; not_yours for another rider's delivery and for an order with none", async () => {
    fresh();
    assert.deepEqual(await raise({ kind: "teleport" }), { ok: false, error: "invalid_kind" });
    assert.deepEqual(await raise({ kind: "failed_delivery" }, B), { ok: false, error: "not_yours" });
    assert.deepEqual(await raise({ kind: "failed_delivery", orderId: O2 }), { ok: false, error: "not_yours" });
    assert.equal(exceptions().length, 0);
  });

  await group("raise: state gates (manual_pickup after pickup, failed_delivery before it, a report on a bare offer)", async () => {
    fresh();
    assert.deepEqual(await raise({ kind: "manual_pickup" }), { ok: false, error: "bad_state" });
    fresh({ status: "ready" }, { status: "assigned", picked_up_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null });
    assert.deepEqual(await raise({ kind: "failed_delivery" }), { ok: false, error: "bad_state" });
    assert.deepEqual(await raise({ kind: "complete_without_code" }), { ok: false, error: "bad_state" });
    fresh({ status: "ready" }, { status: "unassigned", driver_id: null, offered_driver_id: A, offered_at: ago(MIN), assigned_at: null, picked_up_at: null, arrived_pickup_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null });
    assert.deepEqual(await raise({ kind: "missing_items" }), { ok: false, error: "bad_state" });
    assert.deepEqual(await raise({ kind: "manual_pickup" }), { ok: false, error: "bad_state" });
    assert.deepEqual(await raise({ kind: "go_offline" }, B), { ok: false, error: "not_yours" }, "someone else's offer");
    const r = await raise({ kind: "go_offline" });
    assert.equal(r.ok, true, "go_offline on the rider's own offer");
    fresh({}, { status: "delivered", delivered_at: ago(MIN) });
    assert.deepEqual(await raise({ kind: "go_offline" }), { ok: false, error: "bad_state" });
    fresh();
    assert.deepEqual(await raise({ kind: "go_offline" }), { ok: false, error: "bad_state" }, "carrying the food (P2-R9)");
  });

  await group("raise: customer_unreachable needs a logged call after arriving (call_first), then the wait (wait_longer + minutesLeft)", async () => {
    fresh({}, { arrived_drop_at: ago(4 * MIN) });
    assert.deepEqual(await raise({ kind: "customer_unreachable" }), { ok: false, error: "call_first" });
    callCustomer(ago(10 * MIN));
    assert.deepEqual(await raise({ kind: "customer_unreachable" }), { ok: false, error: "call_first" }, "a call before arriving");
    callCustomer(ago(3 * MIN), B);
    assert.deepEqual(await raise({ kind: "customer_unreachable" }), { ok: false, error: "call_first" }, "another rider's call");
    callCustomer(ago(3 * MIN));
    const r = await raise({ kind: "customer_unreachable" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "wait_longer");
    assert.equal(!r.ok && r.error === "wait_longer" && r.minutesLeft, 6);
    const shorter = await raise({ kind: "customer_unreachable" }, A, opts({ settings: settingsWith({ unreachableWaitMinutes: 3 }) }));
    assert.equal(shorter.ok, true, "the admin-set wait decides");
    assert.equal(exceptions().length, 1);
  });

  await group("raise: a request is stored pending with reason, notes, position; ops are rung; the audit row is written", async () => {
    fresh({}, { arrived_drop_at: ago(15 * MIN) });
    callCustomer(ago(12 * MIN));
    const r = await raise({ kind: "customer_unreachable", reason: "  No answer at the gate  ", notes: "Rang the bell twice", lat: NEAR.lat, lng: NEAR.lng });
    assert.equal(r.ok, true);
    const row = exceptions()[0];
    assert.equal(r.ok && r.id, row.id);
    assert.equal(row.status, "pending");
    assert.equal(row.delivery_id, D1);
    assert.equal(row.order_id, O1);
    assert.equal(row.driver_id, A);
    assert.equal(row.reason, "No answer at the gate");
    assert.equal(row.notes, "Rang the bell twice");
    assert.equal(row.lat, NEAR.lat);
    await settle();
    assert.deepEqual(log, [`ops:customer_unreachable:${O1}:Ravi Rider:${row.id}`]);
    const ev = events("exception_requested");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].driver_id, A);
    assert.equal(ev[0].reason, "customer_unreachable");
  });

  await group("raise: an implausible position is dropped, not stored", async () => {
    fresh();
    await raise({ kind: "other_issue", lat: 0, lng: 0 });
    assert.equal(exceptions()[0].lat, null);
  });

  await group("raise: a second pending request of the same kind -> duplicate_pending; another kind is fine", async () => {
    fresh();
    assert.equal((await raise({ kind: "failed_delivery" })).ok, true);
    assert.deepEqual(await raise({ kind: "failed_delivery" }), { ok: false, error: "duplicate_pending" });
    assert.equal((await raise({ kind: "complete_without_code" })).ok, true);
    assert.equal(exceptions().length, 2);
  });

  await group("raise: a photo must be the one the proof upload recorded for this delivery (bad_photo otherwise)", async () => {
    const path = `${D1}/30000000-0000-4000-8000-000000000001.jpg`;
    fresh({}, { pod_photo_path: path });
    assert.deepEqual(await raise({ kind: "complete_without_code", photoPath: `${D2}/30000000-0000-4000-8000-000000000001.jpg` }), { ok: false, error: "bad_photo" });
    assert.deepEqual(await raise({ kind: "complete_without_code", photoPath: `${D1}/30000000-0000-4000-8000-000000000009.jpg` }), { ok: false, error: "bad_photo" });
    assert.equal((await raise({ kind: "complete_without_code", photoPath: path })).ok, true);
    assert.equal(exceptions()[0].photo_path, path);
  });

  await group("raise: a database without delivery_exceptions -> RiderSchemaPendingError (503 migration_pending)", async () => {
    fresh();
    mode.missingTables.add("delivery_exceptions");
    await assert.rejects(raise({ kind: "other_issue" }), (e: unknown) => isRiderSchemaPending(e));
  });

  // ---- the queue ------------------------------------------------------------

  await group("list: pending only, oldest first, with code, rider, shop, area, minutes waiting and a signed photo", async () => {
    fresh();
    const path = `${D1}/30000000-0000-4000-8000-000000000002.jpg`;
    storage["delivery-proofs"] = [path];
    seedOrder({ id: O2, status: "ready", restaurants: { name: "Dosa Corner", owner_id: OWNER }, address: { line: "4 Market Road", area: null } });
    seedDelivery({ id: D2, order_id: O2, status: "assigned", driver_id: B, picked_up_at: null });
    const newer = pending("complete_without_code", { created_at: ago(2 * MIN), photo_path: path });
    const older = pending("missing_items", { delivery_id: D2, order_id: O2, driver_id: B, created_at: ago(7 * MIN) });
    pending("wrong_address", { status: "rejected", decided_at: ago(MIN), created_at: ago(20 * MIN) });
    const list = await x.listPendingExceptions();
    assert.deepEqual(list.map((e) => e.id), [older.id, newer.id]);
    const a = list[1];
    assert.equal(a.kind, "complete_without_code");
    assert.equal(a.family, "request");
    assert.equal(a.orderCode, "#10000000");
    assert.equal(a.riderName, "Ravi Rider");
    assert.equal(a.riderPhone, "+919800000001", "phone while the job is active");
    assert.equal(a.shopName, "Saffron Kitchen");
    assert.equal(a.customerArea, "Civil Lines");
    assert.equal(a.minutesWaiting, 2);
    assert.equal(a.active, true);
    assert.ok(a.photoUrl && a.photoUrl.includes(path) && a.photoUrl.includes("t600"), `signed for 10 minutes: ${a.photoUrl}`);
    const b = list[0];
    assert.equal(b.family, "report");
    assert.equal(b.shopName, "Dosa Corner");
    assert.equal(b.customerArea, "4 Market Road", "falls back to the address line");
    assert.equal(b.photoUrl, null);
    assert.equal(b.minutesWaiting, 7);
  });

  await group("list: a job that is over shows no rider phone and is flagged inactive", async () => {
    fresh({ status: "delivered" }, { status: "delivered", delivered_at: ago(MIN), delivery_method: "code" });
    pending("complete_without_code");
    const [e] = await x.listPendingExceptions();
    assert.equal(e.active, false);
    assert.equal(e.riderPhone, null);
    assert.equal(e.deliveryStatus, "delivered");
  });

  await group("list: no table yet -> empty (the boards render without it)", async () => {
    fresh();
    mode.missingTables.add("delivery_exceptions");
    assert.deepEqual(await x.listPendingExceptions(), []);
  });

  // ---- deciding -------------------------------------------------------------

  await group("decide: not_found; invalid_decision (approve a report, acknowledge a request)", async () => {
    fresh();
    assert.deepEqual(await decide(randomUUID(), "approve"), { ok: false, error: "not_found" });
    const report = pending("vendor_delay");
    const request = pending("failed_delivery");
    assert.deepEqual(await decide(report.id, "approve"), { ok: false, error: "invalid_decision" });
    assert.deepEqual(await decide(report.id, "reject"), { ok: false, error: "invalid_decision" });
    assert.deepEqual(await decide(request.id, "acknowledge"), { ok: false, error: "invalid_decision" });
    assert.equal(report.status, "pending");
    assert.equal(request.status, "pending");
  });

  await group("decide: reject records who, when and the note; the rider is told; the ops ring stops; nothing else moves", async () => {
    fresh();
    const e = pending("failed_delivery");
    assert.deepEqual(await decide(e.id, "reject", "  Try the back door  "), { ok: true });
    assert.equal(e.status, "rejected");
    assert.equal(e.decided_by, MGR);
    assert.ok(e.decided_at);
    assert.equal(e.decision_note, "Try the back door");
    assert.equal(delivery().status, "picked_up");
    assert.equal(order().status, "on_the_way");
    await settle();
    assert.deepEqual(log, [`stopOps:${e.id}`, `driver:${A}:failed_delivery:rejected:Try the back door`]);
    const ev = events("exception_decided");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor_id, MGR);
  });

  await group("decide: a second decision -> already_resolved, and the first stands", async () => {
    fresh();
    const e = pending("failed_delivery");
    // A rejection carries its reason (0152: the rider is told why).
    await decide(e.id, "reject", "Carry on, ops will call");
    assert.deepEqual(await decide(e.id, "approve", undefined, admin), { ok: false, error: "already_resolved" });
    assert.equal(e.status, "rejected");
    assert.equal(e.decided_by, MGR);
    assert.equal(delivery().status, "picked_up");
  });

  await group("decide: two managers at once -> exactly one decision applies", async () => {
    fresh();
    const e = pending("failed_delivery");
    const [r1, r2] = await Promise.all([decide(e.id, "approve"), decide(e.id, "reject", "Carry on, ops will call", admin)]);
    const oks = [r1, r2].filter((r) => r.ok).length;
    assert.equal(oks, 1, JSON.stringify([r1, r2]));
    assert.ok([r1, r2].some((r) => !r.ok && r.error === "already_resolved"));
    assert.equal(log.filter((l) => l.startsWith("cancel:")).length, e.status === "approved" ? 1 : 0);
  });

  await group("decide: acknowledge a report", async () => {
    fresh();
    const e = pending("vendor_delay");
    assert.deepEqual(await decide(e.id, "acknowledge"), { ok: true });
    assert.equal(e.status, "acknowledged");
    await settle();
    assert.ok(log.includes(`driver:${A}:vendor_delay:acknowledged:`));
  });

  for (const kind of ["failed_delivery", "customer_unreachable", "wrong_address"] as const) {
    await group(`approve ${kind}: the delivery fails (kind + reason) and the order is cancelled by the deciding role`, async () => {
      fresh();
      const e = pending(kind, { reason: "Gate locked" });
      const r = await decide(e.id, "approve", undefined, kind === "wrong_address" ? admin : manager);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(e.status, "approved");
      assert.equal(delivery().status, "failed");
      assert.equal(delivery().failure_reason, `${kind}: Gate locked`);
      assert.ok(delivery().failed_at);
      const by = kind === "wrong_address" ? "admin" : "manager";
      const who = kind === "wrong_address" ? ADM : MGR;
      assert.ok(log.includes(`cancel:${O1}:${by}:delivery_failed: ${kind}:${who}`), JSON.stringify(log));
      await settle();
      assert.ok(log.includes(`driver:${A}:${kind}:approved:`));
      assert.equal(events("failed").length, 1);
    });
  }

  await group("approve a failure on a delivery already delivered -> already_resolved; closed, nothing changed twice", async () => {
    fresh({ status: "delivered" }, { status: "delivered", delivered_at: ago(MIN), delivery_method: "code" });
    const e = pending("customer_unreachable");
    assert.deepEqual(await decide(e.id, "approve"), { ok: false, error: "already_resolved" });
    assert.equal(e.status, "rejected", "closed so the queue drops it");
    assert.match(e.decision_note ?? "", /already/i);
    assert.equal(delivery().status, "delivered");
    assert.equal(log.filter((l) => l.startsWith("cancel:")).length, 0);
  });

  await group("approve a failure after the job moved to another rider -> already_resolved", async () => {
    fresh({}, { driver_id: B });
    const e = pending("failed_delivery");
    assert.deepEqual(await decide(e.id, "approve"), { ok: false, error: "already_resolved" });
    assert.equal(delivery().status, "picked_up");
  });

  await group("approve complete_without_code: delivered with ops_approved, COD recorded once, customer told", async () => {
    fresh();
    const e = pending("complete_without_code");
    assert.deepEqual(await decide(e.id, "approve"), { ok: true });
    assert.equal(e.status, "approved");
    assert.equal(delivery().status, "delivered");
    assert.equal(delivery().delivery_method, "ops_approved");
    assert.equal(order().status, "delivered");
    assert.equal(delivery().cod_collected_amount, 350);
    await settle();
    assert.ok(log.includes(`delivered:${O1}`));
    assert.ok(log.includes(`driver:${A}:complete_without_code:approved:`));
    assert.deepEqual(events("delivered").map((v) => v.method), ["ops_approved"]);
  });

  await group("approve complete_without_code when the rider meanwhile delivered with the code -> already_resolved, COD once (Review Focus 5)", async () => {
    fresh();
    const e = pending("complete_without_code");
    assert.deepEqual(
      await actions.performDeliveryAction(A, O1, { action: "deliver", actionId: randomUUID(), code: "5678", method: "code" }, { settings: settingsWith(), notify: notify.delivery }),
      { ok: true }
    );
    const codAt = delivery().cod_collected_at;
    assert.deepEqual(await decide(e.id, "approve"), { ok: false, error: "already_resolved" });
    assert.equal(delivery().delivery_method, "code");
    assert.equal(delivery().cod_collected_at, codAt);
    assert.equal(events("delivered").length, 1);
  });

  await group("approve complete_without_code racing the rider's code (delivered between the read and the write) -> already_resolved", async () => {
    fresh();
    const e = pending("complete_without_code");
    mode.beforePatch.orders = () => {
      order().status = "delivered";
      Object.assign(delivery(), { status: "delivered", delivered_at: nowIso(), delivery_method: "code", cod_collected_amount: 350, cod_collected_at: nowIso() });
    };
    const r = await decide(e.id, "approve");
    assert.deepEqual(r, { ok: false, error: "already_resolved" });
    assert.equal(delivery().delivery_method, "code");
  });

  await group("complete_without_code under pod_photo_rule 'exceptions': no photo -> photo_required and still pending; with one it completes", async () => {
    fresh();
    const e = pending("complete_without_code");
    const rule = opts({ settings: settingsWith({ podPhotoRule: "exceptions" }) });
    assert.deepEqual(await decide(e.id, "approve", undefined, manager, rule), { ok: false, error: "photo_required" });
    assert.equal(e.status, "pending");
    assert.equal(delivery().status, "picked_up");
    const path = `${D1}/30000000-0000-4000-8000-000000000003.jpg`;
    delivery().pod_photo_path = path;
    assert.deepEqual(await decide(e.id, "approve", undefined, manager, rule), { ok: true });
    assert.equal(delivery().pod_photo_path, path);
    assert.equal(delivery().delivery_method, "ops_approved");
  });

  await group("complete_without_code under 'cod': a cash order needs the photo, a prepaid one does not; reject still works without one", async () => {
    fresh();
    const cod = opts({ settings: settingsWith({ podPhotoRule: "cod" }) });
    const e = pending("complete_without_code");
    assert.deepEqual(await decide(e.id, "approve", undefined, manager, cod), { ok: false, error: "photo_required" });
    assert.deepEqual(await decide(e.id, "reject", "Get the code", manager, cod), { ok: true });
    fresh({ payment_method: "online", payment_status: "paid" });
    const p = pending("complete_without_code");
    assert.deepEqual(await decide(p.id, "approve", undefined, manager, cod), { ok: true });
    assert.equal(delivery().cod_collected_amount, null, "nothing to collect on a prepaid order");
  });

  await group("approve manual_pickup: approved, and the rider's manual pickup then goes through (Task 3's path)", async () => {
    fresh({ status: "ready" }, { status: "assigned", picked_up_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null, assigned_at: ago(10 * MIN) });
    const e = pending("manual_pickup");
    const pickup = () =>
      actions.performDeliveryAction(A, O1, { action: "pickup", actionId: randomUUID(), method: "manual" }, { settings: settingsWith(), notify: notify.delivery });
    assert.deepEqual(await pickup(), { ok: false, error: "manual_not_approved" });
    assert.deepEqual(await decide(e.id, "approve"), { ok: true });
    assert.equal(delivery().status, "assigned", "the approval itself moves nothing");
    await settle();
    assert.ok(log.includes(`driver:${A}:manual_pickup:approved:`));
    assert.deepEqual(await pickup(), { ok: true });
    assert.equal(delivery().pickup_method, "manual");
  });

  await group("approve go_offline on an active job: released (correction, unique reason), stamps and offer cleared, re-dispatched without the rider, rider forced offline", async () => {
    fresh({ status: "ready" }, { status: "assigned", picked_up_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null, arrived_pickup_at: ago(5 * MIN), offered_driver_id: A, offered_at: ago(20 * MIN) });
    const e = pending("go_offline");
    assert.deepEqual(await decide(e.id, "approve"), { ok: true });
    const d = delivery();
    assert.equal(d.driver_id, null);
    assert.equal(d.status, "unassigned");
    assert.equal(d.correction_reason, `released:go_offline:${e.id}`);
    assert.equal(d.arrived_pickup_at, null);
    assert.equal(d.assigned_at, null);
    assert.equal(d.offered_driver_id, null);
    assert.equal(events("released")[0]?.driver_id, A);
    assert.ok(log.includes(`dispatch:${O1}:ready:${A}`), JSON.stringify(log));
    assert.ok(log.includes(`offline:${A}`));
    assert.ok(log.indexOf(`dispatch:${O1}:ready:${A}`) < log.indexOf(`offline:${A}`), "dispatch, then offline");
  });

  await group("approve go_offline twice on one job (released, re-taken, released again): each release has its own reason", async () => {
    fresh({ status: "kitchen" }, { status: "assigned", picked_up_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null, arrived_pickup_at: null });
    const first = pending("go_offline");
    assert.deepEqual(await decide(first.id, "approve"), { ok: true });
    assert.ok(log.includes(`dispatch:${O1}:accepted:${A}`), "an order still cooking is re-offered as a heads-up");
    Object.assign(delivery(), { status: "assigned", driver_id: A, assigned_at: nowIso() });
    const second = pending("go_offline", { created_at: nowIso() });
    assert.deepEqual(await decide(second.id, "approve"), { ok: true });
    assert.equal(delivery().driver_id, null);
    assert.equal(delivery().correction_reason, `released:go_offline:${second.id}`);
    assert.equal(events("released").length, 2);
  });

  await group("approve go_offline holding only an offer: the offer is turned down for them, then offline", async () => {
    fresh({ status: "ready" }, { status: "unassigned", driver_id: null, offered_driver_id: A, offered_at: ago(MIN), assigned_at: null, picked_up_at: null, arrived_pickup_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null });
    const e = pending("go_offline");
    assert.deepEqual(await decide(e.id, "approve"), { ok: true });
    assert.ok(log.includes(`rejectOffer:${A}:${O1}`));
    assert.ok(log.includes(`offline:${A}`));
    assert.equal(delivery().offered_driver_id, null);
  });

  await group("approve go_offline after the rider picked up -> already_resolved, nothing released, rider stays online (P2-R9)", async () => {
    fresh({ status: "ready" }, { status: "assigned", picked_up_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null });
    const e = pending("go_offline");
    // The rider collects the food while the request waits.
    Object.assign(delivery(), { status: "picked_up", picked_up_at: nowIso(), pickup_method: "code" });
    order().status = "on_the_way";
    assert.deepEqual(await decide(e.id, "approve"), { ok: false, error: "already_resolved" });
    assert.equal(delivery().driver_id, A);
    assert.equal(delivery().status, "picked_up");
    assert.equal(events("released").length, 0);
    assert.equal(log.filter((l) => l.startsWith("offline:") || l.startsWith("dispatch:")).length, 0);
    assert.equal(e.status, "rejected", "closed so it leaves the queue");
  });

  await group("approve go_offline left over from an earlier assignment -> already_resolved, nothing released", async () => {
    fresh({ status: "ready" }, { status: "assigned", picked_up_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null, assigned_at: nowIso() });
    const e = pending("go_offline", { created_at: ago(30 * MIN) });
    assert.deepEqual(await decide(e.id, "approve"), { ok: false, error: "already_resolved" });
    assert.equal(delivery().driver_id, A);
    assert.equal(log.filter((l) => l.startsWith("offline:")).length, 0);
  });

  await group("approve go_offline on an offer the rider accepted meanwhile -> already_resolved, rider stays online", async () => {
    fresh({ status: "ready" }, { status: "unassigned", driver_id: null, offered_driver_id: A, offered_at: ago(MIN), assigned_at: null, picked_up_at: null, arrived_pickup_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null });
    const e = pending("go_offline");
    const accepting = opts({
      effects: {
        ...effects,
        rejectOffer: async () => {
          // The rider's Accept landed first.
          Object.assign(delivery(), { status: "assigned", driver_id: A, assigned_at: nowIso() });
          return { ok: false as const, error: "not_offered" };
        },
      },
    });
    assert.deepEqual(await decide(e.id, "approve", undefined, manager, accepting), { ok: false, error: "already_resolved" });
    assert.equal(log.filter((l) => l.startsWith("offline:")).length, 0);
    assert.equal(delivery().driver_id, A);
  });

  await group("an approval whose effect throws -> effect_failed: approval stands, ops ring stopped, rider not told", async () => {
    fresh({ status: "ready" }, { status: "assigned", picked_up_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null });
    const e = pending("go_offline");
    const broken = opts({
      effects: {
        ...effects,
        forceOffline: async () => {
          throw new Error("rider_status unreachable");
        },
      },
    });
    const r = await decide(e.id, "approve", undefined, manager, broken);
    assert.deepEqual(r, { ok: false, error: "effect_failed", kind: "go_offline" });
    assert.equal(e.status, "approved", "a decision is final");
    await settle();
    assert.ok(log.includes(`stopOps:${e.id}`));
    assert.equal(log.filter((l) => l.startsWith("driver:")).length, 0);
    assert.equal(events("exception_decided").length, 1);
  });

  await group("complete_without_code whose completion throws -> effect_failed", async () => {
    fresh();
    const e = pending("complete_without_code");
    mode.failPatch.add("orders");
    const r = await decide(e.id, "approve");
    assert.equal(!r.ok && r.error, "effect_failed", JSON.stringify(r));
    assert.equal(e.status, "approved");
  });

  await group("effect_failed, then the same decision with the same clientActionId finishes it — decided once, rider told once", async () => {
    fresh({ status: "ready" }, { status: "assigned", picked_up_at: null, departed_pickup_at: null, arrived_drop_at: null, pickup_method: null });
    const e = pending("go_offline");
    const broken = opts({
      clientActionId: "retry-1",
      effects: {
        ...effects,
        forceOffline: async () => {
          throw new Error("rider_status unreachable");
        },
      },
    });
    assert.deepEqual(await decide(e.id, "approve", undefined, manager, broken), { ok: false, error: "effect_failed", kind: "go_offline" });
    assert.equal(delivery().driver_id, null, "the release happened before the failure");
    const r = await decide(e.id, "approve", undefined, manager, opts({ clientActionId: "retry-1" }));
    assert.deepEqual(r, { ok: true });
    assert.equal(log.filter((l) => l === `offline:${A}`).length, 1, "taken offline by the retry");
    await settle();
    const decided = t("delivery_events").filter((ev) => ev.kind === "exception_decided");
    assert.equal(decided.length, 1, "the decision was written once");
    assert.equal(log.filter((l) => l.startsWith("driver:")).length, 0, "the rider is not told twice (nor after the failure)");
  });

  await group("the job moves on between the board's check and the decision RPC -> closed as rejected, already_resolved", async () => {
    fresh();
    const e = pending("failed_delivery");
    // Another rider takes the job in the instant between stillLive and the RPC.
    mode.beforeRpc.ops_decide_delivery_exception = () => {
      Object.assign(delivery(), { driver_id: B, assigned_at: nowIso() });
    };
    const r = await decide(e.id, "approve");
    assert.deepEqual(r, { ok: false, error: "already_resolved" });
    assert.equal(e.status, "rejected", "closed so it leaves the queue");
    assert.match(String(e.decision_note), /Already resolved/);
    assert.equal(log.filter((l) => l.startsWith("cancel:")).length, 0, "nothing was failed or cancelled");
  });

  await group("approve go_offline after the job was delivered -> already_resolved, nobody forced offline", async () => {
    fresh({ status: "delivered" }, { status: "delivered", delivered_at: ago(MIN), delivery_method: "code" });
    const e = pending("go_offline");
    assert.deepEqual(await decide(e.id, "approve"), { ok: false, error: "already_resolved" });
    assert.equal(log.filter((l) => l.startsWith("offline:")).length, 0);
  });

  await group("an approval left over from an earlier assignment cannot fail the delivery (guard rule 11)", async () => {
    fresh({}, { assigned_at: nowIso() });
    const e = pending("failed_delivery", { created_at: ago(60 * MIN) });
    const r = await decide(e.id, "approve");
    assert.deepEqual(r, { ok: false, error: "already_resolved" });
    assert.equal(delivery().status, "picked_up", "the guard refused the failure");
    assert.equal(log.filter((l) => l.startsWith("cancel:")).length, 0);
  });

  await group("cancelOrderAsOps: refund first for a paid order, cancelled_by the deciding role, a failed delivery left as it is", async () => {
    fresh({ payment_method: "online", payment_status: "paid", total: 420 }, { status: "failed", failed_at: nowIso(), failure_reason: "failed_delivery: x" });
    const r = await cancellation.cancelOrderAsOps(O1, { by: "manager", reason: "delivery_failed: failed_delivery", requestedBy: MGR });
    assert.deepEqual(r, { ok: true, refundQueued: true });
    assert.equal(order().status, "cancelled");
    assert.equal(order().cancelled_by, "manager");
    assert.equal(order().cancellation_reason, "delivery_failed: failed_delivery");
    const refund = t("refunds")[0];
    assert.equal(refund?.amount, 420);
    assert.equal(refund?.requested_by, MGR);
    assert.equal(delivery().status, "failed");
    // The refund this order already carries is reported (pendingRefund), so the console can point at it.
    assert.deepEqual(await cancellation.cancelOrderAsOps(O1, { by: "admin", requestedBy: ADM }), {
      ok: false,
      error: "already_cancelled",
      pendingRefund: true,
    });
  });

  await group("cancelOrderAsOps: a delivered order is not cancelled; a COD order queues no refund; a live delivery is cancelled", async () => {
    fresh({ status: "delivered" });
    assert.deepEqual(await cancellation.cancelOrderAsOps(O1, { by: "admin", requestedBy: ADM }), { ok: false, error: "delivered" });
    fresh();
    assert.deepEqual(await cancellation.cancelOrderAsOps(O1, { by: "admin", reason: "customer asked", requestedBy: ADM }), { ok: true, refundQueued: false });
    assert.equal(t("refunds").length, 0);
    assert.equal(delivery().status, "cancelled");
  });

  await group("decideException with the real cancellation: an approved failure leaves the order cancelled by the manager", async () => {
    fresh();
    const e = pending("failed_delivery");
    const real = opts({ effects: { ...effects, cancelOrder: cancellation.cancelOrderAsOps } });
    const r = await decide(e.id, "approve", undefined, manager, real);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(order().status, "cancelled");
    assert.equal(order().cancelled_by, "manager");
    assert.equal(delivery().status, "failed");
  });
}

// ---------------------------------------------------------------------------
// 3. the route contract (needs `npm run dev`)
// ---------------------------------------------------------------------------
async function call(path: string, init: { body?: unknown; cookie?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
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

const ROUTE = "/api/rider/exceptions";
const NO_SUCH_ORDER = "00000000-0000-4000-8000-000000000000";

async function contract(): Promise<void> {
  try {
    await fetch(`${BASE}/api/rider/board`, { redirect: "manual" });
  } catch {
    skip(`dev server unreachable at ${BASE} - start it with \`npm run dev\` (contract checks)`);
    return;
  }

  const anon = await call(ROUTE, { body: { orderId: NO_SUCH_ORDER, kind: "other_issue", reason: "x" } });
  check(`no cookie -> 401  POST ${ROUTE}`, anon.status === 401, anon);

  if (CUSTOMER_EMAIL && CUSTOMER_PASSWORD) {
    const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    const res = await call(ROUTE, { body: { orderId: NO_SUCH_ORDER, kind: "other_issue", reason: "x" }, cookie });
    check("customer -> 403 not_rider", res.status === 403 && res.json?.error === "not_rider", res);
  } else {
    skip("customer 403 check: QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
  }

  if (!RIDER_EMAIL || !RIDER_PASSWORD) {
    skip("rider checks (400 invalid_kind / invalid_order / invalid_reason / invalid_photo_path / invalid_position, 404 not_found, 503 migration_pending): QA_RIDER_EMAIL / QA_RIDER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(RIDER_EMAIL, RIDER_PASSWORD);
  const expect400 = async (name: string, body: unknown, error: string) => {
    const res = await call(ROUTE, { body, cookie });
    check(`${name} -> 400 ${error}`, res.status === 400 && res.json?.error === error, res);
  };
  await expect400("unknown kind", { orderId: NO_SUCH_ORDER, kind: "teleport", reason: "x" }, "invalid_kind");
  await expect400("non-uuid order", { orderId: "nope", kind: "other_issue", reason: "x" }, "invalid_order");
  await expect400("blank reason", { orderId: NO_SUCH_ORDER, kind: "other_issue", reason: "  " }, "invalid_reason");
  await expect400("photo path not built by the server", { orderId: NO_SUCH_ORDER, kind: "other_issue", reason: "x", photoPath: "../x.jpg" }, "invalid_photo_path");
  await expect400("half a position", { orderId: NO_SUCH_ORDER, kind: "other_issue", reason: "x", lat: 21.2 }, "invalid_position");
  const gone = await call(ROUTE, { body: { orderId: NO_SUCH_ORDER, kind: "other_issue", reason: "x" }, cookie });
  check(
    "an order the rider does not hold -> 404 not_found (or 503 migration_pending before 0082)",
    (gone.status === 404 && gone.json?.error === "not_found") || (gone.status === 503 && gone.json?.error === "migration_pending"),
    gone
  );
}

async function main(): Promise<void> {
  console.log("-- 1. pure rules");
  await pureTier();
  console.log("-- 2. data layer (fake PostgREST)");
  await dataTier();
  console.log("-- 3. route contract");
  await contract();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
