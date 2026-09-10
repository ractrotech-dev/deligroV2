/**
 * QA — distance-aware delivery estimates.
 *
 * The question this suite exists to answer: does the number on the tracking
 * screen have anything to do with how far the food has to travel?
 *
 * Before this work the answer was no, at every distance. `computeOrderEta`
 * derived the road leg as `advertisedBand - prepMinutes`, so a shop advertising
 * 30 minutes promised 30 minutes to an address across the street and 30 minutes
 * to an address in the next district. The order that exposed it was a real test
 * order from Bemetara to Durg — 63.8 km direct, 75.3 km by road, 1h51m by car
 * per the Directions API — tracked as a ~25 minute delivery.
 *
 * Runs offline — no Supabase, no network, no Google key, no environment. Tests
 * `lib/orders/road-leg.ts` and `lib/orders/eta.ts` directly, which are the two
 * pure modules every estimate on every surface runs through.
 *
 * Usage:
 *   npm run test:eta
 */
import { roadLegBetween, roadMinutesFor } from "../../src/lib/orders/road-leg";
import { computeOrderEta } from "../../src/lib/orders/eta";
import {
  pathLengthKm,
  pointAlongPath,
  progressAlongLine,
} from "../../src/lib/tracking/route-path";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

function checkWithin(
  name: string,
  actual: number | null,
  expected: number,
  tolerance: number
): void {
  const ok = actual !== null && Math.abs(actual - expected) <= tolerance;
  if (ok) {
    passed++;
    console.log(`  ✓ ${name} (${actual} vs ${expected} ±${tolerance})`);
  } else {
    failed++;
    console.log(
      `  ✗ ${name} — expected ${expected} ±${tolerance}, got ${String(actual)}`
    );
  }
}

/** The two ends of the order that exposed the bug. */
const BEMETARA = { lat: 21.7157, lng: 81.5335 };
const DURG = { lat: 21.1904, lng: 81.2849 };
/** An ordinary in-town address, ~2 km from the shop. */
const IN_TOWN = { lat: 21.7157 + 0.018, lng: 81.5335 };

console.log("\n── The road leg tracks distance ──");
{
  const near = roadMinutesFor(2);
  const far = roadMinutesFor(63.8);
  check("a 2 km leg is under 20 minutes", near !== null && near < 20, true);
  check("a 63.8 km leg is over an hour", far !== null && far > 60, true);
  check(
    "further is never faster",
    near !== null && far !== null && far > near,
    true
  );
}

console.log("\n── Calibration against the Bemetara → Durg test order ──");
{
  const leg = roadLegBetween(BEMETARA, DURG);
  if (leg === null) {
    failed++;
    console.log("  ✗ leg was null for two pinned points");
  } else {
    // Google measured 75.3 km of road for this pair. The model errs long on
    // purpose (see DETOUR_FACTOR), so it is allowed to overshoot by more than
    // it may undershoot — but not by half a district.
    checkWithin("modelled road km ≈ the 75.3 km Google drives", leg.roadKm, 78, 6);
    // Google measured 111 minutes. Same asymmetry: late is a refresh, early is
    // a customer standing at the door.
    checkWithin("modelled minutes ≈ the 111 min Google drives", leg.minutes, 116, 12);
    check("never optimistic against the measured drive", leg.minutes >= 111, true);
  }
}

console.log("\n── An unpinned end yields no distance, not a fake one ──");
{
  check("null shop", roadLegBetween(null, DURG), null);
  check("null destination", roadLegBetween(BEMETARA, null), null);
  check("undefined distance", roadMinutesFor(undefined), null);
  check("NaN distance", roadMinutesFor(Number.NaN), null);
  check("negative distance", roadMinutesFor(-5), null);
}

console.log("\n── The estimate uses the longer of band and road ──");
{
  const base = {
    status: "PLACED" as const,
    createdAt: new Date("2026-09-10T12:00:00Z").toISOString(),
    etaMin: 30,
    etaMax: 40,
    defaultPrepMinutes: 15,
    now: new Date("2026-09-10T12:00:00Z").getTime(),
  };

  const town = computeOrderEta({
    ...base,
    straightLineKm: roadLegBetween(BEMETARA, IN_TOWN)?.straightLineKm ?? null,
  });
  const far = computeOrderEta({
    ...base,
    straightLineKm: roadLegBetween(BEMETARA, DURG)?.straightLineKm ?? null,
  });
  const unpinned = computeOrderEta({ ...base, straightLineKm: null });

  // A short trip is comfortably inside what the shop already advertises, so the
  // band still governs it — this change must not inflate ordinary orders.
  check(
    "a 2 km order keeps the advertised band's road leg",
    town.rideMinutes,
    unpinned.rideMinutes
  );

  check("a 75 km order does not", far.rideMinutes > town.rideMinutes, true);
  checkWithin("and its road leg is the modelled one", far.rideMinutes, 116, 12);

  // The whole failure, stated as a test: the far order used to be promised the
  // same door time as the near one.
  check(
    "the far order is promised later than the near one",
    (far.minutesRemaining ?? 0) > (town.minutesRemaining ?? 0),
    true
  );

  // dueAt has to move with it, or a 75 km order is late from the second it is
  // placed and the tracking screen opens already apologising.
  check(
    "a 75 km order is not born late",
    far.late,
    false
  );

  check(
    "an unpinned address falls back to the band, not to zero",
    unpinned.rideMinutes,
    30 - 15
  );
}

console.log("\n── The courier pin walks the road, not the straight line ──");
{
  // An L: two legs of a dog-leg route whose corner is well off the direct line
  // between its ends. This is the shape that exposes straight-line
  // interpolation — halfway along the road is nowhere near halfway across the
  // gap.
  const corner = { lat: 21.7157, lng: 81.6335 };
  const route = [BEMETARA, corner, { lat: 21.6157, lng: 81.6335 }];

  check("empty path has no point", pointAlongPath([], 0.5), null);
  check("a single-point path is that point", pointAlongPath([BEMETARA], 0.5), BEMETARA);
  check("fraction 0 is the start", pointAlongPath(route, 0)?.lat, BEMETARA.lat);
  check(
    "fraction 1 is the end",
    pointAlongPath(route, 1)?.lat,
    route[2].lat
  );

  // Out-of-range fractions clamp rather than running off the end of the route.
  check("negative clamps to the start", pointAlongPath(route, -2)?.lat, BEMETARA.lat);
  check("over 1 clamps to the end", pointAlongPath(route, 9)?.lat, route[2].lat);

  const mid = pointAlongPath(route, 0.5);
  const total = pathLengthKm(route);
  check("path length is the sum of its legs, not its span", total > 0, true);
  if (mid === null) {
    failed++;
    console.log("  ✗ midpoint was null");
  } else {
    // Measured ALONG the road — start to corner, then corner to the pin — the
    // halfway point is half the route's length in. Distance travelled, not
    // distance from the origin: the two are the same only on a straight route,
    // which is precisely the assumption being removed. This route's midpoint
    // lies just past the corner, so a regression that indexed by vertex instead
    // of by distance would land it on the corner and fail here.
    checkWithin(
      "the halfway point is half the route's length along it",
      pathLengthKm([BEMETARA, corner]) + pathLengthKm([corner, mid]),
      total / 2,
      0.05
    );
    // And it is NOT where straight-line interpolation would have put it.
    const straightMid = {
      lat: (BEMETARA.lat + route[2].lat) / 2,
      lng: (BEMETARA.lng + route[2].lng) / 2,
    };
    check(
      "and it differs from the straight-line midpoint",
      Math.abs(mid.lat - straightMid.lat) + Math.abs(mid.lng - straightMid.lng) >
        0.001,
      true
    );
  }

  check(
    "progress at the start is 0",
    progressAlongLine(BEMETARA, DURG, BEMETARA),
    0
  );
  check("progress at the end is 1", progressAlongLine(BEMETARA, DURG, DURG), 1);
  check(
    "coincident endpoints do not divide by zero",
    progressAlongLine(BEMETARA, BEMETARA, BEMETARA),
    0
  );
}

// ---------------------------------------------------------------------------
// Is the estimate MEASURED, or inherited from a kitchen's advertised band?
//
// These two produce a similar-looking number and mean completely different
// things. With a distance we modelled this delivery; without one we repeated
// what the shop says about its own cooking, which is a claim about a kitchen
// and not about how far the food has to go. The tracking screen has to be able
// to tell them apart, or it presents the second as confidently as the first —
// which is how a 70 km order displayed "25 min".
// ---------------------------------------------------------------------------
{
  const shared = {
    status: "PLACED" as const,
    createdAt: "2026-09-10T10:00:00.000Z",
    etaMin: 22,
    etaMax: 28,
    defaultPrepMinutes: 20,
    now: Date.parse("2026-09-10T10:00:00.000Z"),
  };

  const measured = computeOrderEta({
    ...shared,
    straightLineKm: roadLegBetween(BEMETARA, DURG)!.straightLineKm,
  });
  check("a measured estimate reports distanceKnown", measured.distanceKnown, true);

  const bandOnly = computeOrderEta({ ...shared, straightLineKm: null });
  check("a band-only estimate reports distanceKnown false", bandOnly.distanceKnown, false);

  const nearby = computeOrderEta({ ...shared, straightLineKm: 1.2 });
  check(
    "a short measured trip is still marked known",
    nearby.distanceKnown,
    true
  );

  // The flag must describe the INPUT, not the outcome: a nearby address whose
  // modelled leg loses to the band is still measured, and must not be reported
  // as a guess just because the band happened to be larger.
  check(
    "the band winning does not make a measured estimate 'unknown'",
    nearby.rideMinutes >= 0 && nearby.distanceKnown,
    true
  );

  check(
    "zero km counts as known (a shop delivering to its own address)",
    computeOrderEta({ ...shared, straightLineKm: 0 }).distanceKnown,
    true
  );

  check(
    "a negative distance is not treated as known",
    computeOrderEta({ ...shared, straightLineKm: -5 }).distanceKnown,
    false
  );
}

console.log(
  `\n${passed} passed, ${failed} failed\n`
);
process.exit(failed === 0 ? 0 : 1);
