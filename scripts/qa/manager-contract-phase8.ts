/**
 * Phase 8 fixtures for the manager contract check: support, alerts, the
 * inbox and the audit log.
 *
 *   npm run test:manager-contract   (runs this after the Phase 3–6 emitters)
 *
 * Runs the readers the routes call (`listTickets`, `getTicketThread`,
 * `ticketMetrics`, `listAlerts`, `getAlert`, `listRules`, `listInbox`,
 * `unreadSummary`, `listAudit`, `getAuditEntry`, …) against a seeded,
 * in-memory PostgREST and writes exactly what each route sends to
 * `apps/manager/test/fixtures/api/generated/phase8/`. The app's
 * `test/contract_phase8_test.dart` checks every key of its hand-written
 * fixtures is in these answers, with the same JSON type, and parses them.
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const NOW = new Date("2026-10-21T08:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const Z1 = "8a8a8a8a-1111-4111-8111-000000000001";
const S1 = "8a8a8a8a-2222-4222-8222-000000000001";
const R = "8a8a8a8a-3333-4333-8333-000000000001"; // a rider
const M = "8a8a8a8a-4444-4444-8444-000000000001"; // the viewing manager
const M2 = "8a8a8a8a-4444-4444-8444-000000000002";
const A = "8a8a8a8a-5555-4555-8555-000000000001"; // an admin
const C = "8a8a8a8a-6666-4666-8666-000000000001"; // a customer
const id = (n: number) => `8a8a8a8a-9999-4999-8999-${String(n).padStart(12, "0")}`;
const T1 = id(1), T2 = id(2), T3 = id(3), O1 = id(10);
const AL1 = id(20), AL2 = id(21), AL3 = id(22);
const PATH1 = `${T1}/${id(90)}.jpg`;

const ticket = (tid: string, number: number, extra: Row = {}): Row => ({
  id: tid, number, subject: "Rider did not arrive", category: "delivery_issue", priority: "normal", status: "open",
  requester_role: "customer", order_id: O1, created_at: ago(90), updated_at: ago(30), requester_id: C, restaurant_id: S1,
  zone_id: Z1, assigned_to: null, team: null, escalation_level: 0, first_response_at: null, resolved_at: null,
  resolution: null, restaurants: { name: "Spice Hub" }, ...extra,
});

const tables: Record<string, Row[]> = {
  delivery_zones: [{ id: Z1, name: "Bemetara" }],
  restaurants: [{ id: S1, name: "Spice Hub" }],
  staff_zones: [{ user_id: M, zone_id: Z1 }, { user_id: M2, zone_id: Z1 }],
  profiles: [
    { id: M, full_name: "Asha Verma", role: "manager" },
    { id: M2, full_name: "Vikram Sahu", role: "manager" },
    { id: A, full_name: "Deligro Admin", role: "admin" },
    { id: C, full_name: "Neha Sharma", role: "customer" },
    { id: R, full_name: "Ravi Kumar", role: "driver" },
  ],
  rider_profiles: [{ driver_id: R, rider_code: "DR-0007" }],
  support_tickets: [
    ticket(T1, 101, { assigned_to: M, team: "operations", status: "in_progress", first_response_at: ago(60) }),
    ticket(T2, 102, { subject: "SOS — rider needs help", category: "accident_emergency", priority: "emergency", status: "escalated", requester_role: "rider", requester_id: R, order_id: null, restaurant_id: null, escalation_level: 2 }),
    ticket(T3, 103, { subject: "Wrong item", category: "wrong_item", status: "resolved", requester_role: "vendor", requester_id: A, first_response_at: ago(120), resolved_at: ago(45), resolution: "Replaced the item", updated_at: ago(45) }),
  ],
  support_messages: [
    { id: id(30), ticket_id: T1, author_id: C, author_role: "customer", body: "Where is my order?", internal: false, attachments: [PATH1], created_at: ago(85), profiles: { full_name: "Neha Sharma" } },
    { id: id(31), ticket_id: T1, author_id: M, author_role: "manager", body: "Checking with the rider.", internal: false, attachments: [], created_at: ago(60), profiles: { full_name: "Asha Verma" } },
    { id: id(32), ticket_id: T1, author_id: M, author_role: "manager", body: "Rider phone was off; call vendor.", internal: true, attachments: [], created_at: ago(55), profiles: { full_name: "Asha Verma" } },
    { id: id(33), ticket_id: T1, author_id: C, author_role: "customer", body: "Still waiting", internal: false, attachments: [], created_at: ago(30), profiles: { full_name: "Neha Sharma" } },
    { id: id(34), ticket_id: T2, author_id: R, author_role: "rider", body: "SOS pressed. Location shared.", internal: false, attachments: [], created_at: ago(20), profiles: { full_name: "Ravi Kumar" } },
  ],
  support_ticket_events: [
    { id: 1, ticket_id: T1, kind: "status", from_value: "open", to_value: "in_progress", actor_id: M, reason: null, internal: false, created_at: ago(60) },
    { id: 2, ticket_id: T1, kind: "assigned", from_value: null, to_value: M, actor_id: M2, reason: null, internal: false, created_at: ago(58) },
    { id: 3, ticket_id: T1, kind: "attachment", from_value: null, to_value: "1", actor_id: M, reason: null, internal: true, created_at: ago(55) },
  ],
  ops_alerts: [
    { id: AL1, kind: "order_unassigned", severity: "critical", status: "open", title: "Order D7K2 has no rider", body: "Waiting 18 minutes in Bemetara.", zone_id: Z1, entity_type: "order", entity_id: O1, opened_at: ago(18), last_seen_at: ago(1), reopen_count: 0, acknowledged_by: null, acknowledged_at: null, resolved_at: null, resolution: null, resolved_by: null },
    { id: AL2, kind: "cash_discrepancy", severity: "warning", status: "acknowledged", title: "Cash gap for Ravi", body: "Collected ₹1,900, deposited ₹1,700.", zone_id: Z1, entity_type: "cash_day", entity_id: `${R}:2026-10-20`, opened_at: ago(600), last_seen_at: ago(5), reopen_count: 1, acknowledged_by: M, acknowledged_at: ago(300), resolved_at: null, resolution: null, resolved_by: null },
    { id: AL3, kind: "settlement_delayed", severity: "info", status: "resolved", title: "Spice Hub payout is late", body: "Cycle ended 6 days ago.", zone_id: Z1, entity_type: "restaurant", entity_id: S1, opened_at: ago(2000), last_seen_at: ago(900), reopen_count: 0, acknowledged_by: M, acknowledged_at: ago(1900), resolved_at: ago(900), resolution: "Paid by bank transfer", resolved_by: A },
  ],
  ops_alert_events: [
    { alert_id: AL2, event: "opened", actor_id: null, note: null, created_at: ago(600) },
    { alert_id: AL2, event: "acknowledged", actor_id: M, note: null, created_at: ago(300) },
  ],
  ops_alert_rules: [
    { kind: "order_unassigned", zone_id: null, enabled: true, threshold: 5, window_minutes: null, updated_by: A, updated_at: ago(60 * 24 * 30) },
    { kind: "order_unassigned", zone_id: Z1, enabled: true, threshold: 8, window_minutes: null, updated_by: M, updated_at: ago(60 * 24) },
  ],
  ops_audit_log: [
    { id: 4021, actor_id: M, actor_role: "manager", action: "delivery.reassign", entity_type: "order", entity_id: O1, zone_id: Z1, reason: "Rider's phone went off", before: { rider: "Ravi", customer: { phone: "9876543210" } }, after: { rider: "Kiran" }, client_action_id: id(70), created_at: ago(40) },
    { id: 4020, actor_id: A, actor_role: "admin", action: "zone.create", entity_type: "zone", entity_id: Z1, zone_id: Z1, reason: null, before: null, after: { name: "Bemetara" }, client_action_id: null, created_at: ago(60 * 24) },
  ],
  user_notifications: [
    { id: id(50), user_id: M, category: "order_unassigned", title: "Order D7K2 has no rider", body: "Waiting 18 minutes in Bemetara.", data: { kind: "order_unassigned", orderId: O1, url: `/alerts/${AL1}`, alertId: AL1 }, read_at: null, created_at: ago(18) },
    { id: id(51), user_id: M, category: "ticket_activity", title: "Ticket #101 assigned to you", body: "Rider did not arrive", data: { url: `/more/tickets/${T1}`, ticketId: T1 }, read_at: ago(50), created_at: ago(58) },
  ],
};

const rpcs: Record<string, unknown> = {
  ops_ticket_metrics: {
    created: 14, resolved: 9, reopened: 1, openOverSla: 2,
    firstResponse: { avgMinutes: 22, medianMinutes: 15, count: 11 },
    resolution: { avgMinutes: 310, medianMinutes: 240, count: 9 },
    byStatus: { open: 3, in_progress: 2, waiting_on_requester: 1, escalated: 1, resolved: 6, closed: 3 },
    byPriority: { normal: 10, high: 3, emergency: 1 },
    byRequesterRole: { customer: 8, vendor: 3, rider: 3 },
    recurring: {
      categories: [{ key: "delivery_issue", count: 6, share: 0.43 }],
      vendors: [{ id: S1, count: 4, share: 0.29 }],
      riders: [{ id: R, count: 3, share: 0.21 }],
      zones: [{ id: Z1, count: 14, share: 1 }],
      orders: [{ id: O1, count: 2 }],
    },
    daily: [{ date: "2026-10-20", created: 5, resolved: 3 }, { date: "2026-10-21", created: 2, resolved: 1 }],
  },
};

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset", "or", "and"].includes(key) || key.includes(".")) continue;
    const negate = raw.startsWith("not.");
    const spec = negate ? raw.slice(4) : raw;
    const dot = spec.indexOf(".");
    const op = spec.slice(0, dot);
    const arg = spec.slice(dot + 1);
    const value = row[key];
    const list = () => arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
    let hit = true;
    if (op === "eq") hit = String(value) === arg;
    else if (op === "neq") hit = String(value) !== arg;
    else if (op === "in") hit = list().includes(String(value));
    else if (op === "is") hit = arg === "null" ? value == null : String(value) === arg;
    else if (op === "gte") hit = value != null && String(value) >= arg;
    else if (op === "lt") hit = value != null && String(value) < arg;
    if (negate ? hit : !hit) return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const send = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(req.method === "HEAD" ? "" : JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/storage/v1/object/sign/")) {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { paths?: string[] };
      const bucket = url.pathname.slice("/storage/v1/object/sign/".length);
      return send(200, (body.paths ?? []).map((p) => ({ path: p, signedURL: `/object/sign/${bucket}/${p}?token=t`, error: null })));
    }
    const path = url.pathname.replace("/rest/v1/", "");
    if (path.startsWith("rpc/")) return send(200, rpcs[path.slice(4)] ?? []);
    let rows = (tables[path] ?? []).filter((r) => matches(r, url));
    // The one `or` the ticket queue and alert lists send that matters here: urgent leads, the rest follow (callers re-filter).
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 1000;
    rows = rows.slice(offset, offset + limit);
    const total = (tables[path] ?? []).filter((r) => matches(r, url)).length;
    const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
    if (single) return rows.length ? send(200, rows[0]) : send(406, { code: "PGRST116", message: "no rows" });
    send(200, rows, { "content-range": `${offset}-${offset + rows.length - 1}/${total}` });
  });
});

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const tk = await import("../../src/lib/data-access/manager-tickets");
  const al = await import("../../src/lib/data-access/manager-alerts");
  const inbox = await import("../../src/lib/data-access/manager-inbox");
  const audit = await import("../../src/lib/data-access/manager-audit");
  const { parseTicketQuery, TEAMS } = await import("../../src/lib/ops/support-contract");
  const { parseAlertQuery, parseAuditQuery } = await import("../../src/lib/ops/alerts-contract");
  const { AUDIT_ACTIONS } = await import("../../src/lib/ops/audit-catalog");

  const scope = { all: false as const, zoneIds: [Z1] };
  const actor = { id: M, role: "manager" as const };
  const viewer = {
    admin: false,
    permissions: { "manager.finance.view": true, "manager.marketing.manage": true, "manager.support.manage": true } as Record<string, boolean>,
  };
  const ok = <T,>(q: T | { error: string }): T => {
    if (q && typeof q === "object" && "error" in q) throw new Error(`query refused: ${JSON.stringify(q)}`);
    return q as T;
  };
  const sp = (s = "") => new URLSearchParams(s);

  const ticketsList = await tk.listTickets(scope, actor, ok(parseTicketQuery(sp())), NOW);
  const ticketsPage2 = await tk.listTickets(scope, actor, { ...ok(parseTicketQuery(sp())), cursor: { at: ago(200), id: id(999) } }, NOW);
  const files: Record<string, unknown> = {
    tickets_list: ticketsList,
    tickets_list_page2: ticketsPage2,
    ticket_thread_v2: await tk.getTicketThread(scope, T1),
    ticket_thread_resolved: await tk.getTicketThread(scope, T3),
    ticket_metrics: await tk.ticketMetrics(scope, { from: "2026-09-22", to: "2026-10-21" }, null),
    assignees: { staff: await tk.listAssignees(scope, null), teams: TEAMS },
    alerts_list: await al.listAlerts(scope, viewer, ok(parseAlertQuery(sp("status=open,acknowledged,resolved"))), NOW),
    alert_detail: await al.getAlert(scope, viewer, AL2),
    alert_rules: { rules: await al.listRules(Z1) },
    inbox: await inbox.listInbox(M, { cursor: null, unreadOnly: false, limit: 30 }),
    unread_count: await inbox.unreadSummary(M, scope, viewer, NOW),
    audit_list: await audit.listAudit(scope, ok(parseAuditQuery(sp()))),
    audit_entry: await audit.getAuditEntry(scope, 4021),
    audit_actions: { actions: AUDIT_ACTIONS.map(({ code, label, group }) => ({ code, label, group })) },
  };

  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  for (const [name, body] of Object.entries(files)) if (body === null || body === undefined) fail(`${name}: the reader returned nothing for seeded rows`);

  const list = files.tickets_list as { items: { id: string }[]; counts: unknown };
  if (!list.items.some((t) => t.id === T2)) fail("the escalated emergency leads the queue");
  if (new Set(list.items.map((t) => t.id)).size !== list.items.length) fail("a ticket appears once in the queue");
  if ((files.tickets_list_page2 as { counts: unknown }).counts !== null) fail("counts are null after page one");
  const thread = files.ticket_thread_v2 as { ticket: Record<string, unknown>; events: unknown[]; messages: { internal: boolean; attachments: { url: string }[] }[] } | null;
  for (const k of ["requester", "assignee", "team", "allowedTransitions"]) if (thread && !(k in thread.ticket)) fail(`the staff thread carries ticket.${k}`);
  if (thread && thread.events.length === 0) fail("the staff thread carries its history");
  if (thread && !thread.messages.some((m) => m.internal)) fail("the staff thread shows internal notes to staff");
  if (thread && !thread.messages.some((m) => m.attachments.length > 0)) fail("an attachment carries a signed url");
  const alerts = files.alerts_list as { items: { entity: { type: string } }[] };
  if (!alerts.items.some((a) => a.entity.type === "cash_day")) fail("a cash alert is keyed cash_day");
  const entry = files.audit_entry as { entry: { id: unknown; before: unknown }; diff: unknown[] } | null;
  if (typeof entry?.entry.id !== "number") fail("the audit id is a number");
  if (JSON.stringify(entry?.entry.before).includes("9876543210")) fail("the audit entry redacts a phone number");
  const blob = JSON.stringify(files);
  if (/[ऀ-ॿ]/.test(blob) || blob.includes("labelHi")) fail("no Hindi in any Phase 8 answer");

  const out = join(process.cwd(), "apps/manager/test/fixtures/api/generated/phase8");
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, `${name}.json`), JSON.stringify(body, null, 2) + "\n");
  server.close();

  if (failures.length) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    console.log(`\nphase 8 contract: ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`phase 8 contract: wrote ${Object.keys(files).length} answers to ${out}`);
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
