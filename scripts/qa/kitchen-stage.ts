/**
 * QA — the Partner app's order stages.
 *
 * The database has one `kitchen` status for "accepted" and "preparing" (0061
 * tells them apart by `preparing_at`), and calls an order the kitchen has
 * finished `on_the_way` or `delivered`. The app, the dashboard and the reports
 * must all agree on which of the client's six statuses an order is in, so the
 * mapping is one pure function, tested here.
 *
 * Runs offline. Usage: npx tsx scripts/qa/kitchen-stage.ts
 */
import { kitchenStage, parsePrepMinutes } from "../../src/lib/orders/kitchen-stage";

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

const at = "2026-10-21T10:00:00Z";

console.log("\n═══ Six statuses from the database's five + preparing_at ═══");
check("placed → new", kitchenStage({ status: "placed" }), "new");
check("kitchen, not started → accepted", kitchenStage({ status: "kitchen", preparingAt: null }), "accepted");
check("kitchen, started → preparing", kitchenStage({ status: "kitchen", preparingAt: at }), "preparing");
check("ready → ready", kitchenStage({ status: "ready" }), "ready");
check("on_the_way → completed (the kitchen's part is done)", kitchenStage({ status: "on_the_way" }), "completed");
check("delivered → completed", kitchenStage({ status: "delivered" }), "completed");
check("cancelled → cancelled", kitchenStage({ status: "cancelled", preparingAt: at }), "cancelled");
check("an unknown status is not guessed into a stage", kitchenStage({ status: "lost" }), null);
check("preparing_at on a ready order does not drag it back", kitchenStage({ status: "ready", preparingAt: at }), "ready");

console.log("\n═══ Prep time from an untrusted body ═══");
check("20 → 20", parsePrepMinutes(20), 20);
check("1 is the floor", parsePrepMinutes(1), 1);
check("180 is the ceiling", parsePrepMinutes(180), 180);
check("0 is refused", parsePrepMinutes(0), null);
check("181 is refused", parsePrepMinutes(181), null);
check("a fraction is refused, not rounded", parsePrepMinutes(12.5), null);
check("a numeric string is refused (bodies are typed)", parsePrepMinutes("20"), null);
check("absent → null", parsePrepMinutes(undefined), null);
check("NaN → null", parsePrepMinutes(Number.NaN), null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
