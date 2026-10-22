/**
 * QA — router reuse (`experimental.staleTimes.dynamic`) is only safe while every
 * place a customer changes their own data also clears the router cache.
 *
 * With reuse on, a page fetched in the last few seconds is shown again without
 * asking the server. `router.refresh()` is what clears it. So a mutation that
 * forgets to call it leaves a stale screen: an order that does not appear in
 * Orders, an address change that Home does not show.
 *
 * Checked structurally, offline:
 *   1. the config value is present and short;
 *   2. every known customer mutation file calls `router.refresh()`;
 *   3. checkout clears the cache as soon as the order exists, before payment;
 *   4. sign-out stays a plain form post (a full page load clears the cache);
 *   5. any NEW customer-side mutation must be classified here or this fails.
 *
 * Usage: npm run test:router-reuse
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = join(__dirname, "..", "..");
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

const read = (f: string) => readFileSync(join(root, f), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

console.log("\n═══ config ═══");
const cfg = read("next.config.ts");
const m = /staleTimes:\s*\{\s*dynamic:\s*(\d+)\s*\}/.exec(cfg);
check("staleTimes.dynamic is set", Boolean(m), true);
check("and is 30 seconds or less", m ? Number(m[1]) <= 30 : false, true);

console.log("\n═══ every customer mutation clears the router cache ═══");
const REFRESHING = [
  "src/components/auth/otp-login.tsx",
  "src/components/checkout/checkout-view.tsx",
  "src/components/orders/refund-request.tsx",
  "src/components/orders/tracking-view.tsx",
  "src/components/profile/profile-avatar.tsx",
  "src/components/profile/profile-edit-sheet.tsx",
  "src/components/restaurant/restaurant-actions.tsx",
  "src/components/providers/lang-provider.tsx",
  "src/hooks/use-saved-addresses.ts",
];
for (const f of REFRESHING) {
  check(`${f} calls router.refresh()`, /router\.refresh\(\)/.test(read(f)), true);
}

console.log("\n═══ order placement ═══");
const checkout = read("src/components/checkout/checkout-view.tsx");
const refreshAt = checkout.indexOf("router.refresh()");
const payAt = checkout.indexOf("await payForOrder(");
check("checkout refreshes the router cache", refreshAt > 0, true);
check("and does so before payment starts, so an unpaid order is listed too", refreshAt > 0 && refreshAt < payAt, true);

console.log("\n═══ sign-out ═══");
const profile = read("src/app/(customer)/profile/page.tsx");
check(
  "customer sign-out is a plain form post (a full page load)",
  /<form[^>]*action="\/auth\/signout"[^>]*method="post"/.test(profile),
  true
);

console.log("\n═══ no unclassified customer mutation ═══");
// Mutations that change nothing a cached page shows: analytics, push
// subscription, a price check, uploads that live in the admin console, and the
// rider rating (it reads its own state from the API every time it mounts, and
// no cached page shows it).
const NOT_VISIBLE = new Set([
  "src/components/orders/rider-rating-card.tsx",
  "src/lib/obs/client.ts",
  "src/components/home/promo-banner-carousel.tsx",
  "src/components/notifications/onesignal-init.tsx",
  "src/stores/food-upload-store.ts",
]);
const PORTAL = /(^|[\/])(admin|vendor|driver|manager)([\/]|$)/;
const mutating = walk(join(root, "src"))
  .map((f) => relative(root, f).split(sep).join("/"))
  .filter((f) => !PORTAL.test(f))
  // Browser code only: a server-side call cannot leave a stale browser cache.
  // Indent without line breaks: `^\s*` re-walked every blank line from each
  // line start. Same verdict — a directive after blank lines is still found
  // from the line it sits on.
  .filter((f) => /^[^\S\r\n\u2028\u2029]*["']use client["']/m.test(read(f)))
  .filter((f) => /method:\s*"(POST|PUT|PATCH|DELETE)"/.test(read(f)));
const unknown = mutating.filter((f) => !REFRESHING.includes(f) && !NOT_VISIBLE.has(f));
check("every customer-side mutation file is classified", unknown.length, 0);
if (unknown.length) console.log(`    unclassified: ${unknown.join(", ")}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
