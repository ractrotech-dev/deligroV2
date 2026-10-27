/**
 * QA — a manager's menu sheet for one shop (0176): which columns a manager may
 * set, how a plan becomes the ops_bulk_menu_apply arguments, and that the route
 * checks the switches before it writes.
 * Usage: npx tsx scripts/qa/manager-menu-sheet.ts
 */
import { readFileSync } from "node:fs";
import type { ColumnKey, SheetRow } from "../../src/lib/bulk/menu-sheet";
import { bulkMenuRpcArgs, managerMenuColumns, planSheet, type ExistingDish } from "../../src/lib/bulk/menu-plan";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra === undefined ? "" : `\n         ${JSON.stringify(extra)}`}`); }
}

const dish = (over: Partial<ExistingDish>): ExistingDish => ({
  id: "11111111-1111-4111-8111-111111111111", externalId: null, name: "Paneer tikka", category: "Starters", price: 220,
  discountPrice: null, description: null, veg: true, available: true, popular: false, bestseller: false, imageUrl: null,
  stockQty: 10, lowStockAt: null, ...over,
});

console.log("\n── columns ──");
const without = managerMenuColumns(false);
const withStock = managerMenuColumns(true);
check("without adjust_stock: price, available and photo, no stock",
  without.has("price") && without.has("available") && without.has("imageUrl") && !without.has("stock") && !without.has("lowStockAt"));
check("with adjust_stock: stock and low-stock alert too", withStock.has("stock") && withStock.has("lowStockAt"));

console.log("\n── plan without adjust_stock ──");
const cols: ColumnKey[] = ["id", "name", "price", "stock"];
const rows: SheetRow[] = [
  { line: 2, name: "Paneer tikka", price: 240, stock: 3 },
  { line: 3, name: "Naan", price: 40, stock: 50 },
];
let plan = planSheet([dish({})], rows, { canCreate: true, allowed: without, hasInventory: true, sheetColumns: cols });
check("stock is listed in ignoredColumns", plan.ignoredColumns.includes("stock"), plan.ignoredColumns);
check("no patch carries stock_qty", plan.items.every((i) => !i.patch || !("stock_qty" in i.patch)), plan.items);
check("a new dish does not start with a stock count either", plan.items.every((i) => !i.insert || !("stock_qty" in i.insert)), plan.items);

console.log("\n── rpc arguments ──");
plan = planSheet([dish({})], rows, { canCreate: true, allowed: withStock, hasInventory: true, sheetColumns: cols });
const args = bulkMenuRpcArgs(plan);
check("the price change is an update with its patch", args.updates.length === 1 && args.updates[0].patch.price === 240, args.updates);
check("stock_qty is moved out of the patch", !("stock_qty" in args.updates[0].patch), args.updates);
check("...into stock, with the count the sheet was made from as expected",
  args.stock.length === 1 && args.stock[0].stockQty === 3 && args.stock[0].expected === 10 && args.stock[0].line === 2, args.stock);
check("a create row is an insert without restaurant_id", args.inserts.length === 1 && args.inserts[0].name === "Naan" && !("restaurant_id" in args.inserts[0]), args.inserts);
check("a new dish keeps its starting stock in the insert", args.inserts[0].stock_qty === 50, args.inserts);
const onlyStock = bulkMenuRpcArgs(planSheet([dish({})], [{ line: 2, name: "Paneer tikka", stock: 4 }],
  { canCreate: true, allowed: withStock, hasInventory: true, sheetColumns: ["name", "stock"] }));
check("a row that only changes stock is not an empty update", onlyStock.updates.length === 0 && onlyStock.stock.length === 1, onlyStock);
check("each update keeps its sheet line for error messages", args.updates[0].line === 2 && args.inserts.length === args.insertLines.length && args.insertLines[0] === 3, args);

console.log("\n── route ──");
const route = readFileSync("src/app/api/manager/vendors/[id]/menu-sheet/route.ts", "utf8");
check("the route needs manager.products.view", route.includes('managerApiContext("manager.products.view")'));
const gate = route.indexOf('"manager.products.bulk_menu"');
check("apply checks manager.products.bulk_menu before it writes", gate > 0 && gate < route.indexOf("runManagerMenuSheet({"));
check("stock columns follow manager.products.adjust_stock", route.includes('"manager.products.adjust_stock"'));
check("uploads are rate limited", /managerWriteLimit\(ctx, "menu-sheet", 10\)/.test(route));
check("a shop outside the manager's zones is a 404", route.includes("managerShop(") && route.includes("not_found"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
