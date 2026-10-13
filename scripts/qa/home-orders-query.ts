/**
 * QA — Home reads one in-flight order, not the order history.
 *
 * `getActiveOrderForHome` replaced a read of up to 101 full orders with a read
 * of one. The saving only counts if the narrower query keeps what the wide one
 * guaranteed, so this pins, offline and structurally:
 *   - Home asks for the active order only, never the full orders page;
 *   - the query stays scoped to the signed-in account (`customer_id`), never
 *     the operator-wide list;
 *   - the statuses are the same list the Orders tab calls "active";
 *   - it asks for one row, newest first.
 *
 * Usage: npm run test:home-orders
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (f: string) =>
  readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

const page = read("src/app/(customer)/page.tsx");
const ui = read("src/lib/orders-ui.ts");
const orders = read("src/lib/data-access/orders.ts");

console.log("\n═══ Home page ═══");
check("Home uses getActiveOrderForHome", /getActiveOrderForHome\(\)/.test(page), true);
check("Home no longer reads the full orders page", /getOrdersPageData/.test(page), false);

console.log("\n═══ the narrow read ═══");
const start = ui.indexOf("export async function getActiveOrderForHome");
const fn = ui.slice(start, ui.indexOf("\n}\n", start) + 3);
check("getActiveOrderForHome exists exactly once", ui.split("export async function getActiveOrderForHome").length - 1, 1);
check("it reads through listMyOrders (the account's own orders)", /listMyOrders\(/.test(fn), true);
check("it never uses the operator-wide list", /listVisibleOrders/.test(fn), false);
check("it passes the shared ACTIVE_DB_STATUSES", /statuses:\s*ACTIVE_DB_STATUSES/.test(fn), true);
check("it asks for one row", /limit:\s*1\b/.test(fn), true);
check("a signed-out visitor gets null without a query", /if \(!profile\) return null/.test(fn), true);
check("a failed read is logged and shown as no active order", /catch \(err\)[\s\S]*return null/.test(fn), true);

console.log("\n═══ listMyOrders ═══");
const lm = orders.slice(orders.indexOf("export async function listMyOrders"));
check("still filters to the signed-in customer", /\.eq\("customer_id", user\.id\)/.test(lm), true);
check("applies the status filter with .in()", /options\.statuses\?\.length[\s\S]{0,80}\.in\("status"/.test(lm), true);
check("still newest first", /\.order\("created_at", \{ ascending: false \}\)/.test(lm), true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
