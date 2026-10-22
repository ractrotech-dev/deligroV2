/**
 * QA — rider app Phase 7 Task 2: notifications, support tickets, SOS,
 * announcements, the instructions-changed push and the sweep's alerts.
 *
 *   npm run test:support   # tsx --conditions=react-server
 *
 *   BASE (optional)   a running dev server for the route contract (signed-out
 *                     answers only — nothing is written); SKIPped when absent.
 *
 * Tiers:
 *
 *   1. Pure — `lib/rider/notification-prefs.ts` (the `pushAllowed` table: the
 *      three locked categories always push, the nine others obey an explicit
 *      `false`), `lib/rider/alert-rules.ts` (`isHighDemand`,
 *      `needsPickupReminder`, `needsDelayAlert` at their thresholds) and
 *      `lib/support/rules.ts` (the §13.3 category order, default priorities,
 *      parsers, the 4-photo / 5 MB / JPEG-PNG rule).
 *   2. The data layer against an in-memory PostgREST + storage API:
 *      `notifyUser` (Review Focus 2: payouts muted → no push, inbox row still
 *      written; offers cannot be muted; a database without the prefs column
 *      or the inbox table), the rider pushes in `order-events.ts`, tickets
 *      (attachments, ownership, internal notes, Review Focus 4: another user's
 *      ticket mints no signed URL), staff replies and status pushes, SOS
 *      (Review Focus 5: ten taps → one ticket, ops rung once, nothing sent
 *      anywhere but the fake), the inbox and announcements, the customer's
 *      instructions change (Review Focus 3), the sweep's pickup reminder,
 *      delay alert and high-demand push (each once), and the Phase 2 carry
 *      (ruling P2-R11): a pickup report files a linked `high` ticket, a shop
 *      delay also notes the timeline.
 *   3. Structure — every new route starts with its auth gate; every write is
 *      rate-limited.
 *   4. Route contract (optional, BASE) — signed out is 401 everywhere.
 *
 * Never sends push/SMS/OTP and never writes live data: every ONESIGNAL
 * variable is removed before any module loads, pushes go to a recording
 * transport, the fake is the only thing written to, and every outbound
 * request is checked to have gone to the fake.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (const key of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?ONESIGNAL/i.test(key)) delete process.env[key];
}
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = (process.env.BASE ?? "").replace(/\/$/, "");

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
async function group(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    check(name, true);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? (e.stack ?? e.message).split("\n").slice(0, 4).join("\n     ") : String(e)}`);
  }
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------
// fake PostgREST + storage
// ---------------------------------------------------------------------------
const db: Record<string, Row[]> = {};
const t = (name: string): Row[] => (db[name] ??= []);
const mode = {
  missingTables: new Set<string>(),
  missingColumns: new Set<string>(),
  missingRpc: new Set<string>(),
  noBucket: false,
};
const storage = { uploads: [] as string[], signed: [] as string[], removed: [] as string[] };
const rpcCalls: { name: string; body: Row }[] = [];
let ticketSeq = 100;
const nowIso = () => new Date().toISOString();

function reset(): void {
  for (const k of Object.keys(db)) delete db[k];
  mode.missingTables.clear();
  mode.missingColumns.clear();
  mode.missingRpc.clear();
  mode.noBucket = false;
  storage.uploads.length = 0;
  storage.signed.length = 0;
  storage.removed.length = 0;
  rpcCalls.length = 0;
  pushes.length = 0;
}

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
      case "gt":
        hit = value != null && String(value) > arg;
        break;
      case "lte":
        hit = value != null && String(value) <= arg;
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
  const keys = order.split(",").map((part) => {
    const [col, dir] = part.split(".");
    return { col, sign: dir === "desc" ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { col, sign } of keys) {
      const x = a[col] ?? "";
      const y = b[col] ?? "";
      if (typeof x === "number" && typeof y === "number" && x !== y) return (x - y) * sign;
      if (String(x) < String(y)) return -sign;
      if (String(x) > String(y)) return sign;
    }
    return 0;
  });
}

const DEFAULTS: Record<string, () => Row> = {
  support_tickets: () => ({
    number: ++ticketSeq,
    priority: "normal",
    status: "open",
    order_id: null,
    cash_dispute_id: null,
    lat: null,
    lng: null,
    assigned_to: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    resolved_at: null,
  }),
  support_messages: () => ({ attachments: [], internal: false, created_at: nowIso() }),
  user_notifications: () => ({ data: {}, read_at: null, created_at: nowIso() }),
  announcements: () => ({ starts_at: nowIso(), ends_at: null, created_at: nowIso() }),
  delivery_events: () => ({ created_at: nowIso(), method: null, reason: null, lat: null, lng: null }),
  delivery_exceptions: () => ({ status: "pending", created_at: nowIso(), notes: null, photo_path: null, lat: null, lng: null }),
};

/** rider_raise_sos (0087 §5), as the proof pins it. */
function fakeSos(b: Row): Row {
  const safety = ["accident_emergency", "unsafe_situation", "accident", "vehicle_breakdown", "harassment_threat", "suspicious_order_location"];
  if (!safety.includes(b.p_category)) throw Object.assign(new Error("invalid_category"), { code: "22023" });
  const cutoff = new Date(Date.now() - (b.p_window_minutes ?? 10) * 60_000).toISOString();
  const open = t("support_tickets")
    .filter((x) => x.requester_id === b.p_driver && x.priority === "emergency" && safety.includes(x.category)
      && !["resolved", "closed"].includes(x.status) && x.updated_at > cutoff)
    .sort((a, c) => (a.updated_at < c.updated_at ? 1 : -1))[0];
  if (open) {
    t("support_messages").push({ id: randomUUID(), ticket_id: open.id, author_id: b.p_driver, author_role: "rider", body: b.p_body, attachments: b.p_attachments ?? [], internal: false, created_at: nowIso() });
    open.updated_at = nowIso();
    if (b.p_lat != null) open.lat = b.p_lat;
    if (b.p_lng != null) open.lng = b.p_lng;
    open.order_id ??= b.p_order;
    return { ticket_id: open.id, number: open.number, deduped: true };
  }
  const row = { ...DEFAULTS.support_tickets(), id: randomUUID(), requester_id: b.p_driver, requester_role: "rider", category: b.p_category, priority: "emergency", subject: b.p_subject, order_id: b.p_order, lat: b.p_lat, lng: b.p_lng };
  t("support_tickets").push(row);
  t("support_messages").push({ id: randomUUID(), ticket_id: row.id, author_id: b.p_driver, author_role: "rider", body: b.p_body, attachments: b.p_attachments ?? [], internal: false, created_at: nowIso() });
  return { ticket_id: row.id, number: row.number, deduped: false };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const send = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };
    const raw = Buffer.concat(chunks);

    // ---- storage -------------------------------------------------------
    if (url.pathname.startsWith("/storage/v1/")) {
      if (mode.noBucket) return send(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
      if (url.pathname.startsWith("/storage/v1/object/sign/")) {
        const body = JSON.parse(raw.toString() || "{}") as { expiresIn?: number; paths?: string[] };
        const rest = url.pathname.slice("/storage/v1/object/sign/".length);
        const slash = rest.indexOf("/");
        if (slash > 0) {
          const path = decodeURIComponent(rest.slice(slash + 1));
          storage.signed.push(path);
          return send(200, { signedURL: `/object/sign/x/${path}?token=t` });
        }
        for (const p of body.paths ?? []) storage.signed.push(p);
        return send(200, (body.paths ?? []).map((p) => ({ path: p, signedURL: `/object/sign/${rest}/${p}?token=t${body.expiresIn}`, error: null })));
      }
      if (req.method === "POST" && url.pathname.startsWith("/storage/v1/object/")) {
        const rest = url.pathname.slice("/storage/v1/object/".length);
        const path = decodeURIComponent(rest.slice(rest.indexOf("/") + 1));
        storage.uploads.push(path);
        return send(200, { Key: rest, Id: randomUUID() });
      }
      if (req.method === "DELETE") {
        const body = JSON.parse(raw.toString() || "{}") as { prefixes?: string[] };
        storage.removed.push(...(body.prefixes ?? []));
        return send(200, []);
      }
      return send(400, { message: "unsupported storage call" });
    }

    const table = url.pathname.replace("/rest/v1/", "");
    const text = raw.toString();
    const body: Row | Row[] | null = text ? JSON.parse(text) : null;
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const respond = (rows: Row[], code = 200, headers: Record<string, string> = {}) => {
      if (!single) return send(code, rows, headers);
      if (rows.length !== 1) return send(406, { code: "PGRST116", message: `${rows.length} rows` });
      return send(code, rows[0], headers);
    };

    if (table.startsWith("rpc/")) {
      const name = table.slice(4);
      if (name === "rider_raise_sos") {
        if (mode.missingRpc.has(name)) return send(404, { code: "PGRST202", message: "Could not find the function" });
        rpcCalls.push({ name, body: body as Row });
        try {
          return send(200, fakeSos(body as Row));
        } catch (e) {
          return send(400, { code: (e as { code?: string }).code, message: (e as Error).message });
        }
      }
      return send(200, null); // rate limiter, telemetry
    }
    if (mode.missingTables.has(table)) {
      return send(404, { code: "PGRST205", message: "Could not find the table in the schema cache" });
    }
    for (const entry of mode.missingColumns) {
      const [tbl, col] = entry.split(".");
      if (tbl !== table) continue;
      const named =
        req.method === "GET" || req.method === "HEAD"
          ? new RegExp(`(^|[^a-z_])${col}([^a-z_]|$)`).test((url.searchParams.get("select") ?? "") + "&" + [...url.searchParams.keys()].join("&"))
          : (Array.isArray(body) ? body : [body ?? {}]).some((b) => col in b) || url.searchParams.has(col);
      if (named) {
        return req.method === "GET" || req.method === "HEAD"
          ? send(400, { code: "42703", message: `column ${table}.${col} does not exist` })
          : send(400, { code: "PGRST204", message: `Could not find the '${col}' column of '${table}' in the schema cache` });
      }
    }

    const prefer = String(req.headers.prefer ?? "");
    if (req.method === "GET" || req.method === "HEAD") {
      let rows = ordered(t(table).filter((r) => matches(r, url)), url);
      const total = rows.length;
      const limit = Number(url.searchParams.get("limit"));
      if (limit > 0) rows = rows.slice(0, limit);
      const headers = prefer.includes("count=") ? { "content-range": `0-${Math.max(rows.length - 1, 0)}/${total}` } : {};
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        return res.end();
      }
      return respond(rows, 200, headers);
    }
    if (req.method === "POST" && body) {
      const incoming = Array.isArray(body) ? body : [body];
      const out: Row[] = [];
      for (const item of incoming) {
        if (table === "support_messages" && Array.isArray(item.attachments) && item.attachments.length > 4) {
          return send(400, { code: "23514", message: "support_messages_attachments_check" });
        }
        const row = { ...(DEFAULTS[table]?.() ?? {}), id: item.id ?? randomUUID(), ...item };
        t(table).push(row);
        out.push(row);
      }
      return respond(out, 201);
    }
    if (req.method === "PATCH" && body && !Array.isArray(body)) {
      const hit = t(table).filter((r) => matches(r, url));
      for (const row of hit) Object.assign(row, body);
      return respond(hit);
    }
    if (req.method === "DELETE") {
      const gone = t(table).filter((r) => matches(r, url));
      db[table] = t(table).filter((r) => !matches(r, url));
      return send(200, gone);
    }
    return send(405, { message: "unexpected" });
  });
});

// ---------------------------------------------------------------------------
// push recorder + outbound guard
// ---------------------------------------------------------------------------
interface Sent {
  userIds: string[];
  playerIds: string[];
  title: string;
  body: string;
  opts: Row;
}
const pushes: Sent[] = [];
const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  outbound.push(new URL(href).host);
  return realFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const R3 = "33333333-3333-4333-8333-333333333333";
const CUST = "44444444-4444-4444-8444-444444444444";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MGR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHOP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const O1 = "0d000001-0000-4000-8000-000000000001";
const O2 = "0d000002-0000-4000-8000-000000000002";
const DEL1 = "de000001-0000-4000-8000-000000000001";
const DEL2 = "de000002-0000-4000-8000-000000000002";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const jpeg = (name = "a.jpg") => new File([JPEG], name, { type: "image/jpeg" });
const png = (name = "b.png") => new File([PNG], name, { type: "image/png" });
const minutesAgo = (m: number, from = Date.now()) => new Date(from - m * 60_000).toISOString();

function seedPeople(): void {
  t("profiles").push(
    { id: R1, role: "driver", full_name: "Ravi Rider", phone: "+919800000001", onesignal_id: "player-r1" },
    { id: R2, role: "driver", full_name: "Second Rider", phone: "+919800000002", onesignal_id: null },
    { id: R3, role: "driver", full_name: "Third Rider", phone: "+919800000003", onesignal_id: null },
    { id: CUST, role: "customer", full_name: "Customer", phone: "+919800000004", onesignal_id: null },
    { id: ADMIN, role: "admin", full_name: "Admin", phone: null, onesignal_id: null },
    { id: MGR, role: "manager", full_name: "Manager", phone: null, onesignal_id: null },
    { id: SHOP, role: "restaurant", full_name: "Shop owner", phone: null, onesignal_id: null }
  );
  t("rider_profiles").push(
    { driver_id: R1, rider_code: "DR-0001", notification_prefs: {} },
    { driver_id: R2, rider_code: "DR-0002", notification_prefs: {} },
    { driver_id: R3, rider_code: "DR-0003", notification_prefs: {} }
  );
  t("restaurants").push({ id: "r0000001-0000-4000-8000-000000000001", owner_id: SHOP, name: "Spice Hub", eta_min: 25, eta_max: 35, prep_minutes: 15 });
  t("orders").push(
    { id: O1, customer_id: CUST, restaurant_id: "r0000001-0000-4000-8000-000000000001", status: "on_the_way", created_at: minutesAgo(60), accepted_at: minutesAgo(58), ready_at: minutesAgo(45), delivery_instructions: null },
    { id: O2, customer_id: CUST, restaurant_id: "r0000001-0000-4000-8000-000000000001", status: "ready", created_at: minutesAgo(30), accepted_at: minutesAgo(29), ready_at: minutesAgo(15), delivery_instructions: null }
  );
  t("deliveries").push(
    { id: DEL1, order_id: O1, driver_id: R1, status: "picked_up", assigned_at: minutesAgo(50), picked_up_at: minutesAgo(40), arrived_pickup_at: minutesAgo(42), pickup_reminded_at: null, delay_alerted_at: null, offered_driver_id: null, arrived_drop_at: null, pod_photo_path: null },
    { id: DEL2, order_id: O2, driver_id: R2, status: "assigned", assigned_at: minutesAgo(20), picked_up_at: null, arrived_pickup_at: null, pickup_reminded_at: null, delay_alerted_at: null, offered_driver_id: null, arrived_drop_at: null, pod_photo_path: null }
  );
  t("platform_settings").push({ id: true, support_phone: "+911234567890", support_whatsapp: "+911234567891", high_demand_ratio: 2, pickup_reminder_minutes: 10, delay_alert_minutes: 10, default_prep_minutes: 20 });
}

// ---------------------------------------------------------------------------
// 1. pure
// ---------------------------------------------------------------------------
async function pureTier(): Promise<void> {
  const prefs = await import("../../src/lib/rider/notification-prefs");
  const alerts = await import("../../src/lib/rider/alert-rules");
  const rules = await import("../../src/lib/support/rules");

  await group("pushAllowed: the twelve categories, three locked", () => {
    assert.deepEqual([...prefs.NOTIFICATION_CATEGORIES], [
      "offers", "cancellations", "safety", "pickup_reminders", "delivery_updates", "payouts",
      "incentives", "announcements", "support", "cash", "documents", "high_demand",
    ]);
    assert.deepEqual([...prefs.LOCKED_CATEGORIES], ["offers", "cancellations", "safety"]);
    for (const c of prefs.NOTIFICATION_CATEGORIES) {
      const locked = (prefs.LOCKED_CATEGORIES as readonly string[]).includes(c);
      assert.equal(prefs.pushAllowed({ [c]: false }, c), locked, `${c} switched off -> ${locked ? "still pushed (locked)" : "muted"}`);
      assert.equal(prefs.pushAllowed({ [c]: true }, c), true, `${c} on`);
      assert.equal(prefs.pushAllowed({}, c), true, `${c} with no preference`);
      assert.equal(prefs.pushAllowed(null, c), true, `${c} with no prefs at all (Phase 6 not applied)`);
    }
    assert.equal(prefs.pushAllowed({ payouts: "false" }, "payouts"), true, "only an explicit false mutes");
    assert.equal(prefs.pushAllowed({ payouts: 0 }, "payouts"), true);
    assert.equal(prefs.pushAllowed({ payouts: false }, "incentives"), true, "one category's switch mutes only that one");
    assert.equal(prefs.pushAllowed({ something_new: false }, "something_new"), false, "an unknown category obeys its switch");
    assert.equal(prefs.pushAllowed([] as unknown as Record<string, unknown>, "payouts"), true, "a non-object is no prefs");
    const eff = prefs.effectivePrefs({ payouts: false, offers: false, junk: 1 });
    assert.equal(eff.payouts, false);
    assert.equal(eff.offers, true, "a locked category reads on whatever is stored");
    assert.equal(Object.keys(eff).length, 12);
  });

  await group("alert rules at their thresholds", () => {
    const hd = (waitingOrders: number, idleOnlineRiders: number, ratio = 2) => alerts.isHighDemand({ waitingOrders, idleOnlineRiders, ratio });
    assert.equal(hd(2, 0), false, "fewer than 3 waiting is never high demand");
    assert.equal(hd(3, 0), true, "3 waiting, nobody idle");
    assert.equal(hd(4, 2), true, "4 per 2 idle = ratio 2");
    assert.equal(hd(3, 2), false, "1.5 per idle rider is under 2");
    assert.equal(hd(6, 2, 2.5), true);
    assert.equal(hd(5, 2, 2.5), true, "2.5 per idle rider meets a 2.5 ratio");
    assert.equal(hd(4, 2, 2.5), false);
    const now = new Date();
    const ago = (m: number) => minutesAgo(m, now.getTime());
    const base = { deliveryStatus: "assigned", orderStatus: "ready", arrivedPickupAt: null, remindedAt: null, now, minutes: 10 };
    assert.equal(alerts.needsPickupReminder({ ...base, readyAt: ago(9), assignedAt: ago(20) }), false, "9 min after ready: not yet");
    assert.equal(alerts.needsPickupReminder({ ...base, readyAt: ago(10), assignedAt: ago(20) }), true, "10 min: remind");
    assert.equal(alerts.needsPickupReminder({ ...base, readyAt: ago(30), assignedAt: ago(5) }), false, "measured from the later of ready and accepted");
    assert.equal(alerts.needsPickupReminder({ ...base, readyAt: ago(30), assignedAt: ago(30), remindedAt: ago(1) }), false, "once only");
    assert.equal(alerts.needsPickupReminder({ ...base, readyAt: ago(30), assignedAt: ago(30), arrivedPickupAt: ago(2) }), false, "already at the shop");
    assert.equal(alerts.needsPickupReminder({ ...base, orderStatus: "kitchen", readyAt: null, assignedAt: ago(30) }), false, "not ready yet");
    assert.equal(alerts.needsPickupReminder({ ...base, deliveryStatus: "picked_up", readyAt: ago(30), assignedAt: ago(30) }), false, "already picked up");
    const d = { deliveryStatus: "picked_up", alertedAt: null, now, minutes: 10 };
    assert.equal(alerts.needsDelayAlert({ ...d, etaAt: ago(9) }), false, "9 min past ETA: not yet");
    assert.equal(alerts.needsDelayAlert({ ...d, etaAt: ago(10) }), true, "10 min past ETA: alert");
    assert.equal(alerts.needsDelayAlert({ ...d, etaAt: ago(30), alertedAt: ago(5) }), false, "once only");
    assert.equal(alerts.needsDelayAlert({ ...d, etaAt: null }), false, "no ETA, no alert");
    assert.equal(alerts.needsDelayAlert({ ...d, deliveryStatus: "assigned", etaAt: ago(30) }), false, "only a picked-up delivery");
    assert.equal(alerts.recentlyOnline(ago(13 * 24 * 60), now), true, "13 days ago counts");
    assert.equal(alerts.recentlyOnline(ago(15 * 24 * 60), now), false, "15 days ago does not");
    assert.equal(alerts.recentlyOnline(null, now), false);
  });

  await group("support rules: §13.3 categories, priorities, parsers", () => {
    assert.deepEqual([...rules.RIDER_TICKET_CATEGORIES], [
      "vendor_not_handing_over", "customer_unreachable", "incorrect_address", "delivery_payment",
      "cash_reconciliation", "accident_emergency", "app_technical", "other",
    ]);
    assert.deepEqual([...rules.SAFETY_CATEGORIES], ["unsafe_situation", "accident", "vehicle_breakdown", "harassment_threat", "suspicious_order_location"]);
    assert.equal(rules.defaultPriority("accident_emergency"), "emergency");
    for (const c of rules.SAFETY_CATEGORIES) assert.equal(rules.defaultPriority(c), "emergency", c);
    for (const c of ["missing_items", "wrong_package", "vendor_delay", "other_issue"]) assert.equal(rules.defaultPriority(c), "high", c);
    assert.equal(rules.defaultPriority("app_technical"), "normal");
    assert.equal(rules.sosCategory("alert"), "accident_emergency");
    assert.equal(rules.sosCategory("harassment_threat"), "harassment_threat");
    for (const c of [...rules.RIDER_TICKET_CATEGORIES, ...rules.SAFETY_CATEGORIES]) assert.ok(rules.categoryLabel(c) !== c, `${c} has a label`);

    const ok = rules.parseNewTicket({ category: "app_technical", message: "  The map is blank  " });
    assert.ok(ok.ok && ok.value.message === "The map is blank" && ok.value.subject === "App or technical problem", "subject defaults to the category");
    assert.deepEqual(rules.parseNewTicket({ category: "missing_items", message: "x" }), { ok: false, error: "invalid_category" }, "pickup reports are filed by the server, not picked");
    assert.deepEqual(rules.parseNewTicket({ category: "other", message: "   " }), { ok: false, error: "invalid_message" });
    assert.deepEqual(rules.parseNewTicket({ category: "other", message: "x".repeat(4001) }), { ok: false, error: "invalid_message" });
    assert.deepEqual(rules.parseNewTicket({ category: "other", message: "x", subject: "s".repeat(121) }), { ok: false, error: "invalid_subject" });
    assert.deepEqual(rules.parseNewTicket({ category: "other", message: "x", orderId: "nope" }), { ok: false, error: "invalid_order" });
    const pos = rules.parseNewTicket({ category: "other", message: "x", lat: 0, lng: 0 });
    assert.ok(pos.ok && pos.value.lat === null, "an implausible position is dropped, not refused");

    assert.equal(rules.checkAttachments([{ size: 10, type: "image/jpeg" }]), null);
    assert.equal(rules.checkAttachments(Array.from({ length: 4 }, () => ({ size: 10, type: "image/png" }))), null, "4 photos");
    assert.equal(rules.checkAttachments(Array.from({ length: 5 }, () => ({ size: 10, type: "image/png" }))), "too_many_photos", "a 5th photo is refused");
    assert.equal(rules.checkAttachments([{ size: 5 * 1024 * 1024 + 1, type: "image/jpeg" }]), "photo_too_large");
    assert.equal(rules.checkAttachments([{ size: 5 * 1024 * 1024, type: "image/jpeg" }]), null, "exactly 5 MB");
    assert.equal(rules.checkAttachments([{ size: 10, type: "image/webp" }]), "bad_photo_type");

    assert.deepEqual(rules.parseSos({ kind: "panic" }), { ok: false, error: "invalid_kind" });
    const s = rules.parseSos({ kind: "alert", lat: 21.71, lng: 81.53, note: " help " });
    assert.ok(s.ok && s.value.lat === 21.71 && s.value.note === "help");
    const s0 = rules.parseSos({ kind: "alert", lat: "x", lng: 81 });
    assert.ok(s0.ok && s0.value.lat === null && s0.value.lng === null, "SOS never fails on a bad position");
    assert.equal(rules.locationLink(21.71, 81.53), "https://maps.google.com/?q=21.71,81.53");
    assert.equal(rules.locationLink(null, 81), null);

    assert.deepEqual(rules.parseStaffReply({ body: " ", internal: false }), { ok: false, error: "invalid_body" });
    const rep = rules.parseStaffReply({ body: "On it", internal: true, status: "in_progress" });
    assert.ok(rep.ok && rep.value.internal && rep.value.status === "in_progress");
    assert.ok(rules.parseStaffReply({ body: "x", internal: false, status: "bogus" }).ok === false);
    assert.deepEqual(rules.parseTicketFilter({ role: "rider", priority: "emergency", status: "open", category: "accident" }), { role: "rider", priority: "emergency", status: "open", category: "accident" });
    assert.deepEqual(rules.parseTicketFilter({ role: "hacker", priority: "x", status: "y", category: "'; drop" }), {});

    const ann = rules.parseAnnouncement({ audience: "rider", title: "Rain bonus", body: "Extra today", startsAt: null, endsAt: null, push: true });
    assert.ok(ann.ok && ann.value.audience === "rider");
    assert.deepEqual(rules.parseAnnouncement({ audience: "customer", title: "Hello", body: "x" }), { ok: false, error: "invalid_audience" });
    assert.deepEqual(rules.parseAnnouncement({ audience: "rider", title: "Hi", body: "x" }), { ok: false, error: "invalid_title" });
    assert.deepEqual(rules.parseAnnouncement({ audience: "rider", title: "Hello", body: "" }), { ok: false, error: "invalid_body" });
    assert.deepEqual(
      rules.parseAnnouncement({ audience: "rider", title: "Hello", body: "x", startsAt: "2026-10-22T10:00:00+05:30", endsAt: "2026-10-22T09:00:00+05:30" }),
      { ok: false, error: "invalid_dates" }
    );
  });
}

// ---------------------------------------------------------------------------
// 2. data layer
// ---------------------------------------------------------------------------
async function dataTier(): Promise<void> {
  const nu = await import("../../src/lib/notifications/notify-user");
  const events = await import("../../src/lib/notifications/order-events");
  const support = await import("../../src/lib/data-access/support");
  const sos = await import("../../src/lib/data-access/sos");
  const inbox = await import("../../src/lib/data-access/user-notifications");
  const ann = await import("../../src/lib/data-access/announcements");
  const instr = await import("../../src/lib/data-access/order-instructions");
  const alerts = await import("../../src/lib/data-access/rider-alerts");
  const exc = await import("../../src/lib/data-access/delivery-exceptions");
  const { rememberColumn } = await import("../../src/lib/data-access/schema-probe");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");

  nu.pushTransport.configured = () => true;
  nu.pushTransport.send = async (target, heading, message, opts = {}) => {
    const tg = target as { userIds?: string[]; playerIds?: (string | null)[] };
    pushes.push({
      userIds: (tg.userIds ?? []).filter(Boolean) as string[],
      playerIds: (tg.playerIds ?? []).filter(Boolean) as string[],
      title: typeof heading === "string" ? heading : heading.en,
      body: typeof message === "string" ? message : message.en,
      opts: opts as Row,
    });
    return true;
  };
  const fresh = () => {
    reset();
    nu.__resetNotifyForTests();
    for (const c of ["rider_profiles.notification_prefs", "deliveries.pickup_reminded_at", "orders.delivery_instructions"]) rememberColumn(c, true);
    seedPeople();
  };
  const inboxOf = (uid: string) => t("user_notifications").filter((n) => n.user_id === uid);
  const settle = () => new Promise((r) => setTimeout(r, 50));

  // ---- notifyUser ------------------------------------------------------
  await group("Review Focus 2: payouts switched off -> no push, the inbox entry is still written", async () => {
    fresh();
    t("rider_profiles")[0].notification_prefs = { payouts: false };
    await events.notifyRiderPayoutRecorded(R1, { amount: 500, reference: "UTR1" });
    const rows = inboxOf(R1);
    assert.equal(rows.length, 1, "one inbox row");
    assert.equal(rows[0].category, "payouts");
    assert.equal(rows[0].role, "rider");
    assert.match(rows[0].body, /₹500/);
    assert.match(rows[0].body, /recorded/i, "salaried riders: the copy describes a recorded ledger event");
    assert.equal(pushes.length, 0, "no push");
  });
  await group("the same payout with the switch on is pushed, to the user id and the stored player id", async () => {
    fresh();
    await events.notifyRiderPayoutRecorded(R1, { amount: 500, reference: null });
    assert.equal(inboxOf(R1).length, 1);
    assert.equal(pushes.length, 1);
    assert.deepEqual(pushes[0].userIds, [R1]);
    assert.deepEqual(pushes[0].playerIds, ["player-r1"]);
    assert.equal(pushes[0].opts.data.category, "payouts");
    assert.equal(pushes[0].opts.data.notificationId, inboxOf(R1)[0].id, "the push names its inbox row");
    assert.equal(inboxOf(R1)[0].data.url, "/earnings/payouts");
  });
  await group("offers, cancellations and safety cannot be muted", async () => {
    fresh();
    t("rider_profiles")[0].notification_prefs = { offers: false, cancellations: false, safety: false };
    await events.notifyDriverPickupReady(R1, { orderId: O1, restaurantName: "Spice Hub" });
    await events.notifyDriverOrderCancelled(R1, { orderId: O1, pickedUp: false });
    assert.equal(pushes.filter((p) => !p.opts.silent).length, 2, "offer and cancellation both pushed");
    const offer = pushes.find((p) => p.opts.data?.category === "offers")!;
    assert.equal(offer.opts.data.ring, "start", "the offer still rings");
    assert.equal(offer.opts.priority, 10);
    assert.deepEqual(inboxOf(R1).map((n) => n.category).sort(), ["cancellations", "offers"]);
  });
  await group("ring stop signals stay raw: a silent push and no inbox row", async () => {
    fresh();
    await events.stopRiderRing(R1, O1);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].opts.silent, true);
    assert.equal(pushes[0].opts.data.ring, "stop");
    assert.equal(inboxOf(R1).length, 0);
  });
  await group("no notification_prefs column (Phase 6 not applied) -> every category on", async () => {
    fresh();
    rememberColumn("rider_profiles.notification_prefs", true);
    mode.missingColumns.add("rider_profiles.notification_prefs");
    await events.notifyRiderIncentiveEarned(R1, { name: "Lunch rush", amount: 100 });
    assert.equal(pushes.length, 1, "pushed");
    assert.equal(inboxOf(R1)[0].category, "incentives");
  });
  await group("no inbox table (0087 not applied) -> the push still goes", async () => {
    fresh();
    mode.missingTables.add("user_notifications");
    const r = await nu.notifyUser({ userId: R1, role: "rider", category: "support", title: "Hi", body: "There" });
    assert.equal(r.inbox, false);
    assert.equal(r.pushed, true);
    assert.equal(pushes.length, 1);
  });
  await group("notifyUsers: one insert, one push for everyone not muted", async () => {
    fresh();
    t("rider_profiles")[1].notification_prefs = { announcements: false };
    const r = await nu.notifyUsers(
      [R1, R2, R3].map((userId) => ({ userId, role: "rider" as const })),
      { category: "announcements", title: "Rain bonus", body: "Extra ₹20 per delivery today", url: "/notifications" }
    );
    assert.equal(t("user_notifications").length, 3, "three inbox rows");
    assert.equal(pushes.length, 1, "one push call");
    assert.deepEqual(pushes[0].userIds.sort(), [R1, R3].sort(), "the muted rider is left out");
    assert.deepEqual(r, { inbox: 3, pushed: 2, muted: 1 });
  });

  // ---- tickets ---------------------------------------------------------
  const rider = { id: R1, role: "rider" as const };
  await group("createTicket: a rider's ticket with two photos, linked to their own order", async () => {
    fresh();
    const r = await support.createTicket(rider, { category: "customer_unreachable", message: "Nobody answers", orderId: O1, attachments: [jpeg(), png()] });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    const tk = t("support_tickets").find((x) => x.id === r.id)!;
    assert.equal(tk.requester_id, R1);
    assert.equal(tk.requester_role, "rider");
    assert.equal(tk.priority, "normal");
    assert.equal(tk.order_id, O1);
    assert.equal(tk.subject, "Customer unreachable");
    const m = t("support_messages").find((x) => x.ticket_id === r.id)!;
    assert.equal(m.body, "Nobody answers");
    assert.equal(m.attachments.length, 2);
    for (const p of m.attachments) assert.match(p, new RegExp(`^${R1}/[0-9a-f-]{36}\\.(jpg|png)$`), "paths are built by the server, in the uploader's folder");
    assert.deepEqual(storage.uploads.sort(), [...m.attachments].sort());
    assert.equal(r.number, tk.number);
  });
  await group("createTicket refuses before uploading: a 5th photo, a fake JPEG, another rider's order, a picked category it may not use", async () => {
    fresh();
    assert.deepEqual(await support.createTicket(rider, { category: "other", message: "x", attachments: [jpeg(), jpeg(), jpeg(), jpeg(), jpeg()] }), { ok: false, error: "too_many_photos" });
    const fake = new File([PNG], "x.jpg", { type: "image/jpeg" });
    assert.deepEqual(await support.createTicket(rider, { category: "other", message: "x", attachments: [fake] }), { ok: false, error: "bad_photo_type" });
    assert.deepEqual(await support.createTicket(rider, { category: "other", message: "x", orderId: O2 }), { ok: false, error: "invalid_order" }, "O2 is R2's");
    assert.deepEqual(await support.createTicket(rider, { category: "missing_items", message: "x" }), { ok: false, error: "invalid_category" });
    assert.equal(storage.uploads.length, 0, "nothing was uploaded");
    assert.equal(t("support_tickets").length, 0, "no ticket");
  });
  await group("createTicket with an emergency category goes through the SOS path: one ticket, ops rung", async () => {
    fresh();
    const r = await support.createTicket(rider, { category: "accident_emergency", message: "Fell off the bike", lat: 21.71, lng: 81.53 });
    assert.ok(r.ok);
    await settle();
    assert.equal(rpcCalls.length, 1, "rider_raise_sos called");
    assert.equal(t("support_tickets")[0].priority, "emergency");
    const ring = pushes.filter((p) => p.opts.data?.ring === "start");
    assert.equal(ring.length, 1);
    assert.deepEqual(ring[0].userIds.sort(), [ADMIN, MGR].sort(), "every admin and manager");
  });
  await group("getMyTicket: the thread without internal notes; another rider's ticket is null and mints no URL (Review Focus 4)", async () => {
    fresh();
    const r = await support.createTicket(rider, { category: "other", message: "Help", attachments: [jpeg()] });
    assert.ok(r.ok);
    if (!r.ok) return;
    t("support_messages").push(
      { id: randomUUID(), ticket_id: r.id, author_id: ADMIN, author_role: "admin", body: "We are on it", attachments: [], internal: false, created_at: nowIso() },
      { id: randomUUID(), ticket_id: r.id, author_id: ADMIN, author_role: "admin", body: "internal: rider is new", attachments: [], internal: true, created_at: nowIso() }
    );
    storage.signed.length = 0;
    const mine = await support.getMyTicket(R1, r.id);
    assert.ok(mine);
    assert.equal(mine!.messages.length, 2);
    assert.ok(!mine!.messages.some((m) => /internal/.test(m.body)), "no internal note");
    assert.equal(mine!.messages[1].fromStaff, true);
    assert.equal(mine!.messages[0].fromStaff, false);
    assert.equal(mine!.messages[0].attachments.length, 1);
    assert.match(mine!.messages[0].attachments[0].url ?? "", /token=t600/, "a 10-minute signed URL");
    assert.equal(storage.signed.length, 1);
    storage.signed.length = 0;
    assert.equal(await support.getMyTicket(R2, r.id), null, "not theirs: null, the same as missing");
    assert.equal(storage.signed.length, 0, "no URL was minted for them");
    assert.equal(await support.getMyTicket(R1, randomUUID()), null);
  });
  await group("replyToMyTicket: reopens a resolved ticket; another rider's is not_found", async () => {
    fresh();
    const r = await support.createTicket(rider, { category: "other", message: "Help" });
    assert.ok(r.ok);
    if (!r.ok) return;
    t("support_tickets")[0].status = "resolved";
    t("support_tickets")[0].resolved_at = nowIso();
    const ok = await support.replyToMyTicket(rider, r.id, { message: "Still broken", attachments: [png()] });
    assert.ok(ok.ok);
    assert.equal(t("support_tickets")[0].status, "open");
    assert.equal(t("support_tickets")[0].resolved_at, null);
    assert.deepEqual(await support.replyToMyTicket({ id: R2, role: "rider" }, r.id, { message: "x" }), { ok: false, error: "not_found" });
    assert.deepEqual(await support.replyToMyTicket(rider, r.id, { message: "x", attachments: [jpeg(), jpeg(), jpeg(), jpeg(), jpeg()] }), { ok: false, error: "too_many_photos" });
  });
  await group("listMyTickets: own only, newest activity first", async () => {
    fresh();
    await support.createTicket(rider, { category: "other", message: "one" });
    await support.createTicket({ id: R2, role: "rider" }, { category: "other", message: "theirs" });
    await support.createTicket(rider, { category: "app_technical", message: "two" });
    t("support_tickets")[0].updated_at = new Date(Date.now() + 60_000).toISOString();
    const list = await support.listMyTickets(R1);
    assert.equal(list.length, 2);
    assert.equal(list[0].category, "other", "the one touched last is first");
    assert.equal(list[0].categoryLabel, "Something else");
  });
  await group("staff replies and status changes push the rider (support); internal notes do not", async () => {
    fresh();
    const r = await support.createTicket(rider, { category: "other", message: "Help" });
    assert.ok(r.ok);
    if (!r.ok) return;
    pushes.length = 0;
    await support.staffReply(r.id, { id: ADMIN, role: "admin" }, { body: "internal: check logs", internal: true });
    assert.equal(pushes.length, 0, "an internal note tells nobody");
    assert.equal(t("support_tickets")[0].status, "open", "...and moves nothing");
    await support.staffReply(r.id, { id: ADMIN, role: "admin" }, { body: "Please reinstall the app", internal: false });
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].opts.data.category, "support");
    assert.equal(pushes[0].opts.data.url, `/help/tickets/${r.id}`);
    assert.equal(t("support_tickets")[0].status, "waiting_on_requester", "a public reply waits on the rider");
    await support.setTicketStatus(r.id, "resolved", { id: ADMIN, role: "admin" });
    assert.equal(pushes.length, 2);
    assert.match(pushes[1].title, /resolved/);
    assert.ok(t("support_tickets")[0].resolved_at);
    assert.equal(inboxOf(R1).filter((n) => n.category === "support").length, 2);
  });
  await group("the first staff action on an emergency stops every ops phone ringing", async () => {
    fresh();
    const s = await sos.raiseSos(R1, { kind: "alert", lat: 21.7, lng: 81.5 });
    await settle();
    pushes.length = 0;
    await support.assignTicketToSelf(s.ticketId, { id: MGR, role: "manager" });
    const stop = pushes.find((p) => p.opts.data?.ring === "stop");
    assert.ok(stop, "a stop was sent");
    assert.equal(stop!.opts.data.ringId, `ops:sos:${s.ticketId}`);
    assert.equal(stop!.opts.silent, true);
    assert.equal(t("support_tickets")[0].assigned_to, MGR);
  });
  await group("listTicketsForStaff: emergencies pinned first, filters apply", async () => {
    fresh();
    await support.createTicket(rider, { category: "other", message: "a" });
    await sos.raiseSos(R2, { kind: "accident" });
    await support.createTicket({ id: R3, role: "rider" }, { category: "app_technical", message: "b" });
    const all = await support.listTicketsForStaff({});
    assert.equal(all[0].priority, "emergency");
    assert.equal(all[0].requesterName, "Second Rider");
    assert.equal((await support.listTicketsForStaff({ category: "app_technical" })).length, 1);
    assert.equal((await support.listTicketsForStaff({ priority: "emergency" })).length, 1);
    assert.equal((await support.listTicketsForStaff({ role: "vendor" })).length, 0);
    assert.equal((await support.listOpenEmergencies()).length, 1);
  });

  // ---- SOS -------------------------------------------------------------
  await group("Review Focus 5: ten taps in a minute -> one ticket, later taps are location updates, ops rung once", async () => {
    fresh();
    outbound.length = 0;
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await sos.raiseSos(R1, { kind: "alert", lat: 21.7 + i / 1000, lng: 81.5 }));
    await settle();
    assert.equal(new Set(results.map((r) => r.ticketId)).size, 1, "one ticket");
    assert.deepEqual(results.map((r) => r.deduped), [false, true, true, true, true, true, true, true, true, true]);
    assert.equal(t("support_tickets").length, 1);
    assert.equal(t("support_messages").length, 10, "ten messages");
    assert.match(t("support_messages")[9].body, /maps\.google\.com\/\?q=21\.709,81\.5/, "each tap carries its position");
    const rings = pushes.filter((p) => p.opts.data?.ring === "start");
    assert.equal(rings.length, 1, "rung once");
    assert.equal(rings[0].opts.data.ringId, `ops:sos:${results[0].ticketId}`);
    assert.deepEqual(rings[0].userIds.sort(), [ADMIN, MGR].sort(), "every manager and admin");
    const body = rings[0].body;
    assert.match(body, /Ravi Rider/);
    assert.match(body, /\+919800000001/);
    assert.match(body, /DR-0001/);
    assert.match(body, new RegExp(`#${O1.slice(0, 8).toUpperCase()}`), "the active order's code");
    assert.match(body, /maps\.google\.com/);
    assert.ok(outbound.every((h) => h.startsWith("127.0.0.1")), `SOS reached nothing but the fake: ${[...new Set(outbound)].join(", ")}`);
    const riderInbox = inboxOf(R1);
    assert.equal(riderInbox.length, 1, "the rider's own record of it, once");
    assert.equal(riderInbox[0].category, "safety");
    assert.match(riderInbox[0].body, /Deligro ops have been alerted/);
    assert.ok(!/(police|ambulance|emergency services|112)/i.test(riderInbox[0].body + riderInbox[0].title), "never claims outside services were contacted");
    assert.equal(pushes.filter((p) => p.userIds.includes(R1)).length, 0, "the rider is not pushed about their own SOS");
  });
  await group("SOS: another rider's order id is ignored; no order given uses the active delivery", async () => {
    fresh();
    await sos.raiseSos(R1, { kind: "unsafe_situation", orderId: O2 });
    assert.equal(rpcCalls[0].body.p_order, O1, "O2 is R2's: R1's active order is used instead");
    assert.equal(rpcCalls[0].body.p_category, "unsafe_situation");
  });
  await group("SOS on a database without 0087 -> migration pending (503), never a fake success", async () => {
    fresh();
    mode.missingRpc.add("rider_raise_sos");
    await assert.rejects(sos.raiseSos(R1, { kind: "alert" }), (e) => isRiderSchemaPending(e));
  });

  // ---- inbox + announcements ------------------------------------------
  await group("inbox: own rows newest first, paged, unread count, mark read", async () => {
    fresh();
    for (let i = 0; i < 5; i++) {
      t("user_notifications").push({ id: randomUUID(), user_id: R1, role: "rider", category: "support", title: `n${i}`, body: "b", data: {}, read_at: null, created_at: new Date(Date.now() - (5 - i) * 60_000).toISOString() });
    }
    t("user_notifications").push({ id: randomUUID(), user_id: R2, role: "rider", category: "support", title: "theirs", body: "b", data: {}, read_at: null, created_at: nowIso() });
    const p1 = await inbox.getInbox(R1, { limit: 3 });
    assert.deepEqual(p1.items.map((n) => n.title), ["n4", "n3", "n2"]);
    assert.equal(p1.hasMore, true);
    assert.equal(p1.unread, 5);
    const p2 = await inbox.getInbox(R1, { limit: 3, before: p1.nextBefore! });
    assert.deepEqual(p2.items.map((n) => n.title), ["n1", "n0"]);
    assert.equal(p2.hasMore, false);
    assert.equal(await inbox.markRead(R1, [p1.items[0].id, t("user_notifications")[5].id]), 1, "someone else's id is ignored");
    assert.equal((await inbox.getInbox(R1)).unread, 4);
    assert.equal(await inbox.markRead(R1, "all"), 4);
    assert.equal(t("user_notifications")[5].read_at, null, "the other rider's row untouched");
  });
  await group("announcements: a rider gets live rider + all; publishing to riders fans out once per rider", async () => {
    fresh();
    t("announcements").push(
      { id: randomUUID(), audience: "rider", title: "Live", body: "b", starts_at: minutesAgo(10), ends_at: null, created_at: nowIso() },
      { id: randomUUID(), audience: "all", title: "Everyone", body: "b", starts_at: minutesAgo(10), ends_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: nowIso() },
      { id: randomUUID(), audience: "vendor", title: "Shops", body: "b", starts_at: minutesAgo(10), ends_at: null, created_at: nowIso() },
      { id: randomUUID(), audience: "rider", title: "Later", body: "b", starts_at: new Date(Date.now() + 3_600_000).toISOString(), ends_at: null, created_at: nowIso() },
      { id: randomUUID(), audience: "rider", title: "Over", body: "b", starts_at: minutesAgo(100), ends_at: minutesAgo(10), created_at: nowIso() }
    );
    assert.deepEqual((await ann.listLiveAnnouncements("rider")).map((a) => a.title).sort(), ["Everyone", "Live"]);
    pushes.length = 0;
    const r = await ann.createAnnouncement(ADMIN, { audience: "rider", title: "Rain bonus", body: "Extra today", startsAt: null, endsAt: null, push: true });
    assert.equal(r.reached, 3, "three riders");
    assert.equal(t("user_notifications").filter((n) => n.category === "announcements").length, 3);
    assert.equal(pushes.length, 1);
    const later = await ann.createAnnouncement(ADMIN, { audience: "rider", title: "Next week", body: "x", startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: null, push: true });
    assert.equal(later.reached, 0, "a scheduled one is not pushed now");
  });

  // ---- instructions (Review Focus 3) ------------------------------------
  await group("Review Focus 3: instructions changed while the rider carries the order -> delivery_updates push + timeline note", async () => {
    fresh();
    const r = await instr.updateOrderInstructions(CUST, O1, "Gate code 4821, blue door");
    assert.deepEqual(r, { ok: true, instructions: "Gate code 4821, blue door", riderTold: true });
    assert.equal(t("orders")[0].delivery_instructions, "Gate code 4821, blue door");
    await settle();
    const push = pushes.find((p) => p.opts.data?.category === "delivery_updates");
    assert.ok(push, "pushed");
    assert.deepEqual(push!.userIds, [R1]);
    assert.equal(push!.opts.data.orderId, O1);
    assert.equal(push!.opts.data.instructions, "Gate code 4821, blue door");
    assert.match(push!.body, /Gate code 4821/);
    const note = t("delivery_events").find((e) => e.kind === "note");
    assert.ok(note && note.method === "instructions_changed" && note.delivery_id === DEL1, "a timeline note the app can highlight from");
  });
  await group("instructions: not the customer's order 404s; delivered is closed; too long refused; no rider yet -> no push", async () => {
    fresh();
    assert.deepEqual(await instr.updateOrderInstructions(R1, O1, "x"), { ok: false, error: "not_found" });
    t("orders")[0].status = "delivered";
    assert.deepEqual(await instr.updateOrderInstructions(CUST, O1, "x"), { ok: false, error: "order_closed" });
    assert.deepEqual(await instr.updateOrderInstructions(CUST, O2, "x".repeat(301)), { ok: false, error: "instructions_too_long" });
    t("deliveries")[1].driver_id = null;
    t("deliveries")[1].status = "unassigned";
    const r = await instr.updateOrderInstructions(CUST, O2, "Ring twice");
    assert.deepEqual(r, { ok: true, instructions: "Ring twice", riderTold: false });
    await settle();
    assert.equal(pushes.length, 0);
  });

  // ---- sweep alerts -------------------------------------------------------
  const settings = { highDemandRatio: 2, pickupReminderMinutes: 10, delayAlertMinutes: 10, defaultPrepMinutes: 20 };
  await group("pickup reminder: ready 15 min, rider not arrived -> one push, once", async () => {
    fresh();
    assert.equal(await alerts.remindPickups(Date.now(), settings), 1);
    assert.equal(await alerts.remindPickups(Date.now(), settings), 0, "the stamp makes it once");
    const p = pushes.filter((x) => x.opts.data?.category === "pickup_reminders");
    assert.equal(p.length, 1);
    assert.deepEqual(p[0].userIds, [R2]);
    assert.ok(t("deliveries")[1].pickup_reminded_at);
  });
  await group("delay alert: picked up 40 min ago, past its ETA -> rider and ops told, once", async () => {
    fresh();
    assert.equal(await alerts.alertDelays(Date.now(), settings), 1);
    assert.equal(await alerts.alertDelays(Date.now(), settings), 0);
    const rider = pushes.filter((x) => x.opts.data?.category === "delivery_updates");
    assert.equal(rider.length, 1);
    assert.deepEqual(rider[0].userIds, [R1]);
    const ops = pushes.filter((x) => x.userIds.includes(ADMIN));
    assert.equal(ops.length, 1, "ops pushed once");
    assert.equal(inboxOf(ADMIN).length, 0, "ops pushes are not inbox rows");
  });
  await group("high demand: 4 waiting, 1 idle -> offline riders seen in 14 days, at most once per 30 min", async () => {
    fresh();
    t("orders").push(
      ...[1, 2, 3, 4].map((n) => ({ id: `0e00000${n}-0000-4000-8000-000000000000`, status: "ready", created_at: minutesAgo(10), ready_at: minutesAgo(5) }))
    );
    t("rider_status").push(
      { driver_id: R1, is_online: true, break_until: null, updated_at: nowIso() },
      { driver_id: R2, is_online: true, break_until: null, updated_at: nowIso() },
      { driver_id: R3, is_online: false, break_until: null, updated_at: minutesAgo(60) }
    );
    t("rider_shifts").push(
      { driver_id: R3, started_at: minutesAgo(3 * 24 * 60), ended_at: minutesAgo(3 * 24 * 60 - 60) },
      { driver_id: "99999999-9999-4999-8999-999999999999", started_at: minutesAgo(20 * 24 * 60), ended_at: minutesAgo(20 * 24 * 60 - 60) }
    );
    // R1 carries DEL1 and R2 holds DEL2: neither is idle.
    assert.equal(await alerts.alertHighDemand(Date.now(), settings), 1, "one offline rider pushed");
    const p = pushes.filter((x) => x.opts.data?.category === "high_demand");
    assert.equal(p.length, 1);
    assert.deepEqual(p[0].userIds, [R3]);
    assert.equal(await alerts.alertHighDemand(Date.now(), settings), 0, "not again within 30 minutes");
  });
  await group("without 0087's stamps the sweep sends nothing (it could not send once)", async () => {
    fresh();
    rememberColumn("deliveries.pickup_reminded_at", true);
    mode.missingColumns.add("deliveries.pickup_reminded_at");
    mode.missingColumns.add("deliveries.delay_alerted_at");
    assert.equal(await alerts.remindPickups(Date.now(), settings), 0);
    assert.equal(await alerts.alertDelays(Date.now(), settings), 0);
    assert.equal(pushes.length, 0);
    rememberColumn("deliveries.pickup_reminded_at", true);
  });

  // ---- pickup reports (ruling P2-R11) -------------------------------------
  await group("P2-R11: a shop-delay report files a linked high ticket and notes the timeline", async () => {
    fresh();
    t("deliveries")[1].arrived_pickup_at = minutesAgo(5);
    const r = await exc.raiseException(R2, { orderId: O2, kind: "vendor_delay", reason: "Food not ready", notes: "Waiting 15 min" }, { notify: { opsRequested: async () => undefined } });
    assert.ok(r.ok, JSON.stringify(r));
    await settle();
    const tk = t("support_tickets")[0];
    assert.ok(tk, "a ticket");
    assert.equal(tk.priority, "high");
    assert.equal(tk.category, "vendor_delay");
    assert.equal(tk.order_id, O2);
    assert.equal(tk.requester_id, R2);
    assert.match(t("support_messages")[0].body, /Food not ready/);
    const note = t("delivery_events").find((e) => e.kind === "note");
    assert.ok(note, "a timeline note");
    assert.match(note!.reason, /Shop delay/);
  });
  await group("P2-R11: a missing-items report files a ticket without a note; a request files none", async () => {
    fresh();
    const a = await exc.raiseException(R2, { orderId: O2, kind: "missing_items", reason: "Raita missing" }, { notify: { opsRequested: async () => undefined } });
    assert.ok(a.ok);
    await settle();
    assert.equal(t("support_tickets").length, 1);
    assert.equal(t("support_tickets")[0].category, "missing_items");
    assert.equal(t("delivery_events").filter((e) => e.kind === "note").length, 0);
    const b = await exc.raiseException(R1, { orderId: O1, kind: "wrong_address", reason: "No such house" }, { notify: { opsRequested: async () => undefined } });
    assert.ok(b.ok, JSON.stringify(b));
    await settle();
    assert.equal(t("support_tickets").length, 1, "a request is decided in the exception queue, not ticketed");
  });
}

// ---------------------------------------------------------------------------
// 3. structure
// ---------------------------------------------------------------------------
async function structureTier(): Promise<void> {
  const routes: { file: string; gate: RegExp; writes: string[] }[] = [
    { file: "src/app/api/rider/support/tickets/route.ts", gate: /requireRiderApi\(\)/, writes: ["POST"] },
    { file: "src/app/api/rider/support/tickets/[id]/route.ts", gate: /requireRiderApi\(\)/, writes: [] },
    { file: "src/app/api/rider/support/tickets/[id]/messages/route.ts", gate: /requireRiderApi\(\)/, writes: ["POST"] },
    { file: "src/app/api/rider/sos/route.ts", gate: /requireRiderApi\(\)/, writes: ["POST"] },
    { file: "src/app/api/rider/notifications/route.ts", gate: /requireRiderApi\(\)/, writes: ["POST"] },
    { file: "src/app/api/rider/announcements/route.ts", gate: /requireRiderApi\(\)/, writes: [] },
    { file: "src/app/api/orders/[id]/instructions/route.ts", gate: /auth\.getUser\(\)/, writes: ["PATCH"] },
  ];
  await group("every new route opens with its auth gate, and every write is rate-limited", () => {
    for (const r of routes) {
      const src = readFileSync(join(root, r.file), "utf8");
      for (const m of src.matchAll(/export async function (GET|POST|PATCH)\b[\s\S]*?\{([\s\S]*?)\n\}/g)) {
        const bodyText = m[2];
        const gateAt = bodyText.search(r.gate);
        assert.ok(gateAt >= 0, `${r.file} ${m[1]}: no auth gate`);
        for (const call of ["createAdminClient(", "request.json(", "request.formData(", "readSupportBody("]) {
          const at = bodyText.indexOf(call);
          assert.ok(at < 0 || at > gateAt, `${r.file} ${m[1]}: ${call} before the gate`);
        }
        if (r.writes.includes(m[1])) assert.match(bodyText, /rateLimit\(/, `${r.file} ${m[1]}: not rate-limited`);
      }
    }
  });
  await group("no SOS copy claims outside services were contacted", () => {
    for (const f of ["src/lib/data-access/sos.ts", "src/app/api/rider/sos/route.ts", "src/lib/notifications/order-events.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      for (const bad of [/police (have|has) been/i, /ambulance (is|has)/i, /emergency services (have|were|are) (been )?(contacted|alerted|notified)/i]) {
        assert.ok(!bad.test(src), `${f}: ${bad}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 4. route contract (optional)
// ---------------------------------------------------------------------------
async function contractTier(): Promise<void> {
  if (!BASE) {
    console.log("SKIP route contract: set BASE to a running dev server");
    return;
  }
  try {
    await realFetch(`${BASE}/api/rider/me`, { signal: AbortSignal.timeout(5000) });
  } catch {
    console.log(`SKIP route contract: ${BASE} is not reachable`);
    return;
  }
  const id = randomUUID();
  const calls: [string, string][] = [
    ["GET", "/api/rider/support/tickets"],
    ["POST", "/api/rider/support/tickets"],
    ["GET", `/api/rider/support/tickets/${id}`],
    ["POST", `/api/rider/support/tickets/${id}/messages`],
    ["POST", "/api/rider/sos"],
    ["GET", "/api/rider/notifications"],
    ["POST", "/api/rider/notifications"],
    ["GET", "/api/rider/announcements"],
    ["PATCH", `/api/orders/${id}/instructions`],
  ];
  for (const [method, path] of calls) {
    const res = await realFetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    });
    check(`signed out: ${method} ${path} -> 401`, res.status === 401, res.status);
  }
}

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  console.log("1. pure");
  await pureTier();
  console.log("2. data layer (fake PostgREST)");
  await dataTier();
  console.log("3. structure");
  await structureTier();
  console.log("4. route contract");
  await contractTier();

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
