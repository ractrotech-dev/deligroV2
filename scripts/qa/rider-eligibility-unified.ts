/**
 * One eligibility rule for dispatch, the manager's rider picker and the live
 * rules (Phase 3 review #3). `riderIneligibility` (src/lib/dispatch/eligibility.ts)
 * decides; dispatch's `eligibleCandidates` and the picker's `riderEligibility`
 * are thin callers, so they can never disagree. The database repeats it in
 * `_ops_rider_ineligible` (0142), proven by scripts/qa/sql/migration-0142.mjs.
 *
 *   npx tsx scripts/qa/rider-eligibility-unified.ts
 */
import {
  canOverride,
  eligibleCandidates,
  riderIneligibility,
  type EligibilityFacts,
} from "../../src/lib/dispatch/eligibility";
import { riderEligibility } from "../../src/lib/ops/live-rules";

const now = new Date("2026-10-21T10:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
}

const rider = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  isOnline: true,
  breakUntil: null,
  onlineSince: ago(3_600_000),
  lastFixAt: ago(10_000),
  suspended: false,
  zoneIds: ["Z1"],
  ...over,
});
const ctx = { orderZoneId: "Z1", currentRiderId: null };

console.log("\n── the reasons, in the order the picker explains them ──");
check("eligible", riderIneligibility("r", rider(), ctx, now) === null);
check("offline", riderIneligibility("r", rider({ isOnline: false }), ctx, now) === "offline");
check("on a break", riderIneligibility("r", rider({ breakUntil: ahead(60_000) }), ctx, now) === "on_break");
check("no fix", riderIneligibility("r", rider({ lastFixAt: null }), ctx, now) === "stale_fix");
check("fix older than 5 minutes", riderIneligibility("r", rider({ lastFixAt: ago(5 * 60_000 + 1) }), ctx, now) === "stale_fix");
check("fix from a clock running ahead", riderIneligibility("r", rider({ lastFixAt: ahead(10 * 60_000) }), ctx, now) === "stale_fix");
check("suspended", riderIneligibility("r", rider({ suspended: true }), ctx, now) === "suspended");
check("another zone", riderIneligibility("r", rider({ zoneIds: ["Z2"] }), ctx, now) === "out_of_zone");
check("no zone at all", riderIneligibility("r", rider({ zoneIds: [] }), ctx, now) === "out_of_zone");
check("an order with no zone is nobody's zone", riderIneligibility("r", rider(), { orderZoneId: null, currentRiderId: null }, now) === "out_of_zone");
check("zones not known (undefined) are not checked", riderIneligibility("r", rider({ zoneIds: [] }), { orderZoneId: undefined, currentRiderId: null }, now) === null);
check("already on it", riderIneligibility("r", rider(), { orderZoneId: "Z1", currentRiderId: "r" }, now) === "current_rider");

console.log("\n── dispatch and the picker ask the same rule ──");
const facts = new Map<string, EligibilityFacts>([
  ["ok", rider()],
  ["stale", rider({ lastFixAt: ago(6 * 60_000) })],
  ["far", rider({ zoneIds: ["Z2"] })],
]);
const picked = eligibleCandidates([{ id: "ok" }, { id: "stale" }, { id: "far" }], facts, now, { orderZoneId: "Z1" }).map((r) => r.id);
check("dispatch keeps only the eligible rider of the order's zone", JSON.stringify(picked) === JSON.stringify(["ok"]));
for (const [id, f] of facts) {
  const pick = riderEligibility(
    { id, ...f, lat: null, lng: null, activeDeliveries: 0 },
    { orderZoneId: "Z1", currentRiderId: null, shop: null },
    now
  );
  check(`picker agrees for ${id}`, (pick.ineligibleReason ?? null) === riderIneligibility(id, f, { orderZoneId: "Z1", currentRiderId: null }, now));
}

console.log("\n── what a manager may override ──");
check("offline, on a break and no fresh fix can be overridden", canOverride("offline") && canOverride("on_break") && canOverride("stale_fix"));
check("out of zone, suspended and the same rider cannot", !canOverride("out_of_zone") && !canOverride("suspended") && !canOverride("current_rider"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
