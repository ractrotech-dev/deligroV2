/**
 * QA — the customer app shows ONE language at a time (English or Hindi), not
 * "English · हिंदी" side by side.
 * Usage: npx tsx scripts/qa/customer-language.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseLang,
  translator,
  langCookie,
  pick,
  LANG_COOKIE,
  HINDI_ENABLED,
} from "../../src/lib/i18n/lang";
import { STATUS_META, trackingSteps } from "../../src/lib/utils/order-status";
import { formatCustomerLateness } from "../../src/lib/utils/format";
import { outOfRangeMessage } from "../../src/lib/geo/service-area";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const DEV = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z]{3,}/;
const isHi = (s: string) => DEV.test(s);
const isEnOnly = (s: string) => !DEV.test(s);

// --- Hindi switched off: a stale "hi" cookie must still give English ---
if (!HINDI_ENABLED) {
  check("[off] a 'hi' cookie still means English", parseLang("hi") === "en");
  check(
    "[off] translator('hi') returns the English",
    translator("hi")("Home", "होम") === "Home",
  );
  check(
    "[off] pick('hi') returns the English",
    pick("hi", { en: "A", hi: "अ" }) === "A",
  );
  check(
    "[off] tracking steps are English",
    trackingSteps({ restaurantName: "Saffron" }, "hi").every(
      (s) => isEnOnly(s.title) && isEnOnly(s.sub),
    ),
  );
  check(
    "[off] lateness is English",
    isEnOnly(formatCustomerLateness(10, "hi")),
  );
}

// --- the language itself (only meaningful while Hindi is on) ---
if (HINDI_ENABLED) {
  check("parseLang('hi') is Hindi", parseLang("hi") === "hi");
  check("parseLang('en') is English", parseLang("en") === "en");
  check("no cookie means English", parseLang(undefined) === "en");
  check("an unknown value means English", parseLang("fr") === "en");
  check(
    "translator(en) returns the English",
    translator("en")("Home", "होम") === "Home",
  );
  check(
    "translator(hi) returns the Hindi",
    translator("hi")("Home", "होम") === "होम",
  );
  check(
    "pick() reads an {en, hi} pair",
    pick("hi", { en: "A", hi: "अ" }) === "अ" &&
      pick("en", { en: "A", hi: "अ" }) === "A",
  );
}
const cookie = langCookie("hi");
check(
  "cookie is site-wide and kept a year",
  cookie.startsWith(`${LANG_COOKIE}=hi`) &&
    cookie.includes("Path=/") &&
    /Max-Age=3\d{7}/.test(cookie),
);

// --- shared customer text (the Hindi half is still kept in the code) ---
const statuses = Object.values(STATUS_META);
check(
  "every status has an English-only label",
  statuses.every((m) => isEnOnly(m.en)),
);
check(
  "every status has a Hindi label",
  statuses.every((m) => isHi(m.hi)),
);
check(
  "status label is combined when Hindi is on, English-only when off",
  statuses.every((m) => m.label === (HINDI_ENABLED ? `${m.en} · ${m.hi}` : m.en)),
);
check(
  "tracking steps in English have no Hindi",
  trackingSteps({ restaurantName: "Saffron" }, "en").every(
    (s) => isEnOnly(s.title) && isEnOnly(s.sub),
  ),
);
if (HINDI_ENABLED)
  check(
    "tracking steps in Hindi are Hindi",
    trackingSteps({ restaurantName: "Saffron" }, "hi").every(
      (s) => isHi(s.title) && isHi(s.sub),
    ),
  );
check(
  "lateness in English has no Hindi",
  [10, 90, 500].every((m) => isEnOnly(formatCustomerLateness(m, "en"))),
);
if (HINDI_ENABLED)
  check(
    "lateness in Hindi is Hindi",
    [10, 90, 500].every((m) => isHi(formatCustomerLateness(m, "hi"))),
  );

const far = {
  status: "out_of_range",
  reason: "customer_outside_area",
  radiusKm: 25,
  distanceKm: 31.2,
} as unknown as Parameters<typeof outOfRangeMessage>[0];
check(
  "out-of-area in English has no Hindi",
  isEnOnly(outOfRangeMessage(far, "en")),
);
if (HINDI_ENABLED)
  check(
    "out-of-area in Hindi is Hindi",
    isHi(outOfRangeMessage(far, "hi")) &&
      !/deliver only/.test(outOfRangeMessage(far, "hi")),
  );

// --- no side-by-side labels left on customer screens ---
const ROOT = join(__dirname, "..", "..", "src");
const CUSTOMER_DIRS = [
  "app/(customer)",
  "app/login",
  "components/home",
  "components/shared",
  "components/stores",
  "components/search",
  "components/orders",
  "components/checkout",
  "components/restaurant",
  "components/glass",
  "components/location",
  "components/addresses",
  "components/profile",
  "components/layout",
  "components/pwa",
];
const CUSTOMER_FILES = [
  "components/notifications/push-opt-in.tsx",
  "components/auth/otp-login.tsx",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}
const files = [
  ...CUSTOMER_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...CUSTOMER_FILES.map((f) => join(ROOT, f)),
];
const offenders: string[] = [];
for (const f of files) {
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "").trim();
      if (
        code.startsWith("*") ||
        code.startsWith("/*") ||
        code.startsWith("{/*")
      )
        return;
      // A Hindi phrase and an English phrase inside the SAME string literal.
      for (const lit of code.match(/"[^"]*"|`[^`]*`|>[^<{}]+</g) ?? []) {
        // Brand names and acronyms stay in Latin script inside Hindi text.
        const words = lit
          .replace(/\$\{[^}]*\}/g, "")
          .replace(/\b(Deligro|OTP|UPI|SMS|GST)\b/g, "");
        if (DEV.test(lit) && LATIN.test(words))
          offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
      }
    });
}
check(
  "no customer string shows English and Hindi together",
  offenders.length === 0,
  offenders.slice(0, 15).join(", "),
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
