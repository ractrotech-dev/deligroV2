/**
 * QA — applying a menu sheet to a shop, against a fake database client: what is
 * written by `apply`, that `preview` writes nothing, and the pre-0062 fallback.
 * The module is `server-only`, so run with the react-server condition:
 *   npx tsx --conditions=react-server scripts/qa/bulk-menu-apply.ts
 */
import { runOwnerSheet } from "../../src/lib/data-access/bulk-menu";
import { gridToCsv, templateGrid } from "../../src/lib/bulk/menu-sheet";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const SHOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";

interface Write { kind: "update" | "insert"; table: string; payload: unknown; eq: [string, unknown][] }

function fakeDb(opts: { stockColumns: boolean; failUpdateFor?: string }) {
  const writes: Write[] = [];
  const dishes = [
    { id: D1, external_id: "item-1", name: "Paneer Tikka", category: "Starters", price: 220, discount_price: null, description: null, veg: true, available: true, popular: false, bestseller: false, image_url: null, stock_qty: 10, low_stock_at: 2 },
    { id: D2, external_id: null, name: "Dal", category: "Mains", price: 150, discount_price: null, description: null, veg: true, available: true, popular: false, bestseller: false, image_url: null, stock_qty: null, low_stock_at: null },
  ];
  const db = {
    from(table: string) {
      return {
        select(columns: string) {
          const res = () => {
            if (columns.includes("stock_qty") && !opts.stockColumns) return { data: null, error: { code: "42703", message: "column does not exist" } };
            const rows = dishes.map((d) => (opts.stockColumns ? d : { ...d, stock_qty: undefined, low_stock_at: undefined }));
            return { data: rows, error: null };
          };
          const chain: Record<string, unknown> = {
            eq: () => chain, order: () => chain, range: () => Promise.resolve(res()),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(res()).then(resolve),
          };
          return chain;
        },
        update(patch: unknown) {
          const eq: [string, unknown][] = [];
          const chain: Record<string, unknown> = {
            eq: (c: string, v: unknown) => { eq.push([c, v]); return chain; },
            then: (resolve: (v: unknown) => unknown) => {
              writes.push({ kind: "update", table, payload: patch, eq });
              const failed = opts.failUpdateFor && eq.some(([, v]) => v === opts.failUpdateFor);
              return Promise.resolve({ error: failed ? { message: "db error with secret detail" } : null }).then(resolve);
            },
          };
          return chain;
        },
        insert(rows: unknown) {
          writes.push({ kind: "insert", table, payload: rows, eq: [] });
          return { select: () => Promise.resolve({ data: (rows as unknown[]).map((_, i) => ({ id: `new-${i}` })), error: null }) };
        },
      };
    },
  };
  return { db: db as never, writes };
}

const csv = (rows: (string | number)[][]) => new TextEncoder().encode(gridToCsv(rows));
const run = (f: ReturnType<typeof fakeDb>, rows: (string | number)[][], mode: "preview" | "apply") =>
  runOwnerSheet({ db: f.db, restaurantId: SHOP, bytes: csv(rows), filename: "m.csv", mode });

async function main() {
const sheet = [
  ["id", "name", "price", "stock"],
  ["item-1", "", 249, 25],
  [D2, "", 150, ""],            // unchanged
  ["", "Gulab Jamun", 80, 12],  // new
  [D1.replace("1111", "9999"), "", 5, ""], // unknown uuid: error
];

{
  const f = fakeDb({ stockColumns: true });
  const preview = await run(f, sheet, "preview");
  check("preview writes nothing", f.writes.length === 0);
  check("preview counts: 1 update, 1 create, 1 unchanged, 1 error", preview.counts.update === 1 && preview.counts.create === 1 && preview.counts.unchanged === 1 && preview.counts.error === 1);
  check("preview lists what changes in words", preview.items.find((i) => i.action === "update")?.changes.join() === "price 220 → 249,stock 10 → 25");
  check("preview never shows the patch or the insert", JSON.stringify(preview).includes("patch") === false && JSON.stringify(preview).includes("insert") === false);
  check("preview is not 'applied'", preview.applied === undefined && preview.mode === "preview");
}

{
  const f = fakeDb({ stockColumns: true });
  const done = await run(f, sheet, "apply");
  const upd = f.writes.find((w) => w.kind === "update");
  const ins = f.writes.find((w) => w.kind === "insert");
  check("apply updates the matched dish by id inside this shop only", !!upd && JSON.stringify(upd.payload) === JSON.stringify({ price: 249, stock_qty: 25 }) && upd.eq.some(([c, v]) => c === "id" && v === D1) && upd.eq.some(([c, v]) => c === "restaurant_id" && v === SHOP));
  check("apply inserts the new dish for this shop", !!ins && (ins.payload as { restaurant_id: string; name: string }[])[0].restaurant_id === SHOP && (ins.payload as { name: string }[])[0].name === "Gulab Jamun");
  check("apply reports created, updated and failed", done.applied?.created === 1 && done.applied.updated === 1 && done.applied.failed === 1);
  check("apply writes once per changed dish, nothing for the unchanged one", f.writes.filter((w) => w.kind === "update").length === 1);
}

{
  const f = fakeDb({ stockColumns: true, failUpdateFor: D1 });
  const done = await run(f, [["id", "price"], ["item-1", 300]], "apply");
  check("a failed write is counted and named, without the database's own text", done.applied?.failed === 1 && done.applied.updated === 0 && !JSON.stringify(done).includes("secret"));
}

{
  const f = fakeDb({ stockColumns: false });
  const priceOnly = await run(f, [["id", "price"], ["item-1", 260]], "apply");
  check("before the stock columns exist, a price sheet still applies", priceOnly.applied?.updated === 1);
  const stockRow = await run(f, [["id", "stock"], ["item-1", 5]], "preview");
  check("before the stock columns exist, a stock row is refused with a reason", stockRow.counts.error === 1 && /not available/.test(stockRow.items[0].message ?? ""));
}

{
  const f = fakeDb({ stockColumns: true });
  const out = await run(f, [["price", "stock"], [1, 2]], "preview");
  check("a sheet with no id or name is answered with an issue, not a crash", out.issues[0]?.line === 1 && out.counts.update === 0);
  const garbage = await runOwnerSheet({ db: f.db, restaurantId: SHOP, bytes: new Uint8Array([0, 1, 2, 3, 255, 254]), filename: "x.xlsx", mode: "preview" });
  check("a file that is not a spreadsheet is answered, not thrown", garbage.issues.length > 0 && garbage.items.length === 0);
}

void templateGrid;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
}

main();
