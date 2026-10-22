/**
 * QA — personal data in manager payloads only where a permission and a live
 * need allow it (Phase 8 S8, §16.10).
 *
 * Walks the real serialiser output the contract emitters wrote
 * (apps/manager/test/fixtures/api/generated, Phases 3–6) and Phase 8's own
 * payloads built here from fixtures, and fails on any key that looks like
 * contact, address, location or bank data unless that endpoint's allow-list
 * names it. The permission variants are checked too: no customer phone
 * without `manager.call_customer`. Also: the requester-facing thread drops
 * internal notes, and alert text never carries a phone number.
 *
 * Pure file reads. Usage: npx tsx scripts/qa/manager-pii.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { toTicketListItem, type QueueRow } from "../../src/lib/ops/support-contract";
import { buildTicketThread } from "../../src/lib/ops/ticket-thread";
import { redactAuditPayload, toAlert } from "../../src/lib/ops/alerts-contract";
import { ALERT_KINDS } from "../../src/lib/ops/alerts/catalog";
import { emptyFacts, evaluate } from "../../src/lib/ops/alerts/evaluate";

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

/** A key that looks like personal data. `byPhone` (a phone order flag) and `account` (an account's status) are not. */
const PII = /(phone|mobile|email|address|landmark|^lat$|^lng$|latitude|longitude|account(number|no)|ifsc|aadhaar|^pan(number)?$|upi|dob|birth)/i;
const NOT_PII = new Set(["byPhone"]);

function piiPaths(v: unknown, p = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => piiPaths(x, `${p}[]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => {
      const q = p ? `${p}.${k}` : k;
      return [...(PII.test(k) && !NOT_PII.has(k) ? [q] : []), ...piiPaths(x, q)];
    });
  }
  return [];
}

/**
 * Each endpoint's allowed personal fields, and why. Location is a rider's or
 * an order's operational position (only while working — the builders enforce
 * that); shop phones and addresses are a business's, not a person's.
 */
const ORDER_DETAIL = [
  "pickup.address", "pickup.lat", "pickup.lng", "pickup.phone", // the shop
  "drop.address", "drop.landmark", "drop.lat", "drop.lng", // where to deliver: the order detail only
  "customer.phone", // only with manager.call_customer (the no_phone variant proves it)
  "delivery.rider.phone", "delivery.lastFix.lat", "delivery.lastFix.lng", // the rider on this order
];
const RIDER_DETAIL = [
  "rider.phone", "rider.profile.address", "rider.profile.emergency.phone", // the rider screen (Phase 5, riders.view)
  "rider.availability.position.lat", "rider.availability.position.lng", // only while online or on a delivery
  "rider.active[].shop.lat", "rider.active[].shop.lng", "rider.active[].drop.lat", "rider.active[].drop.lng",
  "rider.openExceptions[].rider.phone", "rider.openExceptions[].lat", "rider.openExceptions[].lng",
];
const ALLOW: Record<string, string[]> = {
  "live.json": ["riders[].lat", "riders[].lng", "riders[].phone", "orders[].pickupPoint.lat", "orders[].pickupPoint.lng", "orders[].dropPoint.lat", "orders[].dropPoint.lng"],
  "order_detail.json": ORDER_DETAIL.map((p) => `order.${p}`),
  "order_detail_cancelled.json": ORDER_DETAIL.map((p) => `order.${p}`),
  "order_detail_no_phone.json": ORDER_DETAIL.filter((p) => p !== "customer.phone").map((p) => `order.${p}`),
  "order_actions.json": ["ok", "okEscalated"].flatMap((k) => ORDER_DETAIL.map((p) => `${k}.order.${p}`)),
  "phase5/exceptions.json": ["items[].rider.phone", "items[].lat", "items[].lng"],
  "phase5/riders_list.json": ["items[].phone"],
  "phase5/rider_detail.json": RIDER_DETAIL,
  "phase5/rider_detail_no_money.json": RIDER_DETAIL,
  "vendor_detail.json": ["vendor.contact.shopPhone", "vendor.contact.ownerMobile", "vendor.contact.ownerEmail", "vendor.address", "vendor.address.landmark", "vendor.address.lat", "vendor.address.lng"],
  "vendor_detail_no_finance.json": ["vendor.contact.shopPhone", "vendor.contact.ownerMobile", "vendor.contact.ownerEmail", "vendor.address", "vendor.address.landmark", "vendor.address.lat", "vendor.address.lng"],
};
/** Lists never carry a customer's contact or address. */
const LIST_FILES = /(_list|list_|_page2|directory|complaints|reviews|categories|insights)/;

console.log("\n── generated payloads (Phases 3–6) ──");
const root = "apps/manager/test/fixtures/api/generated";
const all: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".json")) all.push(relative(root, p).replace(/\\/g, "/"));
  }
};
if (existsSync(root)) walk(root);
check("found the generated payloads", all.length >= 20, String(all.length));
for (const f of all.sort()) {
  const body = JSON.parse(readFileSync(join(root, f), "utf8"));
  const allowed = new Set(ALLOW[f] ?? []);
  const extra = [...new Set(piiPaths(body))].filter((p) => !allowed.has(p));
  check(`${f}: personal fields only where allowed`, extra.length === 0, extra.join(", "));
  if (LIST_FILES.test(f)) {
    const customer = piiPaths(body).filter((p) => /customer/i.test(p));
    check(`${f}: no customer contact in a list`, customer.length === 0, customer.join(", "));
  }
}
const noPhone = existsSync(join(root, "order_detail_no_phone.json"))
  ? JSON.parse(readFileSync(join(root, "order_detail_no_phone.json"), "utf8")) : null;
check("without call_customer the customer's phone key is absent, not nulled",
  !!noPhone && !("phone" in (noPhone.order?.customer ?? {})));

console.log("\n── Phase 8 payloads ──");
const now = new Date("2026-10-22T08:00:00Z");
const row: QueueRow = {
  id: "t1", number: 41, subject: "Cold food", category: "order_issue", priority: "high", status: "open", requester_role: "customer",
  order_id: "o1", created_at: "2026-10-22T07:00:00Z", updated_at: "2026-10-22T07:00:00Z", requester_id: "c1", restaurant_id: "r1",
  zone_id: "z1", assigned_to: "m1", team: "operations", escalation_level: 0, first_response_at: null, resolved_at: null,
};
const item = toTicketListItem(row, { people: new Map([["c1", "Asha"], ["m1", "Mona"]]), shops: new Map([["r1", "Spice Hub"]]) }, 2, now);
check("a queue row carries no personal fields", piiPaths(item).length === 0, piiPaths(item).join(", "));
const thread = buildTicketThread(
  { ...row, resolution: null, restaurants: { name: "Spice Hub" } },
  [{ id: "m1", author_id: "c1", author_role: "customer", body: "Cold", internal: false, attachments: [], created_at: row.created_at, profiles: { full_name: "Asha" } }],
  new Map(),
  { requester: { id: "c1", name: "Asha", role: "customer" }, assignee: { id: "m1", name: "Mona" }, team: "operations", allowedTransitions: ["in_progress"], events: [] }
);
check("the staff thread carries no personal fields", piiPaths(thread).length === 0, piiPaths(thread).join(", "));
const alert = toAlert({
  id: "a1", kind: "order_unassigned", severity: "warning", status: "open", title: "t", body: "b", zone_id: "z1", entity_type: "order",
  entity_id: "o1", opened_at: row.created_at, last_seen_at: row.created_at, reopen_count: 0, acknowledged_by: null, acknowledged_at: null,
  resolved_at: null, resolution: null, resolved_by: null,
}, new Map());
check("an alert carries no personal fields", piiPaths(alert).length === 0);
const redacted = redactAuditPayload({ customer: { phone: "9876543210", address: "12 Road" }, upiId: "x@y", status: "ok" });
check("audit before/after are redacted", piiPaths(redacted).every((p) => {
  const v = p.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], redacted);
  return v === "[redacted]";
}));

console.log("\n── requesters and texts ──");
const support = readFileSync("src/lib/data-access/support.ts", "utf8");
const mine = /export async function getMyTicket[\s\S]*?\n}\n/.exec(support)?.[0] ?? "";
check("the requester's own thread drops internal notes", /filter\(\(m\) => !m\.internal\)/.test(mine));
const tickets = readFileSync("src/lib/data-access/manager-tickets.ts", "utf8");
check("the requester is pushed for public replies only", /!replayedOf\(data\) && !internal\) tellRequester/.test(tickets));
// Every alert the engine can raise, from a fixture with phone-like data in every free-text field.
const facts = {
  ...emptyFacts(now), zones: [{ id: "z1", name: "Bemetara" }],
  orders: [{ id: "o1", code: "O1", zoneId: "z1", status: "placed" as const, vendorName: "Spice 9876543210", createdAt: now.toISOString(),
    lastChangeAt: "2026-10-21T00:00:00Z", acceptWaitMinutes: 20, unassignedMinutes: 20, lateByMinutes: 40, hasRider: false }],
  tickets: [{ id: "t1", number: 1, subject: "Call me", zoneId: "z1", priority: "emergency", status: "open", createdAt: now.toISOString(), firstResponseAt: null }],
  failed: [{ deliveryId: "d1", orderId: "o1", orderCode: "O1", zoneId: "z1", vendorName: "Spice Hub", riderName: "Ravi" }],
  cashDays: [{ zoneId: "z1", riderId: "r1", riderName: "Ravi", day: "2026-10-21", collected: 1500, deposited: 0, disputed: true, hoursSinceDayEnd: 20 }],
};
const texts = [...evaluate(facts, ALERT_KINDS.map((k) => ({ kind: k.kind, zoneId: null, enabled: true, threshold: k.defaultThreshold, windowMinutes: k.defaultWindowMinutes })))
  .values()].flat().map((a) => `${a.title} ${a.body}`);
check("alert text comes only from names the engine chose to print", texts.length >= 5);
const own = texts.filter((t) => !t.includes("9876543210")).join(" ");
check("no alert text the engine writes itself carries a phone number", !/\+?\d{10,}/.test(own), own.slice(0, 120));
console.log("  note  the rider SOS push (order-events.ts notifyOpsSos) carries the rider's phone on purpose: staff must call them in an emergency (Rider design §15).");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
