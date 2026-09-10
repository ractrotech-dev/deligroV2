/**
 * QA — the tracking map never invents where the food came from.
 *
 * When a shop has never been pinned, `order-tracking.ts` used to substitute a
 * synthetic marker: Bemetara's centre plus a fixed offset, re-placed 0.8 km away
 * at an angle hashed from the restaurant's UUID if that happened to land near
 * the customer. The customer then watched a route line drawn from that invented
 * point to their real address, and a rider pin interpolated along it.
 *
 * On this database 68 of 70 shops are unpinned, so that was very nearly every
 * order. A 70 km line across Chhattisgarh was drawn from a coordinate nobody
 * had ever set.
 *
 * `rider-position.ts` already refuses to assert more than it knows in two other
 * ways, both documented there: the estimated pin does not jitter, and it does
 * not walk onto the doorstep off a clock alone. An origin that was made up is
 * the same failure, so it now gets the same answer — nothing is drawn.
 *
 * The rule: a REAL signal still shows. A fresh GPS fix is a fact about where the
 * rider is and does not depend on knowing where they started, so it is still
 * rendered. Only the interpolation — which needs a start point — goes quiet.
 *
 * Pure functions, no I/O. Runs offline.
 *
 * Usage:
 *   npm run test:tracking-origin
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeRiderPosition } from "../../src/lib/tracking/rider-position";
import * as riderPosition from "../../src/lib/tracking/rider-position";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

const SHOP = { lat: 21.7156, lng: 81.5347 };
const DOOR = { lat: 21.7201, lng: 81.5389 };
const NOW = Date.parse("2026-09-10T10:00:00.000Z");
const PICKED_UP = new Date(NOW - 5 * 60_000).toISOString();

const base = {
  orderStatus: "on_the_way",
  deliveryStatus: "picked_up",
  assignedAt: PICKED_UP,
  pickedUpAt: PICKED_UP,
  destination: DOOR,
  storedRider: null,
  etaMinutes: 20,
  now: NOW,
};

console.log("\nTracking origin — no invented start point\n");

// ---------------------------------------------------------------------------
// The fabrication is gone entirely.
// ---------------------------------------------------------------------------
check(
  "restaurantPointForOrder no longer exists",
  !("restaurantPointForOrder" in riderPosition),
  "the synthetic marker is still exported — a dead alternate is how a second source of truth survives (AGENTS.md)"
);

// ---------------------------------------------------------------------------
// A pinned shop behaves exactly as before. This must not regress.
// ---------------------------------------------------------------------------
const pinned = computeRiderPosition({ ...base, restaurant: SHOP });
check(
  "pinned shop still interpolates a rider pin",
  pinned !== null,
  "got null — the fix must only affect UNPINNED shops"
);
check(
  "that pin sits between the shop and the door",
  pinned !== null &&
    pinned.lat >= Math.min(SHOP.lat, DOOR.lat) &&
    pinned.lat <= Math.max(SHOP.lat, DOOR.lat),
  `got ${JSON.stringify(pinned)}`
);

// ---------------------------------------------------------------------------
// An unpinned shop draws nothing rather than interpolating from a guess.
// ---------------------------------------------------------------------------
const unpinned = computeRiderPosition({ ...base, restaurant: null });
check(
  "unpinned shop yields NO estimated rider pin",
  unpinned === null,
  `got ${JSON.stringify(unpinned)} — interpolating needs a start point, and there isn't one`
);

const unpinnedToPickup = computeRiderPosition({
  ...base,
  restaurant: null,
  orderStatus: "ready",
  deliveryStatus: "assigned",
  pickedUpAt: null,
});
check(
  "unpinned shop yields no pin on the way to pickup either",
  unpinnedToPickup === null,
  `got ${JSON.stringify(unpinnedToPickup)} — that branch parks the pin ON the shop, which is the unknown point`
);

// ---------------------------------------------------------------------------
// A real GPS fix is a fact and survives regardless of the origin.
// ---------------------------------------------------------------------------
const FIX = { lat: 21.718, lng: 81.5361 };
const liveFix = computeRiderPosition({
  ...base,
  restaurant: null,
  storedRider: { ...FIX, at: new Date(NOW - 10_000).toISOString() },
});
check(
  "a FRESH GPS fix still renders with an unpinned shop",
  liveFix !== null && liveFix.lat === FIX.lat && liveFix.lng === FIX.lng,
  `got ${JSON.stringify(liveFix)} — where the rider is does not depend on knowing where they started`
);

const staleFix = computeRiderPosition({
  ...base,
  restaurant: null,
  storedRider: { ...FIX, at: new Date(NOW - 10 * 60_000).toISOString() },
});
check(
  "a STALE fix with an unpinned shop falls through to nothing",
  staleFix === null,
  `got ${JSON.stringify(staleFix)} — stale means fall back to the estimate, and there is no estimate without an origin`
);

// ---------------------------------------------------------------------------
// The payload type must admit the null, or callers cannot handle it.
// ---------------------------------------------------------------------------
const trackingSrc = read("src/lib/data-access/order-tracking.ts");

check(
  "order-tracking no longer imports the synthetic marker",
  !/restaurantPointForOrder/.test(trackingSrc),
  "still referenced in order-tracking.ts"
);
check(
  "the tracked payload types restaurant as nullable",
  /restaurant:\s*TrackPoint\s*\|\s*null/.test(trackingSrc),
  "restaurant is still a non-null TrackPoint, so an unpinned shop has nowhere to go but a fabrication"
);

const mapSrc = read("src/components/orders/tracking-map.tsx");
check(
  "the map accepts a null restaurant",
  /restaurant:\s*TrackPoint\s*\|\s*null/.test(mapSrc),
  "TrackingMap still demands a point, so it cannot render the unpinned case"
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
