/**
 * QA — the delivery-area gate fails CLOSED.
 *
 * `checkServiceArea` used to answer `unknown` for three unrelated situations —
 * no radius configured, an unpinned shop, an address with no pin — and
 * `createOrder` refused only `out_of_range`. So `unknown` was an accept.
 *
 * On this database that meant 68 of 70 shops had never been pinned and every
 * one of them accepted orders from any distance on earth: a 70 km order was
 * taken, priced at the flat delivery fee, and a rider was dispatched on it.
 * That is AGENTS.md rule 2 exactly — "a failed config check must reduce access,
 * never widen it" — and a missing pin is a failed config check.
 *
 * The fix is to stop conflating the three. "No radius configured" is an admin
 * DECISION and still permits everything; "we cannot measure this" is a failure
 * and now refuses. The two must never collapse back into one state, which is
 * what these tests hold in place.
 *
 * `blocksOrder` is the single predicate both callers use — the order API that
 * refuses and the checkout that greys out the button. They were separate
 * `status === "out_of_range"` comparisons before, which is two copies of a rule
 * that must never disagree. See the module's own opening comment.
 *
 * Pure functions, no I/O. Runs offline.
 *
 * Usage:
 *   npm run test:service-area
 */
import {
  blocksOrder,
  checkServiceArea,
  outOfRangeMessage,
} from "../../src/lib/geo/service-area";

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

// Bemetara (the platform's pinned city) and Durg — the real 70 km pair from the
// order that exposed this.
const BEMETARA = { lat: 21.7156, lng: 81.5347 };
const DURG = { lat: 21.2251, lng: 81.306 };
const NEARBY = { lat: 21.7201, lng: 81.5389 };

console.log("\nDelivery area — fails closed\n");

// ---------------------------------------------------------------------------
// A configured radius, both ends known: the ordinary measurable cases.
// ---------------------------------------------------------------------------
const near = checkServiceArea({ shop: BEMETARA, destination: NEARBY, radiusKm: 8 });
check("nearby address is in range", near.status === "in_range", `got ${near.status}`);
check("in-range order is not blocked", !blocksOrder(near));

const far = checkServiceArea({ shop: BEMETARA, destination: DURG, radiusKm: 8 });
check(
  "70 km address is out of range",
  far.status === "out_of_range",
  `got ${far.status} at ${far.distanceKm?.toFixed(1)} km`
);
check("out-of-range order is blocked", blocksOrder(far));

// ---------------------------------------------------------------------------
// No radius configured. An admin DECISION, not a failure — still permits.
// ---------------------------------------------------------------------------
const noLimit = checkServiceArea({ shop: BEMETARA, destination: DURG, radiusKm: 0 });
check(
  "radius 0 is 'unlimited', not 'unverifiable'",
  noLimit.status === "unlimited",
  `got ${noLimit.status} — 0 means the admin set no limit, which is a choice, not a missing pin`
);
check("radius 0 does not block an order", !blocksOrder(noLimit));

const noLimitNoPin = checkServiceArea({ shop: null, destination: DURG, radiusKm: 0 });
check(
  "radius 0 still permits even with an unpinned shop",
  noLimitNoPin.status === "unlimited" && !blocksOrder(noLimitNoPin),
  `got ${noLimitNoPin.status} — with no radius there is nothing to verify against, so a missing pin cannot fail a check that is not being made`
);

// ---------------------------------------------------------------------------
// A radius IS set and we cannot measure. This is the fail-closed half.
// ---------------------------------------------------------------------------
const unpinnedShop = checkServiceArea({ shop: null, destination: DURG, radiusKm: 8 });
check(
  "unpinned shop with a radius set is 'unverifiable'",
  unpinnedShop.status === "unverifiable",
  `got ${unpinnedShop.status}`
);
check(
  "unverifiable names the shop as the reason",
  unpinnedShop.reason === "shop_unpinned",
  `got ${unpinnedShop.reason}`
);
check(
  "unpinned shop BLOCKS the order (was the 70 km bug)",
  blocksOrder(unpinnedShop),
  "an unmeasurable range check must refuse, not accept"
);

const unpinnedShopCoords = checkServiceArea({
  shop: { lat: null, lng: null },
  destination: DURG,
  radiusKm: 8,
});
check(
  "a shop row with null lat/lng counts as unpinned",
  unpinnedShopCoords.status === "unverifiable" && blocksOrder(unpinnedShopCoords),
  `got ${unpinnedShopCoords.status} — this is the shape the database actually returns`
);

const unpinnedAddress = checkServiceArea({
  shop: BEMETARA,
  destination: null,
  radiusKm: 8,
});
check(
  "address with no pin is 'unverifiable'",
  unpinnedAddress.status === "unverifiable",
  `got ${unpinnedAddress.status}`
);
check(
  "unverifiable names the address as the reason",
  unpinnedAddress.reason === "address_unpinned",
  `got ${unpinnedAddress.reason}`
);
check("address with no pin blocks the order", blocksOrder(unpinnedAddress));

// ---------------------------------------------------------------------------
// `unknown` must be gone: leaving it reachable is how the accept creeps back.
// ---------------------------------------------------------------------------
const everyStatus = [
  near, far, noLimit, noLimitNoPin, unpinnedShop, unpinnedAddress,
].map((a) => a.status);
check(
  "no case returns the old catch-all 'unknown'",
  !everyStatus.includes("unknown" as never),
  `got: ${everyStatus.join(", ")}`
);

// ---------------------------------------------------------------------------
// Whatever we refuse, we must be able to say why.
// ---------------------------------------------------------------------------
for (const [label, area] of [
  ["out of range", far],
  ["unpinned shop", unpinnedShop],
  ["unpinned address", unpinnedAddress],
] as const) {
  const msg = outOfRangeMessage(area);
  check(
    `${label}: refusal message is non-empty and mentions no NaN/undefined`,
    msg.length > 0 && !/NaN|undefined|null/.test(msg),
    `got: "${msg}"`
  );
}

check(
  "the shop-unpinned message does not blame the customer's address",
  !/your address|this address/i.test(outOfRangeMessage(unpinnedShop)),
  `got: "${outOfRangeMessage(unpinnedShop)}" — the shop is the one missing a pin`
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
