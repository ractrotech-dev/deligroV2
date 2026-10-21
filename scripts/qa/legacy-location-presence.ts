/**
 * The web rider portal's old location route keeps a rider assignable (Phase 3
 * review #3): `/api/driver/location` must stamp `rider_status.last_fix_at`
 * through `recordRiderFix`, the same writer `/api/rider/location` uses, or every
 * rider still on the old client reads `stale_fix` to the manager's picker and
 * to dispatch.
 *
 *   npx tsx scripts/qa/legacy-location-presence.ts
 */
import { readFileSync } from "node:fs";

const route = readFileSync("src/app/api/driver/location/route.ts", "utf8");
let failed = 0;
const check = (name: string, cond: boolean) => {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
};

check("the legacy route records the fix through recordRiderFix", /recordRiderFix\(/.test(route));
check("...and no longer writes only the delivery row", !/reportDriverLocation\(/.test(route));
check("a presence write that fails still answers with the delivery result", /presence_failed/.test(route));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
