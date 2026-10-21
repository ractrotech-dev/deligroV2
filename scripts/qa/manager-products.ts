/**
 * QA — manager products (§12): query parsing, the stock/availability
 * definitions behind the list counts, the insights builder (frequently
 * unavailable, price changes, top / slow sellers, out of stock), the detail
 * serialiser, and structural rules on the routes and the data layer.
 *
 * Usage: npx tsx scripts/qa/manager-products.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildProductInsights,
  isLowStock,
  isOutOfStock,
  parseProductQuery,
  toProductDetail,
  toProductListItem,
  type ProductRow,
} from "../../src/lib/ops/product-contract";

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
const qp = (s: string) => new URLSearchParams(s);
const VENDOR = randomUUID();

console.log("\n── query parsing ──");
let p = parseProductQuery(qp(""));
check("defaults: limit 50", p.ok && p.query.limit === 50 && p.query.availability === null);
p = parseProductQuery(qp(`availability=low_stock&approval=pending&flagged=open&hidden=true&vendor=${VENDOR}`));
check("every filter parses", p.ok && p.query.availability === "low_stock" && p.query.approval === "pending"
  && p.query.flagged === true && p.query.hidden === true && p.query.vendor === VENDOR);
p = parseProductQuery(qp("availability=gone"));
check("an unknown availability → field availability", !p.ok && p.field === "availability");
p = parseProductQuery(qp("approval=maybe"));
check("an unknown approval → field approval", !p.ok && p.field === "approval");
p = parseProductQuery(qp("flagged=closed"));
check("flagged only accepts open", !p.ok && p.field === "flagged");
p = parseProductQuery(qp("hidden=yes"));
check("hidden only accepts true", !p.ok && p.field === "hidden");
p = parseProductQuery(qp("vendor=x"));
check("a non-uuid vendor → field vendor", !p.ok && p.field === "vendor");
p = parseProductQuery(qp("q=a"));
check("a one-letter search → field q", !p.ok && p.field === "q");

console.log("\n── stock definitions ──");
const base: ProductRow = {
  id: randomUUID(), name: "Paneer Tikka", restaurant_id: VENDOR, category: "Starters", price: 180, discount_price: null,
  pending_price: null, image_url: null, veg: true, available: true, stock_qty: null, low_stock_at: null, sold_out_by_stock: false,
  approval_status: "approved", hidden_by_ops: false, updated_at: null, restaurants: { name: "Spice Hub", zone_id: randomUUID() },
};
check("untracked stock is neither out nor low", !isOutOfStock(base) && !isLowStock(base));
check("stock 0 is out of stock", isOutOfStock({ ...base, stock_qty: 0 }));
check("sold out by stock is out of stock", isOutOfStock({ ...base, sold_out_by_stock: true, stock_qty: 3 }));
check("3 left with a threshold of 5 is low", isLowStock({ ...base, stock_qty: 3, low_stock_at: 5 }));
check("0 left is out, not low", !isLowStock({ ...base, stock_qty: 0, low_stock_at: 5 }));
check("no threshold is never low", !isLowStock({ ...base, stock_qty: 1, low_stock_at: null }));

console.log("\n── serialisers ──");
const li = toProductListItem({ ...base, pending_price: 200, approval_status: "pending" }, 2);
check("list item carries the parked price, approval and flags",
  li.pendingPrice === 200 && li.approvalStatus === "pending" && li.openFlags === 2 && li.vendor.name === "Spice Hub" && li.stockQty === null);
const detail = toProductDetail({
  row: { ...base, hidden_by_ops: true },
  extra: { description: "Smoky", approval_note: null, hidden_reason: "Wrong photo" },
  openFlags: 0,
  variants: [{ name: "Half", price: 120 }],
  addonGroups: [{ name: "Extras", addons: [{ name: "Cheese", price: 20 }] }],
  changes: [], flags: [],
  sales: { from: "2026-09-22", to: "2026-10-21", units: 4, revenue: 720, orders: 3, rankInVendor: 2, daily: [] },
  availability: { timesUnavailable: 1, hoursUnavailable: 2 },
  allowed: { flag: true, hide: false, unhide: true, approve: false, reject: false, adjustStock: false },
});
check("detail carries the hidden reason and options", detail.hidden === true && detail.hiddenReason === "Wrong photo"
  && detail.variants[0].name === "Half" && detail.addonGroups[0].addons[0].price === 20);

console.log("\n── insights ──");
const range = { start: new Date("2026-10-01T00:00:00Z"), endExclusive: new Date("2026-10-11T00:00:00Z") };
const mk = (over: Partial<ProductRow>): ProductRow => ({ ...base, id: randomUUID(), ...over });
const top = mk({ name: "Biryani" });
const zero = mk({ name: "Salad" });
const hiddenSeller = mk({ name: "Hidden", hidden_by_ops: true });
const flaky = mk({ name: "Soup", available: true });
const gone = mk({ name: "Kulfi", stock_qty: 0, available: false, sold_out_by_stock: true });
const ins = buildProductInsights({
  items: [top, zero, hiddenSeller, flaky, gone],
  sales: new Map([[top.id, { units: 64, revenue: 11520 }], [hiddenSeller.id, { units: 99, revenue: 9900 }]]),
  availabilityChanges: [
    { itemId: flaky.id, at: "2026-10-02T10:00:00Z", to: false }, { itemId: flaky.id, at: "2026-10-02T11:00:00Z", to: true },
    { itemId: flaky.id, at: "2026-10-03T10:00:00Z", to: false }, { itemId: flaky.id, at: "2026-10-03T11:00:00Z", to: true },
    { itemId: flaky.id, at: "2026-10-04T10:00:00Z", to: false }, { itemId: flaky.id, at: "2026-10-04T11:00:00Z", to: true },
  ],
  priceChanges: [
    { itemId: top.id, at: "2026-10-05T00:00:00Z", from: "160", to: "180", source: "vendor" },
    { itemId: top.id, at: "2026-09-01T00:00:00Z", from: "150", to: "160", source: "vendor" },
  ],
  range,
  limit: 10,
});
check("top sellers lead with the best seller", ins.topSellers[0]?.product.id === top.id && ins.topSellers[0].units === 64);
check("a hidden dish is never a top seller", !ins.topSellers.some((t) => t.product.id === hiddenSeller.id));
check("a dish with no sales is a slow seller", ins.slowSellers.some((s) => s.product.id === zero.id && s.units === 0));
check("an unavailable dish is not counted as a slow seller", !ins.slowSellers.some((s) => s.product.id === gone.id));
check("three toggles make a dish frequently unavailable", ins.frequentlyUnavailable.some((f) => f.product.id === flaky.id && f.timesUnavailable === 3));
check("a price change outside the range is excluded", ins.priceChanges.length === 1 && ins.priceChanges[0].from === 160);
check("price change percent", ins.priceChanges[0]?.changePct === 12.5);
check("out of stock listed", ins.outOfStock.some((o) => o.id === gone.id));

console.log("\n── structural ──");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const routes = walk("src/app/api/manager/products").filter((f) => f.endsWith("route.ts"));
check("product routes exist", routes.length >= 4, routes.join());
for (const r of routes.filter((x) => !/actions|restricted|image-reviews/.test(x))) {
  check(`${r} opens with managerApiContext("manager.products.view")`, readFileSync(r, "utf8").includes('managerApiContext("manager.products.view")'));
}
const da = readFileSync("src/lib/data-access/manager-products.ts", "utf8");
check("no select(\"*\")", !/select\(\s*["']\*["']/.test(da));
const reads = da.split('from("menu_items")').length - 1;
const scoped = (da.match(/inScope\(/g) ?? []).length;
check("every menu_items read goes through the zone scope", reads > 0 && scoped >= reads, `${reads} reads, ${scoped} scoped`);
check("list counts: one scoped RPC, on the first page only", da.includes('rpc("ops_product_counts"') && /q\.cursor\s*\?\s*null/.test(da));
check("insights: summed in Postgres (ops_product_insights), only the named dishes read", da.includes('rpc("ops_product_insights"') && da.includes("assembleProductInsights("));
check("the flagged filter joins open flags instead of a platform-wide id list in the URL",
  da.includes("listing_flags!inner") && !da.includes("openlyFlaggedIds"));
const stats = readFileSync("src/app/api/manager/stats/route.ts", "utf8");
check("stats accepts a vendor filter, checked against scope", stats.includes("vendorInScope") && stats.includes("manager.vendors.view"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
