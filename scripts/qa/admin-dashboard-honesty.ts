/**
 * QA — Phase 2 review finding 11: the admin overview says when its sales
 * figures failed to load (instead of ₹0), and labels that differ in meaning
 * from the manager dashboard's say so. Offline. Usage:
 * npx tsx scripts/qa/admin-dashboard-honesty.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
}
const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
const stats = read("src/lib/data-access/admin-stats.ts");
const page = read("src/app/admin/page.tsx");

ok("a failed sales read is not turned into an empty list", !/\.catch\(\(\) => \[\] as MetricOrder\[\]\)/.test(stats));
ok("the overview data says when the sales figures are unavailable", /salesUnavailable/.test(stats));
ok("the page shows a dash and a reason instead of ₹0", /salesUnavailable/.test(page) && /Couldn.t load/.test(page));
ok("'Orders today' says it leaves cancelled orders out", page.includes('"Orders today (excl. cancelled)"'));
ok("riders on a delivery are called that, not 'active riders'", page.includes('"Riders on delivery"') && !page.includes('"Riders currently delivering"'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
