/**
 * QA — the delivery place does not outlive the person who chose it.
 *
 * A saved address (label, full line, coordinates) is cached in localStorage so
 * the header is not empty on a cold start. On a shared phone that cache is the
 * previous customer's address in the next customer's header. This suite runs
 * the real store against a fake localStorage and checks:
 *   - the cache really is written (a control, so the rest cannot pass vacuously);
 *   - after clearLocationCache() it is gone, the store is back on the city
 *     default, and an app restart cannot bring the old place back;
 *   - the non-personal "permission explainer answered" flag is left alone;
 *   - the clear is wired to both moments a device changes hands.
 *
 * Runs offline. Usage: npm run test:location-privacy
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// A minimal browser: localStorage plus a `window` the store's guards accept.
const mem = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};
g.window = globalThis;

const CACHE_KEY = "deligro-loc-cache";
const PREF_KEY = "deligro-loc-pref";
const PRIVATE_LINE = "12 Private Lane, Near The Old Well";
const PRIVATE_COORDS = { lat: 21.7301, lng: 81.5502 };

async function main() {
  const { useLocation, clearLocationCache } = await import("../../src/stores/location-store");
  const { PINNED_LOCATION } = await import("../../src/lib/location/pinned");

  const atCityDefault = () => {
    const s = useLocation.getState();
    return (
      s.label === PINNED_LOCATION.label &&
      s.coords?.lat === PINNED_LOCATION.coords.lat &&
      s.coords?.lng === PINNED_LOCATION.coords.lng
    );
  };

  console.log("\n═══ control: a chosen address is cached ═══");
  useLocation.getState().setPlace({ label: "Home", sublabel: PRIVATE_LINE, coords: PRIVATE_COORDS });
  const cached = mem.get(CACHE_KEY) ?? "";
  check("the cache holds the label", cached.includes("Home"), true);
  check("the cache holds the full address line", cached.includes(PRIVATE_LINE), true);
  check("the cache holds the coordinates", cached.includes(String(PRIVATE_COORDS.lat)), true);
  check("the header store shows it", useLocation.getState().label, "Home");
  check("the explainer flag is set", mem.get(PREF_KEY), "asked");

  console.log("\n═══ control: a restart restores it (so the clear below means something) ═══");
  useLocation.setState({ status: "idle", label: PINNED_LOCATION.label, sublabel: PINNED_LOCATION.sublabel, coords: PINNED_LOCATION.coords });
  await useLocation.getState().maybePrompt();
  check("without a clear, a restart brings the address back", useLocation.getState().label, "Home");
  check("and its full line", useLocation.getState().sublabel, PRIVATE_LINE);

  console.log("\n═══ sign-out: the next person does not inherit it ═══");
  clearLocationCache();
  check("the cached place is removed", mem.has(CACHE_KEY), false);
  check("no stored value mentions the address line", [...mem.values()].some((v) => v.includes(PRIVATE_LINE)), false);
  check("no stored value mentions the coordinates", [...mem.values()].some((v) => v.includes(String(PRIVATE_COORDS.lat))), false);
  check("the open page is back on the city default", atCityDefault(), true);
  check("with no stale or error state left", `${useLocation.getState().status}/${useLocation.getState().error}`, "idle/null");
  check("the non-personal explainer flag is kept", mem.get(PREF_KEY), "asked");

  console.log("\n═══ app restart after sign-out ═══");
  useLocation.setState({ status: "idle", label: PINNED_LOCATION.label, sublabel: PINNED_LOCATION.sublabel, coords: PINNED_LOCATION.coords });
  await useLocation.getState().maybePrompt();
  check("a restart does not bring the old address back", useLocation.getState().label === "Home", false);
  check("the header is on the city default", atCityDefault(), true);

  console.log("\n═══ a different customer signs in ═══");
  useLocation.getState().setPlace({ label: "Work", sublabel: "Second Customer Road", coords: { lat: 21.71, lng: 81.54 } });
  clearLocationCache();
  check("the second customer's place is cleared too", mem.has(CACHE_KEY), false);
  check("clearing twice is harmless", (() => { clearLocationCache(); return atCityDefault(); })(), true);

  console.log("\n═══ the clear is wired to both moments ═══");
  const read = (f: string) => readFileSync(join(__dirname, "..", "..", f), "utf8").split("\r\n").join("\n");
  const pwa = read("src/components/pwa/pwa-provider.tsx");
  const signedOut = pwa.slice(pwa.indexOf('get("signedout") === "1"'));
  check("the sign-out landing clears it", signedOut.slice(0, 400).includes("clearLocationCache()"), true);
  const otp = read("src/components/auth/otp-login.tsx");
  const clearAt = otp.indexOf("clearLocationCache();");
  const pushAt = otp.indexOf("router.push(next);");
  check("a successful sign-in clears it", clearAt > 0, true);
  check("and does so before navigating on", clearAt > 0 && clearAt < pushAt, true);
  const store = read("src/stores/location-store.ts");
  const fn = store.slice(store.indexOf("export function clearLocationCache"));
  check("the explainer flag is not removed by the clear", fn.includes("PREF_KEY"), false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
