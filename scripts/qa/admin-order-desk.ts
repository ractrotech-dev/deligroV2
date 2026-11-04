/**
 * The admin dashboard is the order desk: the owner runs orders from it, and the
 * sales figures and charts live under Reports. Offline.
 *
 * Usage: npm run test:order-desk
 */
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
}
const read = (p: string) => readFileSync(p, "utf8");

const home = read("src/app/admin/page.tsx");
const desk = read("src/components/admin/order-desk.tsx");
const controls = read("src/components/admin/order-desk-controls.tsx");
const dispatch = read("src/lib/data-access/admin-dispatch.ts");
const numbers = read("src/app/admin/reports/overview/page.tsx");
const manager = read("src/app/manager/actions.ts");

console.log("\n── the dashboard is for orders ──");
for (const gone of ["MetricRow", "ShareBar", "TrendChart", "RankBars", "getAdminDashboard", "getAdminSeries"]) {
  ok(`the dashboard no longer has ${gone}`, !home.includes(gone));
}
ok("it shows the board and the list", home.includes("<OrderBoard") && home.includes("<OrderList"));
ok("it keeps rider emergencies and exceptions", home.includes("<EmergencyBanner") && home.includes("<ExceptionQueue"));
ok("it updates by itself", home.includes("<AutoRefresh"));
ok("a failed read is not an empty board", /failed: true/.test(dispatch) && /desk\.failed/.test(home));

console.log("\n── nothing was lost ──");
for (const kept of ["MetricRow", "TrendChart", "RankBars", '"Where orders ended up"', '"How people paid"', '"Platform earnings today"']) {
  ok(`Business numbers has ${kept}`, numbers.includes(kept));
}
ok("the dashboard links to it", home.includes('"/admin/reports/overview"'));
ok("Reports links to it", read("src/app/admin/reports/page.tsx").includes('"/admin/reports/overview"'));
ok("it checks the role itself", /await requireRole\("admin"\)/.test(numbers));

console.log("\n── the buttons do real, audited work ──");
ok("moving an order is the audited call", /advanceOrder\(order\.id, order\.dbStatus/.test(controls));
ok("assigning a rider is the audited call", /assignRider\(order\.id/.test(controls));
ok("changing a rider is the audited call", /reassignRider\(order\.id/.test(controls));
ok("cancelling needs a reason", /cancelOrderAsAdmin\(order\.id, reason\.trim\(\)\)/.test(controls) && /isValidReason\(reason\)/.test(controls));
ok("delivered asks first", /needsConfirm = order\.dbStatus === "on_the_way"/.test(controls));
{
  const at = manager.indexOf("export async function reassignRider(");
  const body = manager.slice(at, at + 1400);
  ok("reassignRider starts with a role check", /^[\s\S]{0,220}await requireRole\(\["manager", "admin"\]\)/.test(body));
  ok("reassignRider has its switch and a rate limit", /manager\.reassign_rider/.test(body) && /rateLimit\(/.test(body));
  ok("reassignRider needs a reason", /isValidReason\(opts\.reason\)/.test(body));
  ok("reassignRider checks the rider can work", /riderUnworkable\(riderId\)/.test(body));
}

console.log("\n── desktop only ──");
for (const [name, src] of [["page", home], ["board", desk], ["controls", controls]] as const) {
  ok(`the ${name} has no phone breakpoints`, !/\b(sm|md|lg|xl|@3xl|@5xl):/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
