/**
 * QA — reading a menu / inventory sheet and planning what it does.
 * Pure: no database. Usage: npx tsx scripts/qa/bulk-menu-sheet.ts
 */
import {
  EXAMPLE_ITEMS,
  MAX_SHEET_ROWS,
  gridToCsv,
  gridToXlsx,
  parseSheetFile,
  templateGrid,
} from "../../src/lib/bulk/menu-sheet";
import { MANAGER_COLUMNS, OWNER_COLUMNS, planSheet, type ExistingDish } from "../../src/lib/bulk/menu-plan";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const enc = (s: string) => new TextEncoder().encode(s);
const parseCsv = (s: string) => parseSheetFile(enc(s), "menu.csv");

// ---------- parsing ----------
const full = parseCsv(
  "id,Name,Category,Price,Discount Price,Veg (Yes/No),Available,stock,Low Stock At\n" +
  "item-1,Paneer Tikka,Starters,\"1,220\",199,Yes,yes,40,5\n" +
  "item-2,Chicken Biryani,Rice,₹299,,no,,,\n",
);
check("headers are read forgivingly", full.columns.includes("discountPrice") && full.columns.includes("veg") && full.columns.includes("lowStockAt"));
check("two good rows parse", full.rows.length === 2 && full.issues.length === 0);
check("price drops the rupee sign and commas", full.rows[0].price === 1220 && full.rows[1].price === 299);
check("yes/no cells become booleans", full.rows[0].veg === true && full.rows[1].veg === false);
check("an empty cell is 'leave as is', not a value", full.rows[1].available === undefined && full.rows[1].stock === undefined && full.rows[1].discountPrice === undefined);
check("line numbers count the header as row 1", full.rows[0].line === 2 && full.rows[1].line === 3);

const noStock = parseCsv("id,price\nitem-1,250\n");
check("a column the sheet lacks stays undefined (never blanks it)", noStock.rows[0].stock === undefined && noStock.rows[0].name === undefined);

const clear = parseCsv("id,discount_price,stock,image_url\nitem-1,none,untracked,none\n");
check("'none' clears a discount, 'untracked' clears stock, 'none' clears a photo",
  clear.rows[0].discountPrice === null && clear.rows[0].stock === null && clear.rows[0].imageUrl === null);
check("0 as a discount also clears it", parseCsv("id,discount_price\nx,0\n").rows[0].discountPrice === null);

const bad = parseCsv("name,price,veg,stock,image_url\nA,abc,yes,5,\nB,100,maybe,5,\nC,100,yes,-3,\nD,100,yes,5,javascript:alert(1)\nE,100,yes,5,https://x.test/e.jpg\n");
check("only the good row survives", bad.rows.length === 1 && bad.rows[0].name === "E");
check("each bad row says what is wrong", bad.issues.length === 4 && bad.issues.some((i) => i.line === 2 && /price/.test(i.message)) && bad.issues.some((i) => /yes or no/.test(i.message)) && bad.issues.some((i) => /stock/.test(i.message)) && bad.issues.some((i) => /http/.test(i.message)));

check("a sheet with no id or name column is refused", parseCsv("price,stock\n1,2\n").issues[0]?.message.includes("id"));
check("an empty file is refused", parseSheetFile(new Uint8Array(0), "a.csv").issues[0]?.line === 0);
check("duplicate ids are flagged", parseCsv("id,price\na,1\nA,2\n").issues.some((i) => /twice/.test(i.message)));
check("a discount that is not below the price is flagged", parseCsv("name,price,discount_price\nA,100,100\n").issues.length === 1);
check("a row with nothing in it is just spacing", parseCsv("name,price\n,\nA,5\n").issues.length === 0);
check("unknown headers are listed and ignored", parseCsv("name,price,colour\nA,5,red\n").unknownColumns[0] === "colour");

const many = "name,price\n" + Array.from({ length: MAX_SHEET_ROWS + 20 }, (_, i) => `Dish ${i},10`).join("\n");
const capped = parseCsv(many);
check(`only the first ${MAX_SHEET_ROWS} rows are read`, capped.rows.length === MAX_SHEET_ROWS && capped.truncated);

// ---------- export, round trip ----------
const items = [
  { id: "=cmd", name: "-Odd name", category: "Mains", price: 100, discountPrice: 80, veg: true, available: true, stock: 3, lowStockAt: 1 },
  { id: "i2", name: 'Quote "x", y', category: "Mains", price: 50, veg: false, available: false, stock: null },
];
const csv = gridToCsv(templateGrid(items));
const back = parseCsv(csv);
check("a CSV we wrote reads back the same", back.rows.length === 2 && back.rows[0].price === 100 && back.rows[0].discountPrice === 80 && back.rows[1].name === 'Quote "x", y' && back.rows[1].available === false);
check("a cell that looks like a formula is guarded on export and unguarded on import", csv.includes("'=cmd") && back.rows[0].id === "=cmd" && back.rows[0].name === "-Odd name");
const xlsxRows = parseSheetFile(gridToXlsx(templateGrid(items)), "menu.xlsx");
check("an .xlsx we wrote reads back too", xlsxRows.rows.length === 2 && xlsxRows.rows[0].stock === 3 && xlsxRows.rows[1].veg === false);
const ex = parseCsv(gridToCsv(templateGrid(EXAMPLE_ITEMS)));
check("the template's own example rows are valid", ex.rows.length === 2 && ex.issues.length === 0);

// ---------- planning ----------
const dish = (o: Partial<ExistingDish> & { id: string; name: string }): ExistingDish => ({
  externalId: null, category: "Mains", price: 200, discountPrice: null, description: null, veg: true, available: true,
  popular: false, bestseller: false, imageUrl: null, stockQty: null, lowStockAt: null, ...o,
});
const UUID1 = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const menu = [
  dish({ id: UUID1, externalId: "item-1", name: "Paneer Tikka", category: "Starters", price: 220, stockQty: 10 }),
  dish({ id: UUID2, name: "Chicken Biryani", category: "Rice", price: 299 }),
  dish({ id: "33333333-3333-4333-8333-333333333333", name: "Dal", category: "Mains" }),
  dish({ id: "44444444-4444-4444-8444-444444444444", name: "Dal", category: "Sides" }),
];
const opts = { canCreate: true, allowed: OWNER_COLUMNS, hasInventory: true };
const plan = (csvText: string, o: Partial<typeof opts> & { allowed?: ReadonlySet<never> } = {}) => {
  const p = parseCsv(csvText);
  return planSheet(menu, p.rows, { ...opts, ...(o as object), sheetColumns: p.columns } as Parameters<typeof planSheet>[2]);
};

const stockOnly = plan("id,stock\nitem-1,25\n");
check("stock-only sheet changes stock and nothing else", stockOnly.items[0].action === "update" && Object.keys(stockOnly.items[0].patch!).join() === "stock_qty");
check("the plan says what changes in words", stockOnly.items[0].changes[0] === "stock 10 → 25");
check("the dish's own uuid finds it too", plan(`id,price\n${UUID2},320\n`).items[0].dishId === UUID2);
check("re-uploading the same value is 'unchanged', not an update", plan("id,price,stock\nitem-1,220,10\n").items[0].action === "unchanged");
check("a row with no id finds its dish by name", plan("name,price\nChicken Biryani,310\n").items[0].dishId === UUID2);
check("a name shared by two dishes is ambiguous without a category", plan("name,price\nDal,90\n").items[0].action === "error");
check("a category settles it", plan("name,category,price\nDal,Sides,90\n").items[0].dishId === "44444444-4444-4444-8444-444444444444");
check("a new name creates a dish", plan("name,price,veg\nGulab Jamun,80,yes\n").items[0].action === "create");
check("a new dish with a shop code keeps it", plan("id,name,price\nsku-9,Kheer,70\n").items[0].insert?.external_id === "sku-9");
check("a new dish needs a price", plan("name\nKheer\n").items[0].action === "error");
check("an unknown dish id (uuid) is an error, not a new dish", plan(`id,price\n99999999-9999-4999-8999-999999999999,5\n`).items[0].action === "error");
check("when creating is not allowed an unknown dish is an error", plan("name,price\nKheer,70\n", { canCreate: false }).items[0].action === "error");
check("a discount above the dish's price is an error", plan("id,discount_price\nitem-1,250\n").items[0].action === "error");
check("two rows for one dish: the second is refused", plan("name,category,price\nPaneer Tikka,Starters,230\nPaneer Tikka,Starters,240\n").counts.error === 1);
check("no stock columns in the database: a stock row is an error", plan("id,stock\nitem-1,5\n", { hasInventory: false }).items[0].action === "error");
check("a price-only sheet works without stock columns", plan("id,price\nitem-1,230\n", { hasInventory: false }).items[0].action === "update");
const noStockHere = plan("id,price\nitem-1,230\n");
check("counts add up", noStockHere.counts.update === 1 && noStockHere.counts.error === 0);

const mgr = (() => {
  const p = parseCsv("id,stock,price,available\nitem-1,40,999,no\n");
  return planSheet(menu, p.rows, { canCreate: false, allowed: MANAGER_COLUMNS, hasInventory: true, sheetColumns: p.columns });
})();
check("a manager's sheet changes stock only; price and availability are ignored",
  Object.keys(mgr.items[0].patch ?? {}).join() === "stock_qty" && mgr.ignoredColumns.includes("price") && mgr.ignoredColumns.includes("available"));
check("a manager cannot add dishes", planSheet(menu, parseCsv("name,stock\nNew,1\n").rows, { canCreate: false, allowed: MANAGER_COLUMNS, hasInventory: true, sheetColumns: ["name", "stock"] }).items[0].action === "error");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
