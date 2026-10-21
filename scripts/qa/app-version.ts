/**
 * QA — app update gate.
 *
 * `GET /api/app-version` is the only thing that can move the rider, customer and
 * Partner (vendor) Android fleets off a bad build: they install from a direct `.apk`, so there is
 * no store to fall back on and no way to reach a phone that has been told the
 * wrong thing. Getting `forceUpdate` wrong in the strict direction bricks every
 * installed app until a new backend deploy, so the derivation is tested rather
 * than trusted.
 *
 * Runs offline — no Supabase, no network, no server. Tests
 * `lib/releases/app-version.ts`, which is the code the route actually runs; the
 * route only reads settings and calls it.
 *
 * Usage:
 *   npm run test:app-version
 */
import { DEFAULT_SETTINGS } from "../../src/lib/settings-defaults";
import {
  appVersionAnswer,
  parseReleaseApp,
  parseVersionCode,
  safeApkUrl,
} from "../../src/lib/releases/app-version";
import type { PlatformSettings } from "../../src/types";

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

/** A configured platform: rider on 45, floor at 40. */
function settings(over: Partial<PlatformSettings> = {}): PlatformSettings {
  return {
    ...DEFAULT_SETTINGS,
    riderApkVersionCode: 45,
    riderApkMinVersionCode: 40,
    riderApkUrl: "https://cdn.example.test/rider-v45.apk",
    riderApkNotes: "Fixes the cash-collection screen crash.",
    customerApkVersionCode: 12,
    customerApkMinVersionCode: 12,
    customerApkUrl: "https://cdn.example.test/customer-v12.apk",
    customerApkNotes: "",
    vendorApkVersionCode: 4,
    vendorApkMinVersionCode: 3,
    vendorApkUrl: "https://cdn.example.test/partner-v4.apk",
    vendorApkNotes: "New order board.",
    ...over,
  };
}

console.log("\n═══ Version comparison ═══");

const below = appVersionAnswer(settings(), "rider", 39);
check("below the floor → forceUpdate", below.forceUpdate, true);
check("below the floor → updateAvailable too", below.updateAvailable, true);

const between = appVersionAnswer(settings(), "rider", 42);
check("between floor and latest → no forceUpdate", between.forceUpdate, false);
check("between floor and latest → updateAvailable", between.updateAvailable, true);

const atFloor = appVersionAnswer(settings(), "rider", 40);
check("exactly at the floor is still supported", atFloor.forceUpdate, false);

const atLatest = appVersionAnswer(settings(), "rider", 45);
check("at the latest → nothing to offer", atLatest.updateAvailable, false);
check("at the latest → no force", atLatest.forceUpdate, false);

// A sideloaded build, or a code the operator has not published yet. Must not
// be reported as behind, and must not throw.
const ahead = appVersionAnswer(settings(), "rider", 99);
check("ahead of the latest → not behind", ahead.updateAvailable, false);
check("ahead of the latest → not forced", ahead.forceUpdate, false);

console.log("\n═══ Per-app isolation ═══");

const customer = appVersionAnswer(settings(), "customer", 12);
check("customer track reads its own latest", customer.latestVersionCode, 12);
check("customer track reads its own floor", customer.minSupportedVersionCode, 12);
check(
  "customer track reads its own URL",
  customer.apkUrl,
  "https://cdn.example.test/customer-v12.apk"
);
check(
  "a rider on 12 is judged against the RIDER track, not the customer one",
  appVersionAnswer(settings(), "rider", 12).forceUpdate,
  true
);

const vendor = appVersionAnswer(settings(), "vendor", 2);
check("vendor track reads its own latest", vendor.latestVersionCode, 4);
check("a Partner app below its floor is forced", vendor.forceUpdate, true);
check("...and offered the Partner APK", vendor.apkUrl, "https://cdn.example.test/partner-v4.apk");
check("vendor track carries its own notes", vendor.releaseNotes, "New order board.");
const vendorCurrent = appVersionAnswer(settings(), "vendor", 4);
check("a Partner app on the latest is current", vendorCurrent.updateAvailable, false);
check("...and not forced", vendorCurrent.forceUpdate, false);
check(
  "the vendor track never reads the customer numbers",
  appVersionAnswer(settings({ customerApkVersionCode: 99 }), "vendor", 4).updateAvailable,
  false
);

console.log("\n═══ Unrecoverable configuration is clamped, not served ═══");

// The 0043 CHECK constraint refuses this, and so does the admin form. Neither
// covers a pre-0043 database, and this is the one mistake with no way back:
// every installed app is forced to a build that does not exist.
const inverted = appVersionAnswer(
  settings({ riderApkVersionCode: 40, riderApkMinVersionCode: 99 }),
  "rider",
  40
);
check("a floor above the latest is clamped down", inverted.minSupportedVersionCode, 40);
check("...so the current build is not force-updated", inverted.forceUpdate, false);

const zeroed = appVersionAnswer(
  settings({ riderApkVersionCode: 0, riderApkMinVersionCode: 0 }),
  "rider",
  1
);
check("a zero latest floors to 1", zeroed.latestVersionCode, 1);
check("...and nothing is behind it", zeroed.updateAvailable, false);

console.log("\n═══ Unreadable / un-migrated backend fails OPEN ═══");

// getSettings() answers with this shape during an outage or before 0043. Every
// code is 1, so no real build compares as behind — the route needs no fallback
// branch, and a database fault cannot force-update a fleet.
for (const code of [1, 2, 45, 1000]) {
  const out = appVersionAnswer(DEFAULT_SETTINGS, "rider", code);
  check(`fallback settings, versionCode ${code} → no force`, out.forceUpdate, false);
  check(`fallback settings, versionCode ${code} → no update`, out.updateAvailable, false);
}

console.log("\n═══ APK URL is https-only ═══");

// What is at the end of this URL gets installed. Over http anything on the
// network can return a different APK, and the phone has no way to tell.
check(
  "an https URL is served",
  safeApkUrl("https://cdn.example.test/rider-v45.apk"),
  "https://cdn.example.test/rider-v45.apk"
);
check("an http URL is dropped", safeApkUrl("http://cdn.example.test/r.apk"), "");
check("a javascript: URL is dropped", safeApkUrl("javascript:alert(1)"), "");
check("a data: URL is dropped", safeApkUrl("data:application/vnd.android.package-archive;base64,AA"), "");
check("a relative path is dropped", safeApkUrl("/rider.apk"), "");
check("empty stays empty", safeApkUrl(""), "");
check("null stays empty", safeApkUrl(null), "");

// The guard runs on the way out, not only on the way in — a row written before
// it shipped, or straight to PostgREST, must not be served either.
check(
  "an http URL already in the settings row is not served",
  appVersionAnswer(
    settings({ riderApkUrl: "http://cdn.example.test/rider-v45.apk" }),
    "rider",
    1
  ).apkUrl,
  ""
);
check(
  "...and the update is still announced, so the app can say to ask the office",
  appVersionAnswer(
    settings({ riderApkUrl: "http://cdn.example.test/rider-v45.apk" }),
    "rider",
    1
  ).updateAvailable,
  true
);

console.log("\n═══ Request parsing ═══");

check("app=rider parses", parseReleaseApp("rider"), "rider");
check("app=customer parses", parseReleaseApp("customer"), "customer");
check("app=vendor parses", parseReleaseApp("vendor"), "vendor");
check("app=driver is rejected, not defaulted", parseReleaseApp("driver"), null);
check("a missing app is rejected", parseReleaseApp(null), null);
check("app is case-sensitive", parseReleaseApp("Rider"), null);

check("versionCode=45 parses", parseVersionCode("45"), 45);
check("versionCode=0 is rejected", parseVersionCode("0"), null);
check("a negative versionCode is rejected", parseVersionCode("-4"), null);
// parseInt("1.9") would answer 1 and parseInt("12abc") would answer 12 — both
// silently answer a question nobody asked.
check("a dotted version name is rejected", parseVersionCode("1.9"), null);
check("trailing junk is rejected", parseVersionCode("12abc"), null);
check("an empty versionCode is rejected", parseVersionCode(""), null);
check("a missing versionCode is rejected", parseVersionCode(null), null);
// Not a contradiction of the "1.9 is rejected" case above: the test is whether
// the value IS an integer, not whether it was spelled without a point. "4.0" is
// exactly 4, so accepting it loses nothing; "1.9" is not an integer at all.
check("an integer spelled with a decimal point is accepted", parseVersionCode("4.0"), 4);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
