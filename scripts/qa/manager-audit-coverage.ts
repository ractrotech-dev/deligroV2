/**
 * QA — every sensitive manager action is provably logged, atomically, behind
 * its permission (Phase 8 S7, §16).
 *
 *   1. Catalog ↔ SQL. Every action code an RPC passes to `_ops_log` in
 *      migrations 0141–0199 (literals, `'prefix.' || p_x` with its known
 *      suffixes, CASE branches) is in AUDIT_ACTIONS, and every catalog code is
 *      written by some migration.
 *   2. Writes → RPCs. No manager write route, manager data-access module or
 *      web /manager action writes a business table directly; the few non-audited
 *      writes are named below with their reason.
 *   3. Writes → permissions. Each write route opens with the pinned switch, the
 *      per-action permission maps equal the design's, and the default-off
 *      switches are exactly the design's sensitive ones.
 *
 * Pure file reads. Usage: npx tsx scripts/qa/manager-audit-coverage.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ACTIONS } from "../../src/lib/ops/audit-catalog";
import { ACTION_PERMISSION } from "../../src/lib/ops/order-actions";
import { PRODUCT_ACTION_PERMISSION } from "../../src/lib/ops/product-actions";
import { RIDER_ACTION_PERMISSION } from "../../src/lib/ops/rider-actions";
import { VENDOR_ACTION_PERMISSION } from "../../src/lib/ops/vendor-actions";
import { FEATURES } from "../../src/lib/features/catalog";

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

const files = (dir: string, test: (f: string) => boolean): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (test(p)) out.push(p.replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return out.sort();
};

// ── 1. catalog ↔ SQL ────────────────────────────────────────────────────────
console.log("\n── 1. every logged action is in the catalog, and back ──");

/** The values a concatenated action's variable can take (each checked by its RPC). */
const SUFFIXES: Record<string, string[]> = {
  "vendor.": ["approve", "reject", "suspend", "reactivate"],
  "vendor.document.": ["verified", "rejected"],
  "product.": ["approve", "reject"],
  "product.flag.": ["resolved", "dismissed"],
  "rider.": ["verify", "reject", "suspend", "reactivate", "force_offline"],
  "rider.document.": ["verify", "reject"],
  "cash.deposit.": ["confirm", "dispute"],
  "delivery.exception.": ["approve", "reject"],
  "refund.": ["approve", "deny"],
  "campaign.": ["cancel", "end_now"],
  "offer.": ["activate", "deactivate"],
  "customer.": ["suspend", "restrict", "reactivate"],
};

/** Top-level comma split of a call's argument list. */
function args(src: string, open: number): { list: string[]; end: number } {
  const list: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === "'") quote = src[i + 1] === "'" ? (cur += src[++i], true) : false;
      continue;
    }
    if (c === "'") { quote = true; cur += c; continue; }
    if (c === "(") { depth++; if (depth === 1) continue; }
    if (c === ")") { depth--; if (depth === 0) { list.push(cur.trim()); return { list, end: i }; } }
    if (c === "," && depth === 1) { list.push(cur.trim()); cur = ""; continue; }
    if (depth >= 1) cur += c;
  }
  return { list, end: src.length };
}

const migrations = readdirSync("supabase/migrations").filter((f) => /^01[4-9]\d_.*\.sql$/.test(f)).sort();
const logged = new Set<string>();
const unresolved: string[] = [];
for (const f of migrations) {
  // Strip comments so a rollback note or prose never counts as a call.
  const sql = readFileSync(`supabase/migrations/${f}`, "utf8").replace(/--[^\n]*/g, "");
  let at = 0;
  for (;;) {
    const i = sql.indexOf("_ops_log(", at);
    if (i < 0) break;
    at = i + 1;
    const before = sql.slice(Math.max(0, i - 20), i);
    if (/function\s+public\.$/.test(before) || /function public\.$/.test(before) || /on function public\.$/.test(before)) continue;
    const { list } = args(sql, i + "_ops_log".length);
    if (list.length < 9) continue; // a signature, not a call
    const action = list[1];
    // log_ops_action() (0141) passes on the code the server gives it: those
    // codes are collected from its TypeScript callers below.
    if (action === "p_action" && f.startsWith("0141_")) continue;
    const literal = /^'([a-z_.]+)'$/.exec(action);
    const concat = /^'([a-z_.]+\.)'\s*\|\|/.exec(action);
    if (literal) logged.add(literal[1]);
    else if (concat && SUFFIXES[concat[1]]) SUFFIXES[concat[1]].forEach((s) => logged.add(concat[1] + s));
    else if (/^case\b/i.test(action)) [...action.matchAll(/'([a-z_]+\.[a-z_.]+)'/g)].forEach((m) => logged.add(m[1]));
    else unresolved.push(`${f}: ${action.slice(0, 80)}`);
  }
}
for (const f of files("src", (p) => /\.tsx?$/.test(p))) {
  const src = readFileSync(f, "utf8");
  if (!src.includes("logOpsAction(")) continue;
  for (const m of src.matchAll(/logOpsAction\(\{[^}]*action:\s*"([a-z_.]+)"/g)) logged.add(m[1]);
}
check("every _ops_log action argument resolves to codes", unresolved.length === 0, unresolved.join(" | "));
const catalog = new Set(AUDIT_ACTIONS.map((a) => a.code));
const missing = [...logged].filter((c) => !catalog.has(c)).sort();
const unused = [...catalog].filter((c) => !logged.has(c)).sort();
check(`every logged code (${logged.size}) is in the catalog`, missing.length === 0, missing.join(", "));
check("every catalog code is written by a migration", unused.length === 0, unused.join(", "));
// The floor the design's audit list sets (§16, Audit log section).
const REQUIRED = [
  "order.advance", "order.cancel", "order.correct.status", "order.note", "order.escalate", "delivery.assign", "delivery.reassign",
  "vendor.suspend", "vendor.document.verified", "vendor.onboard", "product.flag", "product.hide", "product.approve", "product.stock",
  "rider.suspend", "rider.document.verify", "rider.onboard", "rider.adjustment", "payment.request", "payment.approve",
  "settlement.void", "refund.approve", "cash.deposit.confirm", "cash.dispute.resolve", "delivery.exception.approve",
  "ticket.assign", "ticket.escalate", "ticket.status", "alert.resolve", "alert_rule.set", "zone.create", "staff.zones_set",
  "feature.switch_set", "session.revoke",
];
const floor = REQUIRED.filter((c) => !logged.has(c));
check("the design's audit list is covered", floor.length === 0, floor.join(", "));

// ── 2. writes go through RPCs ───────────────────────────────────────────────
console.log("\n── 2. no direct business-table writes on the manager side ──");

/** Writes that are deliberately not audited, and why. */
const ALLOWED: Record<string, { tables: string[]; why: string }> = {
  "src/app/api/manager/notification-prefs/route.ts": { tables: ["notification_preferences"], why: "a person's own push switches" },
  "src/lib/data-access/manager-inbox.ts": { tables: ["user_notifications"], why: "a person marking their own inbox read" },
};
const STATEMENT = /(?<!storage)\.from\("([a-z_]+)"\)[^;]*?\.(insert|update|upsert|delete)\(/gs;
const writers = [
  ...files("src/app/api/manager", (p) => p.endsWith("route.ts")),
  ...files("src/lib/data-access", (p) => /\/manager-[a-z-]+\.ts$/.test(p)),
  ...files("src/app/manager", (p) => /actions\.ts$/.test(p)),
];
for (const f of writers) {
  const src = readFileSync(f, "utf8");
  const hits = [...src.matchAll(STATEMENT)].map((m) => m[1]);
  const allowed = ALLOWED[f]?.tables ?? [];
  const bad = hits.filter((t) => !allowed.includes(t));
  check(`${f}: no direct writes`, bad.length === 0, [...new Set(bad)].join(", "));
}
// The admin support desk shares the manager's audited ticket RPCs: staffReply,
// setTicketStatus and assignTicketToSelf must hold no direct table write.
{
  const support = readFileSync("src/lib/data-access/support.ts", "utf8");
  const from = support.indexOf("export async function staffReply");
  const to = support.indexOf("// Partner app requester flow");
  const desk = support.slice(from, to);
  check("support desk: staff writes only through the audited ops_* RPCs", from > 0 && to > from && !/\.(insert|update|upsert|delete)\(/.test(desk));
  for (const rpc of ["ops_add_ticket_message", "ops_set_ticket_status", "ops_assign_ticket", "ops_escalate_ticket"]) {
    check(`support desk: uses ${rpc}`, support.includes(`"${rpc}"`));
  }
}

// 2b. The shared modules a manager decision reaches. Their direct writes are pinned: each one is a
// follow-up EFFECT of a decision whose own audit row was written by its RPC, or a draft/request that
// is not a record until an audited RPC acts on it. A new write here fails the check and has to be
// argued into this list (review #20: the gate used to look only at manager-*.ts).
console.log("\n── 2b. the money and exception modules: only the pinned follow-up writes ──");
type Writes = Record<string, number>;
const FOLLOW_UPS: Record<string, { writes: Writes; why: string }> = {
  "src/lib/data-access/refunds.ts": {
    writes: { "refunds:insert": 2 },
    why: "queueing a refund REQUEST (pending, not a decision). The decision, the order/payment 'refunded' flags and the settlement correction are all inside audited RPCs.",
  },
  "src/lib/data-access/admin-settlements.ts": {
    writes: {
      "vendor_settlements:insert": 1, "vendor_settlements:delete": 2, "vendor_settlements:update": 1,
      "vendor_settlement_orders:insert": 1, "settlement_corrections:update": 2,
    },
    why: "building and discarding a DRAFT settlement (not a record until ops_request_vendor_settlement / ops_decide_payment_request act on it, audited), flagging a draft for a refund, and applying/releasing corrections when a draft is built or voided. Marking paid, voiding paid and recording a correction are RPCs.",
  },
  "src/lib/data-access/delivery-exceptions.ts": {
    writes: { "delivery_events:insert": 1, "delivery_exceptions:insert": 1, "deliveries:update": 2 },
    why: "the effects of an APPROVED exception (fail the delivery, release it for go_offline): resumable per exception id (effect_failed -> retry), each delivery change recorded by the delivery_events trigger (0081) with the actor and reason; the rider's own request insert.",
  },
  "src/lib/data-access/payment-requests.ts": { writes: {}, why: "reads only; every change is an RPC" },
  "src/lib/data-access/settlement-requests.ts": { writes: {}, why: "every change is an RPC" },
  "src/lib/data-access/order-cancellation.ts": { writes: {}, why: "cancelling is one RPC (ops_cancel_order)" },
};
for (const [f, { writes, why }] of Object.entries(FOLLOW_UPS)) {
  const src = readFileSync(f, "utf8");
  const found: Writes = {};
  for (const m of src.matchAll(STATEMENT)) found[`${m[1]}:${m[2]}`] = (found[`${m[1]}:${m[2]}`] ?? 0) + 1;
  check(`${f}: exactly the pinned direct writes (${why.slice(0, 60)}…)`, JSON.stringify(Object.entries(found).sort()) === JSON.stringify(Object.entries(writes).sort()), JSON.stringify(found));
}
{
  const refunds = readFileSync("src/lib/data-access/refunds.ts", "utf8");
  check("refunds.ts no longer marks payments or orders refunded itself (the decision RPC does, with its audit row)",
    !/\.from\("payments"\)[^;]*\.update\(/s.test(refunds) && !/mirrorRefundOntoLedger/.test(refunds));
  const sql0156 = readFileSync("supabase/migrations/0156_settlement_requests_and_money_decisions.sql", "utf8");
  check("ops_decide_refund sets the refunded flags when the approved refunds reach the order total",
    /update public\.payments set status = 'refunded'/.test(sql0156) && /update public\.orders set payment_status = 'refunded'/.test(sql0156));
  const settlements = readFileSync("src/lib/data-access/admin-settlements.ts", "utf8");
  check("a settlement correction is recorded by ops_record_settlement_correction (insert + audit row together)",
    /rpc\("ops_record_settlement_correction"/.test(settlements) && !/\.from\("settlement_corrections"\)\.insert\(/.test(settlements));
}
// §16.4 / §16.5 — adjustments, offers and campaigns (Phase 7's actions are in the catalog and written by RPCs).
{
  const have = new Set(AUDIT_ACTIONS.map((a) => a.code));
  const need = [
    "rider.adjustment", "settlement.void", "settlement.reverse", "settlement.correction", "payment.request", "payment.approve",
    "offer.create", "offer.update", "offer.activate", "offer.deactivate",
    "campaign.create", "campaign.update", "campaign.cancel", "campaign.end_now",
  ];
  const missing = need.filter((c) => !have.has(c));
  check("§16.4 (commission / settlement adjustments) and §16.5 (offer and campaign changes) all have audit actions", missing.length === 0, missing.join(", "));
  const unwritten = need.filter((c) => !logged.has(c));
  check("...and each is written by a migration's RPC", unwritten.length === 0, unwritten.join(", "));
}

// ── 3. permissions ──────────────────────────────────────────────────────────
console.log("\n── 3. each write behind its switch ──");

/** Write route → the switch it opens with ("" = any manager; per-action checks are pinned below). */
const ROUTE_SWITCH: Record<string, string> = {
  "alert-rules/route.ts": "manager.alerts.configure",
  "alerts/[id]/actions/route.ts": "",
  "alerts/incident/route.ts": "",
  "customers/[id]/actions/route.ts": "manager.customers.view",
  "customers/[id]/contact/route.ts": "manager.customers.view",
  "marketing/campaigns/[id]/actions/route.ts": "manager.marketing.manage",
  "marketing/campaigns/[id]/image/route.ts": "manager.marketing.manage",
  "marketing/campaigns/[id]/route.ts": "manager.marketing.manage",
  "marketing/campaigns/route.ts": "manager.marketing.manage",
  "marketing/requests/[id]/decide/route.ts": "manager.marketing.manage",
  "marketing/requests/[id]/progress/route.ts": "manager.marketing.manage",
  "marketing/requests/route.ts": "manager.marketing.manage",
  "offers/[code]/actions/route.ts": "manager.offers.manage",
  "offers/[code]/route.ts": "manager.offers.manage",
  "offers/route.ts": "manager.offers.manage",
  "cash/deposits/[id]/decide/route.ts": "manager.cash",
  "cash/disputes/[id]/resolve/route.ts": "manager.cash",
  "exceptions/[id]/decide/route.ts": "manager.exceptions.decide",
  "finance/refunds/[id]/decide/route.ts": "manager.finance.view",
  "finance/settlements/route.ts": "manager.finance.view",
  "finance/settlements/[id]/reverse/route.ts": "manager.finance.view",
  "notification-prefs/route.ts": "",
  "notifications/read/route.ts": "",
  "orders/[id]/actions/route.ts": "",
  "password/route.ts": "",
  "payments/requests/[id]/decide/route.ts": "manager.finance.view",
  "payments/requests/route.ts": "manager.finance.view",
  "products/[id]/actions/route.ts": "manager.products.view",
  "products/[id]/photo/route.ts": "manager.products.view",
  "products/bulk/route.ts": "manager.products.view",
  "products/image-reviews/[changeId]/route.ts": "manager.products.moderate",
  "products/restricted-categories/route.ts": "manager.products.moderate",
  "riders/[id]/actions/route.ts": "manager.riders.view",
  "riders/[id]/documents/route.ts": "manager.riders.onboard",
  "riders/route.ts": "manager.riders.onboard",
  "sessions/route.ts": "",
  "tickets/[id]/assign/route.ts": "manager.support.manage",
  "tickets/[id]/escalate/route.ts": "manager.support.manage",
  "tickets/[id]/messages/route.ts": "manager.support.manage",
  "tickets/[id]/priority/route.ts": "manager.support.manage",
  "tickets/[id]/status/route.ts": "manager.support.manage",
  "vendors/[id]/actions/route.ts": "manager.vendors.view",
  "vendors/[id]/menu-sheet/route.ts": "manager.products.view",
  "vendors/[id]/documents/route.ts": "manager.vendors.onboard",
  "vendors/logo/route.ts": "manager.vendors.onboard",
  "vendors/route.ts": "manager.vendors.onboard",
  "weather/route.ts": "manager.weather.manage",
};
const writeRoutes = files("src/app/api/manager", (p) => p.endsWith("route.ts"))
  .filter((f) => /export async function (POST|PUT|PATCH|DELETE)/.test(readFileSync(f, "utf8")))
  .map((f) => f.replace("src/app/api/manager/", ""));
const unpinned = writeRoutes.filter((r) => !(r in ROUTE_SWITCH));
check("every manager write route is pinned here", unpinned.length === 0, unpinned.join(", "));
for (const r of writeRoutes.filter((x) => x in ROUTE_SWITCH)) {
  const src = readFileSync(`src/app/api/manager/${r}`, "utf8");
  // The handler(s) that write: their managerApiContext calls.
  const writes = [...src.matchAll(/export async function (POST|PUT|PATCH|DELETE)[\s\S]*?managerApiContext\(("([a-z_.]+)")?\)/g)].map((m) => m[3] ?? "");
  const want = ROUTE_SWITCH[r];
  check(`${r} opens its writes with ${want || "any manager"}`, writes.length > 0 && writes.every((k) => k === want), writes.join(", "));
}
const extra: [string, Record<string, string>, Record<string, string>][] = [
  ["order actions", ACTION_PERMISSION as Record<string, string>, {
    advance: "manager.move_status", cancel: "manager.move_status", assign: "manager.assign_rider", reassign: "manager.reassign_rider",
    escalate: "manager.orders.escalate", correct: "manager.orders.correct", note: "manager.orders.correct",
  }],
  ["vendor actions", VENDOR_ACTION_PERMISSION as Record<string, string>, {
    approve: "manager.vendors.status", reject: "manager.vendors.status", suspend: "manager.vendors.status", reactivate: "manager.vendors.status",
    verify_document: "manager.vendors.status", reject_document: "manager.vendors.status",
  }],
  ["product actions", PRODUCT_ACTION_PERMISSION as Record<string, string>, {
    flag: "manager.products.view", hide: "manager.products.moderate", unhide: "manager.products.moderate", approve: "manager.products.moderate",
    reject: "manager.products.moderate", resolve_flag: "manager.products.moderate", dismiss_flag: "manager.products.moderate",
    adjust_stock: "manager.products.adjust_stock",
  }],
  ["rider actions", RIDER_ACTION_PERMISSION as Record<string, string>, {
    approve: "manager.riders.status", reject: "manager.riders.status", suspend: "manager.riders.status", reactivate: "manager.riders.status",
    force_offline: "manager.riders.status", verify_document: "manager.riders.status", reject_document: "manager.riders.status",
    add_adjustment: "manager.finance.adjust",
  }],
];
for (const [name, actual, want] of extra) {
  const diff = Object.keys({ ...actual, ...want }).filter((k) => actual[k] !== want[k]);
  check(`${name}: each action's switch is the design's`, diff.length === 0, diff.map((k) => `${k}: ${actual[k]} ≠ ${want[k]}`).join("; "));
}
for (const [route, keys] of [
  ["payments/requests/route.ts", ["manager.finance.initiate_payment"]],
  ["payments/requests/[id]/decide/route.ts", ["manager.finance.approve_payment"]],
  ["finance/settlements/route.ts", ["manager.finance.initiate_payment"]],
  ["finance/refunds/[id]/decide/route.ts", ["manager.finance.adjust"]],
  ["customers/[id]/actions/route.ts", ["manager.customers.suspend"]],
  ["customers/[id]/contact/route.ts", ["manager.customers.contact"]],
  ["products/bulk/route.ts", ["manager.products.adjust_stock"]],
  ["products/[id]/photo/route.ts", ["manager.products.replace_photo"]],
  ["vendors/[id]/menu-sheet/route.ts", ["manager.products.bulk_menu", "manager.products.adjust_stock"]],
] as const) {
  const src = readFileSync(`src/app/api/manager/${route}`, "utf8");
  check(`${route} also checks ${keys.join(", ")}`, keys.every((k) => src.includes(`"${k}"`)));
}
const SENSITIVE = [
  "manager.orders.correct", "manager.vendors.onboard", "manager.riders.onboard", "manager.finance.initiate_payment",
  "manager.finance.approve_payment", "manager.finance.adjust", "manager.customers.contact", "manager.customers.suspend",
  "manager.products.adjust_stock", "manager.audit.view_zone",
  // 0176: a manager writing a shop's menu or its photos.
  "manager.products.bulk_menu", "manager.products.replace_photo",
];
const off = FEATURES.filter((f) => (f as { defaultOn?: boolean }).defaultOn === false).map((f) => f.key).sort();
check("the default-off switches are exactly the design's sensitive ones", JSON.stringify(off) === JSON.stringify([...SENSITIVE].sort()), off.join(", "));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
