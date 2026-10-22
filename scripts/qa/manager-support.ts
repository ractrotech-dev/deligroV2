/**
 * QA — the manager support queue (Phase 8, §11).
 *
 * The query and body parsers, the transition table matching 0165's SQL, the
 * attachment check (type, size, first bytes), the urgent-first rule, the RPC
 * error map, and the structure of the routes and data layer: every route
 * behind `manager.support.manage`, every write an `ops_*` RPC, the requester
 * never told about an internal note, a priority rise raising its alert. With
 * a dev server up, every route refuses an anonymous caller.
 *
 * Usage: npx tsx scripts/qa/manager-support.ts   (BASE=http://localhost:3005 for the live half)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  TICKET_TRANSITIONS,
  checkAttachment,
  decodeCursor,
  encodeCursor,
  isUrgent,
  mapSupportRpcError,
  parseAssignBody,
  parseEscalateBody,
  parsePriorityBody,
  parseStatusBody,
  parseTicketQuery,
} from "../../src/lib/ops/support-contract";

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
const CID = "3f1c6a52-7d7f-4f0e-9d8c-2a1f0b6c9e11";
const U = "11111111-2222-4333-8444-555555555555";
const q = (s: string) => parseTicketQuery(new URLSearchParams(s));
const err = (s: string) => {
  const r = q(s);
  return "error" in r ? r.field : null;
};

console.log("\n── query ──");
const all = q("status=active");
check("`active` expands to the four open statuses",
  !("error" in all) && JSON.stringify(all.statuses?.sort()) === JSON.stringify(["escalated", "in_progress", "open", "waiting_on_requester"]));
check("a bad status → field status", err("status=pending") === "status");
check("a bad priority → field priority", err("priority=urgent") === "priority");
check("a bad requester role → field requesterRole", err("requesterRole=vendor") === "requesterRole");
const roles = q("requesterRole=restaurant,driver");
check("contract roles map to stored ones", !("error" in roles) && JSON.stringify(roles.requesterRoles) === JSON.stringify(["vendor", "restaurant", "rider", "driver"]));
check("a bad zone id → field zone", err("zone=abc") === "zone");
check("a bad assignee → field assignee", err("assignee=everyone") === "assignee");
const me = q("assignee=me");
check("assignee=me is kept for the route to resolve", !("error" in me) && me.assignee === "me");
check("a bad team → field team", err("team=marketing") === "team");
check("from after to → field from", err("from=2026-10-10&to=2026-10-01") === "from");
check("limit 101 → field limit", err("limit=101") === "limit");
check("limit 0 → field limit", err("limit=0") === "limit");
check("a garbled cursor → field cursor", err("cursor=zzz") === "cursor");
const c = encodeCursor({ at: "2026-10-22T08:00:00.000Z", id: U });
check("a cursor round-trips", JSON.stringify(decodeCursor(c)) === JSON.stringify({ at: "2026-10-22T08:00:00.000Z", id: U }));
const num = q("q=%2341");
check("#41 searches the ticket number", !("error" in num) && num.q?.kind === "number" && num.q.value === 41);
check("two letters are too short to search", err("q=ab") === "q");

console.log("\n── bodies ──");
check("assign: a bad assignee id", !parseAssignBody({ assigneeId: "x", clientActionId: CID }).ok);
check("assign: unassign with null", parseAssignBody({ assigneeId: null, team: null, clientActionId: CID }).ok);
check("assign: an unknown team", !parseAssignBody({ assigneeId: null, team: "sales", clientActionId: CID }).ok);
const pr = parsePriorityBody({ priority: "high", clientActionId: CID });
check("priority: a reason is required", !pr.ok && pr.error === "reason_required");
check("priority: emergency with a reason", parsePriorityBody({ priority: "emergency", reason: "Rider hurt", clientActionId: CID }).ok);
check("escalate: a reason is required", !parseEscalateBody({ clientActionId: CID }).ok);
const st = parseStatusBody({ status: "resolved", clientActionId: CID });
check("status: resolving needs a resolution", !st.ok && st.error === "reason_required");
const cl = parseStatusBody({ status: "closed", clientActionId: CID });
check("status: closing may reuse the resolution", cl.ok && cl.value.resolution === null);
const ro = parseStatusBody({ status: "in_progress", reason: "Customer wrote back", clientActionId: CID });
check("status: a reopen reason travels", ro.ok && ro.value.reason === "Customer wrote back");
check("status: escalated is not a plain move", !parseStatusBody({ status: "escalated", clientActionId: CID }).ok);
check("every body needs a client action id", !parseEscalateBody({ reason: "abc" }).ok && !parseAssignBody({ assigneeId: null }).ok);

console.log("\n── transitions match 0165 ──");
const sql = readFileSync("supabase/migrations/0165_support_ops.sql", "utf8");
for (const [from, to] of Object.entries(TICKET_TRANSITIONS)) {
  const m = new RegExp(`when '${from}'\\s+then array\\[([^\\]]*)\\]`).exec(sql);
  const sqlTo = m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : from === "closed" ? [] : null;
  check(`${from} → ${to.join(", ") || "(final)"}`, JSON.stringify(sqlTo) === JSON.stringify([...to]), JSON.stringify(sqlTo));
}

console.log("\n── attachments ──");
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = new TextEncoder().encode("%PDF-1.7 rest");
const html = new TextEncoder().encode("<html><body>");
check("a JPEG passes", checkAttachment({ type: "image/jpeg", size: 1000 }, jpeg).ok);
check("a PNG passes", checkAttachment({ type: "image/png", size: 1000 }, png).ok);
check("a PDF passes, as .pdf", (() => { const r = checkAttachment({ type: "application/pdf", size: 1000 }, pdf); return r.ok && r.ext === "pdf"; })());
check("text/html is refused", !checkAttachment({ type: "text/html", size: 100 }, html).ok);
check("HTML labelled as JPEG is refused by its bytes", !checkAttachment({ type: "image/jpeg", size: 100 }, html).ok);
check("6 MB is refused", !checkAttachment({ type: "image/jpeg", size: 6 * 1024 * 1024 }, jpeg).ok);
check("an empty file is refused", !checkAttachment({ type: "image/jpeg", size: 0 }, jpeg).ok);

console.log("\n── ordering and errors ──");
check("escalated and emergency are urgent", isUrgent({ status: "escalated", priority: "normal" }) && isUrgent({ status: "open", priority: "emergency" }));
check("high is not urgent by itself", !isUrgent({ status: "open", priority: "high" }));
const it = mapSupportRpcError({ message: "invalid_transition", details: "closed,in_progress" });
check("invalid_transition carries the allowed moves", !it.ok && it.status === 409 && JSON.stringify(it.extra?.allowed) === JSON.stringify(["closed", "in_progress"]));
const ai = mapSupportRpcError({ message: "assignee_ineligible" });
check("assignee_ineligible → 409", !ai.ok && ai.status === 409);
const ml = mapSupportRpcError({ message: "max_level" });
check("max_level → 409", !ml.ok && ml.status === 409 && ml.error === "max_level");
const fb = mapSupportRpcError({ message: "forbidden", code: "42501" });
check("another zone's ticket → 404", !fb.ok && fb.status === 404);

console.log("\n── structure ──");
const routeFiles: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f === "route.ts") routeFiles.push(p);
  }
};
walk("src/app/api/manager/tickets");
check("nine ticket routes", routeFiles.length === 9, String(routeFiles.length));
for (const f of routeFiles) {
  const src = readFileSync(f, "utf8");
  check(`${f.replace(/\\/g, "/")} opens with managerApiContext("manager.support.manage")`, /managerApiContext\("manager\.support\.manage"\)/.test(src));
  if (/export async function POST/.test(src)) check(`${f.replace(/\\/g, "/")} is rate-limited`, /managerWriteLimit\(/.test(src));
}
const data = readFileSync("src/lib/data-access/manager-tickets.ts", "utf8");
check("the data layer never writes ticket tables directly",
  !/\.from\("support_(tickets|messages|ticket_events)"\)\s*\.(insert|update|upsert|delete)/.test(data));
for (const rpc of ["ops_add_ticket_message", "ops_set_ticket_status", "ops_assign_ticket", "ops_set_ticket_priority", "ops_escalate_ticket", "ops_ticket_metrics"]) {
  check(`calls ${rpc}`, data.includes(`"${rpc}"`));
}
check("the requester is told about public replies only", /if \(!replayedOf\(data\) && !internal\) tellRequester/.test(data));
check("a priority or escalation raises its alert at once", /raiseEventAlert\(/.test(data));
check("side effects are skipped on a replay", (data.match(/replayedOf\(data\)/g) ?? []).length >= 4);

async function live() {
  const base = process.env.BASE ?? "http://localhost:3005";
  const reachable = await fetch(`${base}/api/manager/tickets`, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
  if (!reachable) {
    console.log(`\nSKIP dev server unreachable at ${base} (live checks)`);
  } else {
    console.log("\n── live: anonymous callers ──");
    for (const [method, path] of [
      ["GET", "/api/manager/tickets"], ["GET", "/api/manager/tickets/assignees"], ["GET", "/api/manager/tickets/metrics"],
      ["GET", `/api/manager/tickets/${U}`], ["POST", `/api/manager/tickets/${U}/assign`], ["POST", `/api/manager/tickets/${U}/priority`],
      ["POST", `/api/manager/tickets/${U}/escalate`], ["POST", `/api/manager/tickets/${U}/messages`], ["POST", `/api/manager/tickets/${U}/status`],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      check(`${method} ${path} → 401`, res.status === 401, String(res.status));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
