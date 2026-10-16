/**
 * QA — the basket shape a client may send to /api/orders.
 * Offline. Usage:  npm run test:order-lines
 */
import { areValidOrderLines, MAX_ORDER_LINES, MAX_QTY_PER_LINE } from "../../src/lib/orders/validate-lines";

let failed = 0, passed = 0;
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}`); }
}
const line = (itemId: unknown, qty: unknown) => ({ itemId, qty });

check("a normal basket passes", areValidOrderLines([line("m1", 2), line("m2", 1)]));
check("max qty passes", areValidOrderLines([line("m1", MAX_QTY_PER_LINE)]));
check("max lines passes", areValidOrderLines(Array.from({ length: MAX_ORDER_LINES }, (_, i) => line("m" + i, 1))));
check("not an array fails", !areValidOrderLines("m1") && !areValidOrderLines(null) && !areValidOrderLines({}));
check("empty fails", !areValidOrderLines([]));
check("too many lines fails", !areValidOrderLines(Array.from({ length: MAX_ORDER_LINES + 1 }, (_, i) => line("m" + i, 1))));
check("fractional qty fails", !areValidOrderLines([line("m1", 1.5)]));
check("string qty fails", !areValidOrderLines([line("m1", "3")]));
check("zero and negative qty fail", !areValidOrderLines([line("m1", 0)]) && !areValidOrderLines([line("m1", -2)]));
check("int32-max qty fails", !areValidOrderLines([line("m1", 2147483647)]));
check("over-cap qty fails", !areValidOrderLines([line("m1", MAX_QTY_PER_LINE + 1)]));
check("NaN and Infinity fail", !areValidOrderLines([line("m1", Number.NaN)]) && !areValidOrderLines([line("m1", Infinity)]));
check("missing or non-string itemId fails", !areValidOrderLines([line(undefined, 1)]) && !areValidOrderLines([line(7, 1)]) && !areValidOrderLines([line("", 1)]));
check("oversized itemId fails", !areValidOrderLines([line("x".repeat(101), 1)]));
check("a non-object line fails", !areValidOrderLines(["m1"]) && !areValidOrderLines([null]));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
