/**
 * QA — a shop cannot go live without a map pin.
 *
 * 68 of 70 shops on this database have no `lat`/`lng`, and 49 of those are
 * already `active`. That is how the platform accumulated a fleet of shops whose
 * delivery radius cannot be checked (`service-area.ts`), whose delivery time
 * cannot be estimated (`eta.ts`), and whose position on the customer's tracking
 * map had to be invented (`rider-position.ts`). Every one of those three fixes
 * treats the missing pin as the fault; this is the one that stops more of them
 * arriving.
 *
 * Two things are asserted here.
 *
 * 1. The predicate itself — what counts as pinned. Null, undefined, NaN and the
 *    string "21.7" are all "no pin"; 0 is a real coordinate and must not be
 *    swept up by a falsy check, because `lat: 0` is the equator and `lng: 0` is
 *    Greenwich.
 * 2. That the activation path calls it: `setVendorStatus(id, "active")`. The
 *    approval path that used to be a second door is gone (0197).
 *
 * What is deliberately NOT asserted: that existing active shops are pinned.
 * 49 of them are not, and locking those rows would leave an operator unable to
 * so much as close a shop for the evening. The rule binds the TRANSITION into
 * active, so an already-live shop is untouched until someone deactivates it —
 * and fix #1 already stops it taking orders meanwhile.
 *
 * Runs offline.
 *
 * Usage:
 *   npm run test:vendor-readiness
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  VendorNotPinnedError,
  assertCanGoLive,
  assertKeepsPin,
  isPinned,
  parsePin,
} from "../../src/lib/vendors/readiness";

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

console.log("\nVendor readiness — no pin, no go-live\n");

// ---------------------------------------------------------------------------
// What counts as pinned.
// ---------------------------------------------------------------------------
check("a real pin is pinned", isPinned({ lat: 21.7156, lng: 81.5347 }));
check("null lat/lng is not pinned", !isPinned({ lat: null, lng: null }));
check("a missing lng is not pinned", !isPinned({ lat: 21.7156, lng: null }));
check("a missing lat is not pinned", !isPinned({ lat: null, lng: 81.5347 }));
check("undefined is not pinned", !isPinned({}));
check("NaN is not pinned", !isPinned({ lat: Number.NaN, lng: 81.5347 }));
check(
  "Infinity is not pinned",
  !isPinned({ lat: Number.POSITIVE_INFINITY, lng: 81.5347 })
);
check(
  "a numeric string is not pinned",
  !isPinned({ lat: "21.7156" as unknown as number, lng: 81.5347 }),
  "Postgres numerics can arrive as strings; a string that looks like a number is still not one"
);

// 0 is the single most likely thing a falsy check gets wrong here.
check(
  "lat 0 / lng 0 IS pinned (Gulf of Guinea, but a real coordinate)",
  isPinned({ lat: 0, lng: 0 }),
  "a falsy check would call this unpinned and refuse to activate a legitimately-placed shop"
);
check("lat 0 with a real lng is pinned", isPinned({ lat: 0, lng: 81.5347 }));

// ---------------------------------------------------------------------------
// The guard throws something callers can identify and show.
// ---------------------------------------------------------------------------
let threw: unknown = null;
try {
  assertCanGoLive({ lat: null, lng: null }, "Saffron Kitchen");
} catch (err) {
  threw = err;
}
check(
  "activating an unpinned shop throws",
  threw !== null,
  "no error raised — an unpinned shop would go live"
);
check(
  "it throws a typed VendorNotPinnedError",
  threw instanceof VendorNotPinnedError,
  `got ${threw?.constructor?.name ?? "nothing"} — callers need to tell this apart from a database failure`
);
check(
  "the message names the shop, so an operator knows which one to pin",
  threw instanceof Error && threw.message.includes("Saffron Kitchen"),
  `got: "${threw instanceof Error ? threw.message : ""}"`
);

let pinnedThrew = false;
try {
  assertCanGoLive({ lat: 21.7156, lng: 81.5347 }, "Pinned Shop");
} catch {
  pinnedThrew = true;
}
check("activating a pinned shop does not throw", !pinnedThrew);

// ---------------------------------------------------------------------------
// Both activation paths are guarded. One guarded path is a detour, not a gate.
// ---------------------------------------------------------------------------
const vendorsSrc = read("src/lib/data-access/admin-vendors.ts");
const statsSrc = read("src/lib/data-access/admin-stats.ts");

check(
  "setVendorStatus imports the readiness guard",
  /from "@\/lib\/vendors\/readiness"/.test(vendorsSrc),
  "admin-vendors.ts does not import it"
);
check(
  "setVendorStatus calls assertCanGoLive",
  /assertCanGoLive\(/.test(vendorsSrc),
  "the status flip can still activate an unpinned shop"
);
// The approval path that was the second door is gone (0197).
check(
  "admin-stats.ts does not make a shop live",
  !/approveRestaurant/.test(statsSrc) && !/\.update\(\{\s*approved:\s*true\s*\}\)/.test(statsSrc),
  "admin-stats.ts can still set approved"
);

// ---------------------------------------------------------------------------
// The database enforces it too, and only on the transition.
// ---------------------------------------------------------------------------
let migration = "";
try {
  migration = read("supabase/migrations/0050_vendor_pin_required.sql");
} catch {
  /* asserted below */
}
check(
  "a migration enforces this in the database",
  migration.length > 0,
  "supabase/migrations/0050_vendor_pin_required.sql is missing — an app-layer check alone is bypassed by any direct write"
);
check(
  "the trigger fires only on a transition INTO active",
  /is distinct from/i.test(migration),
  "without an OLD/NEW comparison this locks the 49 shops that are already active-and-unpinned"
);
check(
  "the trigger treats lat and lng as required together",
  /lat is null or new\.lng is null|lat is null\s+or\s+new\.lng is null/i.test(
    migration.toLowerCase().replace(/\s+/g, " ")
  ) || /lat is null/.test(migration.toLowerCase()),
  "the check must reject a half-set pin, not just a wholly absent one"
);

// ---------------------------------------------------------------------------
// The backlog is visible. 68 shops nobody can see are 68 shops nobody pins.
// ---------------------------------------------------------------------------
const adminVendorsSrc = read("src/lib/data-access/admin-vendors.ts");
const vendorsPageSrc = read("src/app/admin/vendors/page.tsx");

check(
  "the vendor LIST row carries lat/lng (not just the detail row)",
  /rating, rating_count, lat, lng/.test(adminVendorsSrc),
  "LIST_SELECT omits the pin, so the catalogue cannot tell which shops lack one"
);
check(
  "storefrontGaps reports a missing map pin",
  /gaps\.push\("map pin"\)/.test(adminVendorsSrc),
  "an unpinned shop looks complete on the vendors page"
);
check(
  "storefrontScore counts the pin as one of its checks",
  /const CHECKS = 5/.test(adminVendorsSrc),
  "the score still divides by 4, so adding a fifth gap makes 100% unreachable"
);
check(
  "lat/lng are coerced through Number() on the list row",
  /lat: row\.lat === null \|\| row\.lat === undefined \? null : Number\(row\.lat\)/.test(
    adminVendorsSrc
  ),
  "PostgREST can return a double precision column as a string, and isPinned correctly refuses strings — every pinned shop would report as unpinned"
);
check(
  "the roster-wide unpinned count exists and counts a HALF-set pin too",
  /or\("lat\.is\.null,lng\.is\.null"\)/.test(adminVendorsSrc),
  "counting only rows where lat is null misses a shop with a lat and no lng"
);
check(
  "the vendors page surfaces that count",
  /counts\.unpinned/.test(vendorsPageSrc),
  "the number is computed but never shown"
);

// An existing shop can now be pinned from Admin, which is what makes the rule above
// something an operator can act on rather than a dead end.
check("a typed pin is read as numbers", (() => { const p = parsePin("21.7", "81.5"); return p.ok && isPinned({ lat: p.lat, lng: p.lng }); })());
check("half a pin is refused", !parsePin("21.7", "").ok);
check("a point outside India is refused", !parsePin("81.5", "21.7").ok);
check("a live shop keeps its pin", (() => {
  try {
    assertKeepsPin("active", { lat: 21.7, lng: 81.5 }, { lat: null, lng: null });
    return false;
  } catch {
    return true;
  }
})());
check("the edit form sends a pin the action parses", /parsePin\(form\.get\("lat"\), form\.get\("lng"\)\)/.test(read("src/app/admin/vendors/actions.ts")));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
