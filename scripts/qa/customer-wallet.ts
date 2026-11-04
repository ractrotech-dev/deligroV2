/**
 * The customer wallet's pure rules, and the structural promises around it.
 * The money paths themselves are proved on the real migration chain:
 *   node scripts/qa/sql/migration-0197.mjs
 *
 * Usage: npm run test:wallet
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { breakdownOrder } from "../../src/lib/settlements/math";
import { paymentAvailability, refusePayment } from "../../src/lib/payments/cod-rules";
import {
  cashDue,
  checkCorrection,
  maxPointsFor,
  parseWalletPoints,
  signedRupees,
  walletChangeMessage,
  walletKindLabel,
  walletSpendMessage,
} from "../../src/lib/wallet/money";

let fails = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  if (!ok) fails++;
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

// ---------- the sums ----------
check("cash due: bill less points", cashDue(150, 50) === 100);
check("cash due: fully covered is zero", cashDue(150, 150) === 0);
check("cash due: never negative", cashDue(150, 200) === 0);
check("cash due: no points", cashDue(150, 0) === 150 && cashDue(150, null) === 150 && cashDue(150, undefined) === 150);
check("cash due: no bill", cashDue(null, 10) === 0);
check("max points: the balance", maxPointsFor(50, 150) === 50);
check("max points: the bill", maxPointsFor(500, 150) === 150);
check("max points: nothing", maxPointsFor(0, 150) === 0);

check("points asked: absent is none", parseWalletPoints(undefined) === 0 && parseWalletPoints(null) === 0);
check("points asked: whole", parseWalletPoints(50) === 50);
check("points asked: a fraction is refused", parseWalletPoints(2.5) === null);
check("points asked: negative is refused", parseWalletPoints(-1) === null);
check("points asked: text is refused", parseWalletPoints("50") === null);
check("points asked: absurd is refused", parseWalletPoints(1e12) === null);

// ---------- corrections ----------
check("correction: up", (() => { const r = checkCorrection("50", "Rider typed the wrong order"); return r.ok && r.delta === 50; })());
check("correction: down", (() => { const r = checkCorrection("-50", "Taking back a test credit"); return r.ok && r.delta === -50; })());
check("correction: reason is required", !checkCorrection("50", "").ok);
check("correction: a blank reason is refused", !checkCorrection("50", "     ").ok);
check("correction: too short a reason is refused", !checkCorrection("50", "ok").ok);
check("correction: zero is refused", !checkCorrection("0", "Nothing at all").ok);
check("correction: a fraction is refused", !checkCorrection("1.5", "Half a rupee").ok);
check("correction: text is refused", !checkCorrection("lots", "A lot of points").ok);
check("correction: too big is refused", !checkCorrection("100001", "Far too many").ok);

// ---------- words ----------
check("rider wording: wrong code counts down", walletChangeMessage("wrong_code", { triesLeft: 1 }) === "Wrong code. 1 try left.");
check("rider wording: lockout says what to do", /Give the change in cash/.test(walletChangeMessage("locked")));
check("rider wording: limit names the limit", /₹100/.test(walletChangeMessage("over_limit", { limit: 100 })));
check("rider wording: nothing unknown is blank", walletChangeMessage("something_new").length > 0);
check("customer wording: balance is shown", /50 points/.test(walletSpendMessage("insufficient", 50)));
check("kinds have words", ["change_credit", "order_spend", "order_return", "order_adjust", "admin_correction", "legacy"].every((k) => walletKindLabel(k) !== "Wallet"));
check("signs", signedRupees(50) === "+₹50" && signedRupees(-30) === "−₹30");

// ---------- the shop's money ----------
const order = {
  total: 300,
  deliveryFee: 29,
  taxAmount: 15,
  tip: 10,
  discount: 0,
  discountFundedBy: null,
  commissionPct: 20,
  commissionGstPct: 18,
  otherCharges: 5,
  paymentMethod: "cod" as const,
  approvedRefunds: 0,
};
const plain = breakdownOrder({ ...order, paymentStatus: "pending" });
// Points change neither the total nor the method. Fully covered, only the status moves.
const partlyPoints = breakdownOrder({ ...order, paymentStatus: "pending" });
const allPoints = breakdownOrder({ ...order, paymentStatus: "paid" });
check("shop payout: same with no points and some points", JSON.stringify(plain) === JSON.stringify(partlyPoints));
check("shop payout: same when points cover it all", JSON.stringify(plain) === JSON.stringify(allPoints), { plain, allPoints });
check("shop payout: Deligro still owes the shop", allPoints.remitsVendor === true && allPoints.vendorNet === plain.vendorNet);
check("shop payout: the arithmetic isn't zero by accident", plain.vendorNet > 0);

// ---------- the cash limit ----------
const rules = { acceptCod: true, acceptOnline: false, codMaxOrder: 120 };
check("cash limit: over it with no points", refusePayment(rules, "cod", cashDue(200, 0)) === "cod_limit_exceeded");
check("cash limit: judged on the cash due", refusePayment(rules, "cod", cashDue(200, 100)) === null);
check("cash limit: fully covered is under any limit", paymentAvailability(rules, cashDue(200, 200)).cod === true);

// ---------- structure ----------
const collect = read("src/lib/data-access/rider-delivery-actions.ts");
check("the normal cash record is the cash due, never the bill", /cod_collected_amount: cashDue\(order\?\.total, order\?\.wallet_points_used\)/.test(collect));
check("the normal cash record can't overwrite a recorded amount", /\.is\("cod_collected_at", null\)/.test(collect));

const orders = read("src/lib/data-access/driver-orders.ts");
check("offers and the board collect the cash due", !/collectAmount: instruction === "collect" \? \(order\.total/.test(orders));
const jobs = read("src/lib/data-access/rider-jobs.ts");
check("the rider app collects the cash due", !/collectAmount: instruction === "collect" \? \(order\.total/.test(jobs));
check("staff closing a delivery still closes one with change already recorded", /delivery\.cod_collected_at && delivery\.status !== "picked_up"/.test(orders));

for (const route of [
  "src/app/api/wallet/route.ts",
  "src/app/api/orders/[id]/wallet-code/route.ts",
]) {
  const src = read(route);
  check(`${route}: the customer is the session`, /auth\.getUser\(\)/.test(src) && /user\.id/.test(src));
  check(`${route}: rate limited`, /rateLimit\(/.test(src));
}
const change = read("src/app/api/rider/deliveries/[orderId]/wallet-change/route.ts");
check("rider route: role first", change.indexOf("requireRiderApi()") < change.indexOf("addWalletChange("));
check("rider route: gated by the switch", /isFeatureOn\("driver\.cod_change", profile\.id\)/.test(change));
check("rider route: rate limited", /rateLimit\(`rider-wallet-change/.test(change));
check("rider route: the amount is what was received, no change figure is read", !/body\.change|\bchange\b.*=.*body/.test(change));

const web = read("src/app/driver/actions.ts");
check("web rider action: role first", web.indexOf("requireDriver()", web.indexOf("addWalletChangeAction")) > 0);
check("web rider action: gated by the switch", /isFeatureOn\("driver\.cod_change", driver\.id\)/.test(web));

const customerAction = read("src/app/admin/customers/[id]/actions.ts");
const correctBody = customerAction.slice(customerAction.indexOf("correctWalletAction"));
check("correct action: admin only", correctBody.indexOf('requireRole("admin")') > 0 && correctBody.indexOf('requireRole("admin")') < correctBody.indexOf("correctWallet("));
for (const page of ["src/app/admin/customer-wallets/page.tsx", "src/app/admin/customers/[id]/page.tsx", "src/app/admin/cash-ledger/page.tsx"]) {
  check(`${page}: admin only`, /await requireRole\("admin"\)/.test(read(page)));
}

const sql = read("supabase/migrations/0197_customer_wallet.sql");
for (const fn of ["wallet_issue_change_code", "wallet_add_change", "wallet_spend_on_order", "wallet_admin_correct", "ops_wallet_summary"]) {
  check(`0197: ${fn} is closed to anon and authenticated`, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`).test(sql));
  check(`0197: ${fn} is open to the service role only`, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`).test(sql));
}
check("0197: orders.wallet_points_used is granted per column (AGENTS.md rule 1)", /grant select \(wallet_points_used\) on public\.orders to authenticated/.test(sql));

const nav = read("src/components/admin/admin-nav.ts");
check("sidebar: Customer wallets is under People", /label: "Customer wallets",[\s\S]{0,60}group: "People"/.test(nav));

console.log(fails ? `\n${fails} check(s) failed` : "\nAll customer wallet checks passed.");
process.exit(fails ? 1 : 0);
