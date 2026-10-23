/**
 * QA — the manager side uses the client document's exact words for the things the
 * document names: the 12 report names (§13) and the 18 dashboard figures (§1).
 * Offline. Usage: npx tsx scripts/qa/manager-spec-labels.ts
 *
 * The dashboard side is read from apps/manager/lib/models/dashboard.dart (the
 * FigureKey enum, in order) so no Dart toolchain is needed; the app's own
 * apps/manager/test/dashboard_labels_test.dart asserts the same list from inside Flutter.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORTS } from "../../src/lib/reports/definitions";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`, cond || detail === undefined ? "" : detail);
}

/** §13 "Required reports", in the document's order and words. */
export const SPEC_REPORT_NAMES = [
  "Sales Report",
  "Order Report",
  "Vendor Performance Report",
  "Rider Performance Report",
  "Commission Report",
  "Vendor Settlement Report",
  "Rider Payout Report",
  "Cancellation Report",
  "Refund and Adjustment Report",
  "Marketing Campaign Report",
  "Support Ticket Report",
  "Cash Reconciliation Report",
];

/** §1 "The dashboard must display", in the document's order and words. */
export const SPEC_DASHBOARD_LABELS = [
  "Today's Total Sales",
  "Total Sales",
  "Today's Orders",
  "Total Orders",
  "Pending Orders",
  "Completed Orders",
  "Cancelled Orders",
  "Active Vendors",
  "Online Vendors",
  "Active Riders",
  "Online Riders",
  "Riders Currently on Delivery",
  "Total Delivery Fees",
  "Total Platform Commission",
  "Vendor Payments Due",
  "Rider Payments Due",
  "Pending Marketing Requests",
  "Pending Support Tickets",
];

console.log("── §13 report names ──");
const labels = REPORTS.map((r) => r.label);
SPEC_REPORT_NAMES.forEach((name, i) => {
  // The app writes names in sentence case ("Sales report"); the words must be the document's.
  const found = labels.find((l) => l.toLowerCase() === name.toLowerCase());
  ok(`report ${i + 1}: ${name}`, !!found, `registry has: ${labels.join(" | ")}`);
});
const firstTwelve = REPORTS.slice(0, 12).map((r) => r.label.toLowerCase());
ok("the twelve required reports come first, in the document's order", SPEC_REPORT_NAMES.every((n, i) => firstTwelve[i] === n.toLowerCase()), firstTwelve);

console.log("\n── §1 dashboard figures ──");
const dart = readFileSync(join(__dirname, "..", "..", "apps/manager/lib/models/dashboard.dart"), "utf8");
const block = dart.slice(dart.indexOf("enum FigureKey"), dart.indexOf("const FigureKey("));
const found: string[] = [];
for (const m of block.matchAll(/^\s{2}[a-zA-Z]+\('[A-Za-z]+',\s*(?:"([^"]+)"|'([^']+)')/gm)) found.push(m[1] ?? m[2]);
ok("the dashboard has eighteen figures", found.length === 18, found.length);
SPEC_DASHBOARD_LABELS.forEach((label, i) => ok(`figure ${i + 1}: ${label}`, found[i] === label, `app says: ${found[i]}`));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
