/**
 * Partial refunds (Phase 3 review #1): the arithmetic the refund decision uses
 * once an order can carry more than one refund — an unavailable item, then a
 * cancellation. Pure; the database rule (guard_refund_total, 0142) is proven
 * in scripts/qa/sql/migration-0142.mjs.
 *
 *   npx tsx scripts/qa/refund-partials.ts
 */
import { approvalExceedsTotal, gatewayRoomPaise, isFullyRefunded } from "../../src/lib/refunds/partials";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
}

console.log("\n── approving within the order total ──");
check("a first refund within the total is fine", !approvalExceedsTotal({ total: 420, approved: [], amount: 360 }));
check("an item refund then the rest of the total is fine", !approvalExceedsTotal({ total: 420, approved: [60], amount: 360 }));
check("more than was paid is refused", approvalExceedsTotal({ total: 420, approved: [60], amount: 361 }));
check("a second full refund is refused (the old double-approve race)", approvalExceedsTotal({ total: 420, approved: [420], amount: 420 }));

console.log("\n── what the gateway can still return ──");
check("nothing refunded yet: the whole capture", gatewayRoomPaise(42000, []) === 42000);
check("after a ₹60 refund: the rest", gatewayRoomPaise(42000, [6000]) === 36000);
check("never negative", gatewayRoomPaise(42000, [42000, 100]) === 0);

console.log("\n── when the order's payment reads refunded ──");
check("a partial refund leaves the order paid", !isFullyRefunded({ total: 420, approved: [60] }));
check("refunds adding up to the total mark it refunded", isFullyRefunded({ total: 420, approved: [60, 360] }));
check("a zero-total order is never 'refunded' by nothing", !isFullyRefunded({ total: 0, approved: [] }));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
