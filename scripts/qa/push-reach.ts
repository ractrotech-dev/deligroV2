/**
 * QA — reading OneSignal's create-notification answer: did the push reach
 * anyone? The answers below are what OneSignal actually returned (2026-10-27).
 * A wrong "nobody" sends the player-id fallback too, and the customer gets
 * every order update twice.
 * Usage: npx tsx scripts/qa/push-reach.ts
 */
import { pushReached } from "../../src/lib/notifications/push-body";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

check("delivered, no errors", pushReached({ id: "b55917b1-11f4-489a-85a0-3f04236dccf6", external_id: null }));
// The person has an old unsubscribed install next to the live one: the live
// one gets it, and the alias is still listed as invalid.
check(
  "delivered with invalid_aliases (an old install beside the live one) still counts",
  pushReached({
    id: "9c4df56c-3fd6-44ce-9ffc-438c2f1a06dd",
    external_id: null,
    errors: { invalid_aliases: { external_id: ["claude-debug-emulator-1027"] } },
  })
);
check("nobody subscribed: empty id", !pushReached({ id: "", errors: ["All included players are not subscribed"] }));
check("no id at all", !pushReached({ errors: ["All included players are not subscribed"] }));
check("unreadable body", !pushReached(null));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
