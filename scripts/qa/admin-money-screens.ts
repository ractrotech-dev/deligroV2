/**
 * QA — Admin money screens. What they must never get wrong:
 *
 *   * paging across two runs (Orders) lands every row on exactly one page;
 *   * Settlements never says "Every shop is paid" while money is still owed;
 *   * a report chart draws only a column the report really has;
 *   * Undo is offered only where it can work; a payment rebuilt under a new id
 *     takes the person there; an admin pays in one step under the one-admin rule;
 *   * Home's cards lead to lists showing exactly what they count;
 *   * no screen blames a migration for a failure; no refund can be raised.
 *
 * Offline: pure functions and file reads.
 * Usage: npx tsx --conditions=react-server scripts/qa/admin-money-screens.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pageAcrossRuns, pageCountOf, toPage } from "../../src/lib/utils/paging";
import { settlementHeadline, type SettlementHeadlineInput } from "../../src/lib/settlements/headline";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}
const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

console.log("\n── paging ──");
ok("a page number from the URL: junk is page 1", toPage(undefined) === 1 && toPage("x") === 1 && toPage("-3") === 1 && toPage("2.9") === 2);
ok("no rows is still one page", pageCountOf(0, 50) === 1 && pageCountOf(50, 50) === 1 && pageCountOf(51, 50) === 2);

for (const [a, b, size] of [[0, 0, 5], [3, 0, 5], [0, 7, 5], [5, 5, 5], [7, 12, 5], [12, 3, 5], [1, 1, 50]] as const) {
  const seen: string[] = [];
  const pages = pageCountOf(a + b, size);
  let sizesOk = true;
  for (let p = 1; p <= pages; p++) {
    const { first, second } = pageAcrossRuns(p, size, a, b);
    let onPage = 0;
    if (first) for (let i = first.from; i <= first.to; i++, onPage++) seen.push(`a${i}`);
    if (second) for (let i = second.from; i <= second.to; i++, onPage++) seen.push(`b${i}`);
    if (p < pages && onPage !== size) sizesOk = false;
  }
  const want = [...Array.from({ length: a }, (_, i) => `a${i}`), ...Array.from({ length: b }, (_, i) => `b${i}`)];
  ok(`${a} moving + ${b} finished, ${size} a page: every row once, in order, pages full`, seen.join() === want.join() && sizesOk, seen);
}
ok("a page past the end holds nothing", (() => {
  const { first, second } = pageAcrossRuns(9, 5, 3, 3);
  return first === null && second === null;
})());

console.log("\n── the Settlements headline ──");
const none: SettlementHeadlineInput = { toSend: 0, toSendShops: 0, unfinishedAmount: 0, unfinishedCount: 0, owedBack: 0, owedBackShops: 0, truncated: false };
ok("nothing anywhere: every shop is paid", settlementHeadline(none).title === "Every shop is paid");
let h = settlementHeadline({ ...none, unfinishedAmount: 4000, unfinishedCount: 2 });
ok("only unfinished payments: says so, with the amount", h.title === "Finish 2 payments" && h.amount === 4000, h);
h = settlementHeadline({ ...none, toSend: 900, toSendShops: 1, unfinishedAmount: 400, unfinishedCount: 1 });
ok("both: the amount to send, and the unfinished one named", h.title === "Send to 1 shop" && h.amount === 900 && /₹400 in 1 payment not finished/.test(h.notes.join()), h);
h = settlementHeadline({ ...none, owedBack: 70, owedBackShops: 1 });
ok("a shop owes us: not 'every shop is paid'", h.title === "Nothing to send right now" && /1 shop owes you ₹70/.test(h.notes.join()), h);
ok("too many orders to add up: not 'every shop is paid'", settlementHeadline({ ...none, truncated: true }).title !== "Every shop is paid");

const settlementsPage = read("src/app/admin/settlements/page.tsx");
ok("the page takes its sentence from the headline", /settlementHeadline\(/.test(settlementsPage) && !settlementsPage.includes('"Every shop is paid"'));

console.log("\n── past payments and a shop's orders page, with true counts ──");
const settlements = read("src/lib/data-access/admin-settlements.ts");
ok("Past payments reads a page, with a count per status", /listSettlementsPage\(/.test(settlementsPage) && /count: "exact", head: true/.test(settlements.slice(settlements.indexOf("export async function listSettlementsPage"))));
const payouts = settlements.slice(settlements.indexOf("export async function listOrderPayouts"), settlements.indexOf("interface Membership"));
ok("a shop's tab counts come from every order, not a capped read", /readAllRows<\{ id: string \}>/.test(payouts) && !/\.limit\(/.test(payouts));
ok("settlement lines are read past the row cap: a missed line would pay a shop twice", /async function settlementLines/.test(settlements) && /readInChunks/.test(settlements) && !/\.in\("settlement_id", ids\)/.test(settlements));

console.log("\n── undo on a paid order ──");
const row = read("src/app/admin/settlements/orders/order-payout-row.tsx");
ok("Undo is offered only on an order that is its own payment", /row\.paid && row\.settlementKind === "instant"/.test(row) && /canUndoHere\(row\) \? \(/.test(row));
ok("any other paid order points to the payment", /To undo, open the payment/.test(row) && /See payment/.test(row));
ok("the server's refusal says the same, in plain words", /Open that payment to cancel or reverse it/.test(settlements) && !/Void that settlement/.test(settlements));

console.log("\n── a payment rebuilt after a refund ──");
const requests = read("src/lib/data-access/settlement-requests.ts");
const actions = read("src/app/admin/settlements/actions.ts");
const paymentUi = read("src/app/admin/settlements/[id]/settlement-actions.tsx");
ok("the new id is carried back, not dropped", /movedTo/.test(requests) && /res\.extra\?\.settlementId/.test(requests) && /movedTo: result\.movedTo/.test(actions));
ok("the screen goes to the new payment", /router\.push\(`\/admin\/settlements\/\$\{result\.movedTo\}\?changed=1`\)/.test(paymentUi));
ok("and the new payment says why", /An adjustment changed the amount/.test(read("src/app/admin/settlements/[id]/page.tsx")));

console.log("\n── an admin pays alone, on the record ──");
const pay = requests.slice(requests.indexOf("export async function adminPayOrRequestSettlement"), requests.indexOf("/** Admin \"Paid\" on one order"));
ok("under the one-admin rule the request opens and approves in one call", pay.indexOf("openSettlementRequest(input.adminId, input.settlementId, \"bank\", null") > 0 && pay.indexOf("approveVendorSettlement(") > pay.indexOf("openSettlementRequest(input.adminId, input.settlementId, \"bank\", null"));
ok("nothing is opened until the reference and reason are there", pay.indexOf("if (!ref)") < pay.indexOf("openSettlementRequest(input.adminId, input.settlementId, \"bank\", null") && pay.indexOf("note.length < 3") < pay.indexOf("openSettlementRequest(input.adminId, input.settlementId, \"bank\", null"));
ok("with the rule off, it still asks someone else", /if \(!pending && !mayOwn\)/.test(pay) && /adminMessage\("same_person"\)/.test(pay));
ok("the screen offers one step when the rule is on", /const canRequest = !owes && pendingRequest === null && !mayApproveOwn/.test(paymentUi));
const on = read("supabase/migrations/0186_single_admin_payments_on.sql");
ok("0186 uses the existing switch and leaves the maker-checker function alone", /allow_single_admin_payments/.test(on) && !/create or replace function/.test(on));
ok("0186 writes its change to the audit log", /insert into public\.ops_audit_log/.test(on));

console.log("\n── Home ──");
const home = read("src/app/admin/page.tsx");
ok("'Failed payments' opens a list of exactly that", home.includes('"/admin/orders?payment=failed"') && !home.includes("status=PLACED"));
ok("'No rider' filters the board to exactly that", home.includes('show: "norider"') && /o\.noRider/.test(home));
ok("what's owed is an amount, from the one dues rollup, not a scan of every order", /totalShopDues\(\)/.test(home) && !/getSettlementStats|listVendorSettlementQueue/.test(home));
ok("a failed sum is not a green zero", /figure: "—"/.test(home) && /tone: "amber"/.test(home));
const adminOrders = read("src/lib/data-access/admin-orders.ts");
ok("the failed-payment filter is Home's definition", /eq\("payment_status", "failed"\)\.neq\("status", "cancelled"\)/.test(adminOrders) && /\.eq\("payment_status", "failed"\)\s*\.neq\("status", "cancelled"\)/.test(read("src/lib/data-access/admin-stats.ts")));
ok("Home's count and the no-rider list share one definition", /unassignedOrderIds/.test(read("src/lib/data-access/admin-dispatch.ts")) && /noRiderIds/.test(adminOrders));

console.log("\n── Orders ──");
const ordersPage = read("src/app/admin/orders/page.tsx");
ok("the table has a rider column", /key: "rider"/.test(ordersPage));
ok("real paging", /TableFooter/.test(ordersPage) && /totalPages=\{totalPages\}/.test(ordersPage) && !/WINDOW/.test(ordersPage));
ok("the vendor filter is an id the database filters on", /eq\("restaurant_id", f\.vendorId\)/.test(adminOrders) && /f\.vendorId/.test(ordersPage));
ok("a search can't inject into the or filter: names are ids by then, and a code is hex", /\[0-9a-fA-F\]\{4,8\}/.test(adminOrders) && !/or\(`[^`]*\$\{q/.test(adminOrders));
ok("no live refresh over a search or an old page", /view\.page === 1 && !f\.q/.test(ordersPage));

console.log("\n── reports ──");
const reports = read("src/lib/data-access/admin-reports.ts");
ok("a chart needs its column", /columnKeys\.has\("customerPaid"\)/.test(reports) && /columnKeys\.has\("orders"\)/.test(reports));
const defs = read("src/lib/reports/definitions.ts");
const cols = (kind: string) => defs.slice(defs.indexOf(`kind: "${kind}"`), defs.indexOf("},", defs.indexOf(`kind: "${kind}"`)));
ok("Daily finance has no orders column, so no orders chart", !/c\("orders"/.test(cols("finance-daily")) && /c\("customerPaid"/.test(cols("finance-daily")));
ok("Average order has no customer-paid column, so no revenue chart", !/c\("customerPaid"/.test(cols("average-order")) && /c\("orders"/.test(cols("average-order")));
const reportsPage = read("src/app/admin/reports/page.tsx");
ok("the page draws only what the report has", /report\?\.charts\.revenue/.test(reportsPage) && /report\?\.charts\.orders/.test(reportsPage));
ok("'shorter date range' only when the query ran out of time", /57014/.test(reportsPage) && /Refresh to try again/.test(reportsPage));

console.log("\n── honest messages ──");
for (const page of [
  "src/app/admin/settlements/new/page.tsx",
  "src/app/admin/alerts/page.tsx",
  "src/app/admin/settings/alerts/page.tsx",
  "src/app/admin/announcements/announcements-view.tsx",
  "src/app/admin/announcements/actions.ts",
  "src/app/admin/riders/payments/page.tsx",
  "src/app/admin/settings/platform/payment-approvals.tsx",
]) {
  const code = read(page).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok(`${page}: no migration named on screen`, !/migration|\b01[0-9]{2}\b|\b00[0-9]{2}\b/i.test(code));
}
const detail = read("src/app/admin/settlements/[id]/page.tsx");
ok("a failed read of a payment is not a 404", /Could not load this payment/.test(detail) && !/catch \{\s*notFound\(\)/.test(detail));

console.log("\n── refunds: no screen left, old records stay in reports ──");
const refunds = read("src/lib/data-access/refunds.ts");
const nav = read("src/components/admin/admin-nav.ts");
const reportDefs = read("src/lib/reports/definitions.ts");
ok("the Refunds page is gone", !existsSync(join(root, "src/app/admin/refunds/page.tsx")) && !existsSync(join(root, "src/components/admin/refund-card.tsx")));
ok("no sidebar item, badge or top bar icon", !/refund/i.test(nav) && !/refund/i.test(read("src/components/admin/admin-top-bar.tsx")) && !/refund/i.test(read("src/components/admin/admin-sidebar.tsx")));
ok("no Overview figure", !/refund/i.test(read("src/app/admin/page.tsx")));
ok("no feature switch", !/admin\.refunds/.test(read("src/lib/features/catalog.ts")));
ok("old refunds stay in the Refund and adjustment report", /kind: "refunds-adjustments", label: "Refund and adjustment report"/.test(reportDefs));
ok("no code raises a refund", !/queueRefundForOrder|requestRefund|queue_order_refund/.test(refunds) && !/queueRefundForOrder/.test(read("src/lib/data-access/payments.ts") + read("src/lib/data-access/vendor-orders.ts")));
ok("no admin action can decide one", !/decideRefund|releaseRefundClaim/.test(read("src/app/admin/actions.ts")));
ok("the gateway path is kept for the owner's decision on online money", /refundRazorpayPayment/.test(refunds) && /export async function decideRefund/.test(refunds));
ok("nothing tells anyone to raise one", !/Raise a refund|refunded from \/admin/.test(read("src/app/admin/orders/actions.ts") + read("src/components/admin/order-intervention.tsx")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
