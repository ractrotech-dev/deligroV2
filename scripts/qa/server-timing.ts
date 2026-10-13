/**
 * QA — the Server-Timing header value.
 * Usage: npm run test:server-timing
 */
import { serverTimingHeader } from "../../src/lib/obs/server-timing";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

check("one metric", serverTimingHeader([["proxy", 12.34]]), "proxy;dur=12.3");
check(
  "several metrics share one header, comma-separated",
  serverTimingHeader([["proxy", 50], ["session", 31.25]]),
  "proxy;dur=50.0, session;dur=31.3"
);
check("no metrics is an empty string", serverTimingHeader([]), "");
check("a negative duration is dropped", serverTimingHeader([["a", -1], ["b", 2]]), "b;dur=2.0");
check("NaN and Infinity are dropped", serverTimingHeader([["a", NaN], ["b", Infinity], ["c", 1]]), "c;dur=1.0");
check("a name that is not a header token is dropped", serverTimingHeader([["user id", 5], ["a;b", 5], ["ok", 5]]), "ok;dur=5.0");
check("zero is a valid duration", serverTimingHeader([["proxy", 0]]), "proxy;dur=0.0");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
