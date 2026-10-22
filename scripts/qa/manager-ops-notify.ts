/**
 * QA — who on the operations side hears about something (Phase 8, §14, §15.7).
 *
 * Every admin; the managers holding the zone (all managers only for a
 * platform-wide incident); a permission narrows managers further; a muted kind
 * still writes the inbox row but sends no push, except incidents, critical
 * complaints and forced rings. Structural: the old zone-blind staff query is
 * gone from order-events.ts, and staff copy carries no Hindi.
 *
 * Pure + file reads, no I/O. Usage: npx tsx scripts/qa/manager-ops-notify.ts
 */
import { readFileSync } from "node:fs";
import {
  isLockedForPush,
  resolveStaffRecipients,
  type StaffAudience,
  type StaffMember,
} from "../../src/lib/notifications/staff-audience";

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

const ZA = "zone-a";
const ZB = "zone-b";
const staff: StaffMember[] = [
  { id: "admin", role: "admin", onesignalId: "p-admin", zoneIds: [], permissions: {}, muted: new Set() },
  { id: "mona", role: "manager", onesignalId: "p-mona", zoneIds: [ZA], permissions: { "manager.finance.view": false, "manager.support.manage": true }, muted: new Set() },
  { id: "fin", role: "manager", onesignalId: "p-fin", zoneIds: [ZA], permissions: { "manager.finance.view": true, "manager.support.manage": true }, muted: new Set() },
  { id: "quiet", role: "manager", onesignalId: null, zoneIds: [ZA], permissions: { "manager.support.manage": true },
    muted: new Set(["order_unassigned", "complaint_high_priority", "incident"]) },
  { id: "bina", role: "manager", onesignalId: "p-bina", zoneIds: [ZB], permissions: {}, muted: new Set() },
];
const ids = (a: StaffAudience) => resolveStaffRecipients(staff, a).map((r) => r.id).sort().join(",");
const pushOf = (a: StaffAudience, id: string) => resolveStaffRecipients(staff, a).find((r) => r.id === id)?.push;

console.log("\n── zones ──");
check("a zone-A alert reaches admins and zone-A managers only",
  ids({ zoneId: ZA, kind: "order_unassigned" }) === "admin,fin,mona,quiet", ids({ zoneId: ZA, kind: "order_unassigned" }));
check("a zone-B alert reaches admins and zone-B managers only",
  ids({ zoneId: ZB, kind: "order_unassigned" }) === "admin,bina");
check("a platform-wide shortage reaches admins only", ids({ zoneId: null, kind: "rider_shortage" }) === "admin");
check("a platform-wide incident reaches everyone", ids({ zoneId: null, kind: "incident" }) === "admin,bina,fin,mona,quiet");
check("adminsOnly", ids({ zoneId: ZA, kind: "ticket_activity", adminsOnly: true }) === "admin");

console.log("\n── permissions ──");
check("a finance kind reaches only managers with finance.view",
  ids({ zoneId: ZA, kind: "settlement_delayed", permission: "manager.finance.view" }) === "admin,fin");
check("a default-off switch absent from the map counts as off",
  !ids({ zoneId: ZB, kind: "cash_discrepancy", permission: "manager.finance.view" }).includes("bina"));
check("explicit recipients (an assignee) are kept to staff",
  ids({ zoneId: ZA, kind: "ticket_activity", userIds: ["mona", "customer-1"] }) === "mona");

console.log("\n── mutes ──");
check("a muted manager still gets the inbox row", ids({ zoneId: ZA, kind: "order_unassigned" }).includes("quiet"));
check("...but no push", pushOf({ zoneId: ZA, kind: "order_unassigned" }, "quiet") === false);
check("an unmuted manager is pushed", pushOf({ zoneId: ZA, kind: "order_unassigned" }, "mona") === true);
check("a critical complaint pushes through a mute",
  pushOf({ zoneId: ZA, kind: "complaint_high_priority", severity: "critical" }, "quiet") === true);
check("a warning-level complaint respects the mute",
  pushOf({ zoneId: ZA, kind: "complaint_high_priority", severity: "warning" }, "quiet") === false);
check("an incident always pushes", pushOf({ zoneId: null, kind: "incident" }, "quiet") === true);
check("force (SOS, a rider waiting) ignores mutes", pushOf({ zoneId: ZA, kind: "order_unassigned", force: true }, "quiet") === true);
check("locked kinds", isLockedForPush("incident") && isLockedForPush("complaint_high_priority", "critical")
  && !isLockedForPush("complaint_high_priority", "warning") && !isLockedForPush("order_unassigned"));

console.log("\n── structure ──");
const events = readFileSync("src/lib/notifications/order-events.ts", "utf8");
check("order-events.ts no longer pushes every manager by role", !/\.in\(\s*"role"\s*,\s*\[\s*"admin"\s*,\s*"manager"\s*\]\s*\)/.test(events));
check("order-events.ts sends staff pushes through notifyStaff", /notifyStaff\(/.test(events));
const notify = readFileSync("src/lib/notifications/ops-notify.ts", "utf8") + readFileSync("src/lib/notifications/staff-audience.ts", "utf8");
check("the staff notifier carries no Devanagari", !/[ऀ-ॿ]/.test(notify));
// Every notifyOps call's English copy (the staff copy) is free of Devanagari.
const opsCalls = events.match(/return (?:notifyOps|opsPush)\([\s\S]*?\n {2}\);/g) ?? [];
check("found the staff push calls", opsCalls.length >= 8, String(opsCalls.length));
check("no staff push text carries Devanagari", opsCalls.every((c) => !/[ऀ-ॿ]/.test(c)));
check("no staff push sends a Hindi variant", opsCalls.every((c) => !/\bhi:\s*/.test(c)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
