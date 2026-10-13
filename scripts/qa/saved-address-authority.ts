/**
 * QA — the saved delivery address is authoritative.
 *
 * The header used to prefer whatever the device had last said (a GPS fix, a
 * searched place) over the saved default address, while checkout always starts
 * from the saved default. After a silent re-detect the header named one place
 * and the order went to another. Now, while a saved address is active:
 *   - a GPS fix becomes a candidate that waits to be confirmed;
 *   - the header, the distances and the cache stay on the saved address;
 *   - the saved address itself is never written to browser storage;
 *   - guests and customers with nothing saved are placed by detection as before.
 *
 * Runs the real store with a fake browser, plus structural checks on the
 * screens that must agree. Offline. Usage: npm run test:saved-address
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

// ---- a minimal browser: storage, a window, and a GPS that answers at once ----
const mem = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};
g.window = globalThis;
g.isSecureContext = true;
// No network: reverse geocoding finds nothing and the store falls back to
// "Current location", which is all these tests need.
g.fetch = () => Promise.reject(new Error("offline"));

const FIX = { lat: 21.7612, lng: 81.5987 }; // somewhere other than the saved pin
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    geolocation: {
      getCurrentPosition: (ok: (p: unknown) => void) =>
        ok({ coords: { latitude: FIX.lat, longitude: FIX.lng, accuracy: 10 } }),
      watchPosition: () => 1,
      clearWatch: () => undefined,
    },
  },
});

const CACHE_KEY = "deligro-loc-cache";
const SAVED = { label: "Home", sublabel: "B.T.I. Colony", coords: { lat: 21.7201, lng: 81.5402 } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { useLocation, clearLocationCache } = await import("../../src/stores/location-store");
  const { PINNED_LOCATION } = await import("../../src/lib/location/pinned");
  const st = () => useLocation.getState();
  const reset = () => {
    mem.clear();
    clearLocationCache();
  };

  console.log("\n═══ control: with nothing saved, detection applies directly (unchanged) ═══");
  reset();
  st().detect();
  await sleep(50);
  check("the header place becomes the fix", st().label, "Current location");
  check("the distances follow the fix", st().coords?.lat, FIX.lat);
  check("it is cached for the next launch", mem.has(CACHE_KEY), true);
  check("there is no candidate to confirm", st().candidate, null);

  console.log("\n═══ a saved address is active: GPS cannot replace it ═══");
  reset();
  st().adoptSaved(SAVED);
  check("the saved address is the active place", `${st().label}/${st().sublabel}`, "Home/B.T.I. Colony");
  check("the flag is set", st().savedActive, true);
  check("adopting it writes nothing to browser storage", [...mem.keys()].some((k) => k === CACHE_KEY), false);
  st().detect();
  await sleep(50);
  check("the label is still the saved address", st().label, "Home");
  check("the distances are still measured from the saved pin", st().coords?.lat, SAVED.coords.lat);
  check("the fix is held as a candidate", st().candidate?.coords?.lat, FIX.lat);
  check("the candidate carries a name to show", st().candidate?.label, "Current location");
  check("the fix did not overwrite the cache", mem.has(CACHE_KEY), false);
  check("the screen is not left stuck 'loading'", st().status, "granted");

  console.log("\n═══ confirming or declining a candidate ═══");
  st().clearCandidate();
  check("declining drops the candidate", st().candidate, null);
  check("and the saved address is untouched", st().label, "Home");
  st().setCandidate({ label: "Searched place", sublabel: "Somewhere", coords: FIX });
  check("a searched place is held the same way", st().candidate?.label, "Searched place");
  st().adoptSaved({ label: "Other", sublabel: "Searched place", coords: FIX });
  check("confirming (saved, then adopted) makes it the active place", st().label, "Other");
  check("and clears the candidate", st().candidate, null);

  console.log("\n═══ a restart cannot override the saved address ═══");
  reset();
  mem.set(CACHE_KEY, JSON.stringify({ label: "Old GPS area", sublabel: "Elsewhere", coords: FIX, at: Date.now() }));
  st().adoptSaved(SAVED);
  await st().maybePrompt();
  check("a cached device place does not replace it", st().label, "Home");

  console.log("\n═══ no saved address any more ═══");
  reset();
  st().adoptSaved(SAVED);
  st().releaseSaved();
  check("the flag is cleared", st().savedActive, false);
  st().detect();
  await sleep(50);
  check("detection applies directly again", st().label, "Current location");

  console.log("\n═══ sign-out drops the saved address and any candidate ═══");
  reset();
  st().adoptSaved(SAVED);
  st().setCandidate({ label: "x", sublabel: null, coords: null });
  clearLocationCache();
  check("savedActive is reset", st().savedActive, false);
  check("the candidate is gone", st().candidate, null);
  check("the page is on the city default", st().label, PINNED_LOCATION.label);

  console.log("\n═══ the screens agree ═══");
  const read = (f: string) => readFileSync(join(__dirname, "..", "..", f), "utf8").split("\r\n").join("\n");
  const header = read("src/components/home/home-header.tsx");
  check("the header prefers the saved address", header.includes("const shown = saved ?? place ?? fallback;"), true);
  check("the header hands the saved address to the store", header.includes("adoptSaved({"), true);
  check("a re-detect does not flash 'Locating…' over a saved address", header.includes('status === "loading" && !savedAddress'), true);
  const picker = read("src/app/(customer)/location/page.tsx");
  const choose = picker.slice(picker.indexOf("async function chooseSaved"), picker.indexOf("async function confirmCandidate"));
  check("choosing a saved address does not cache it (adoptSaved, not setPlace)", choose.includes("adoptSaved(") && !choose.includes("setPlace("), true);
  check("a searched place is held when a saved address is active", picker.includes("useLocation.getState().savedActive") && picker.includes("setCandidate(found)"), true);
  check("the screen stays open for a candidate", picker.includes('status === "granted" && !candidate'), true);
  const confirm = picker.slice(picker.indexOf("async function confirmCandidate"));
  check("confirming saves a real address and makes it the default", confirm.slice(0, 900).includes("isDefault: true"), true);
  check("the detect row does not show the saved label as if detected", picker.includes('status === "granted" && label && !savedActive'), true);
  const hook = read("src/hooks/use-saved-addresses.ts");
  check("checkout preselects the default address the header names", hook.includes("list.find((a) => a.isDefault)?.id"), true);
  for (const f of ["src/app/(customer)/page.tsx", "src/app/(customer)/stores/page.tsx"]) {
    check(`${f} passes the saved pin`, read(f).includes("lat: pin?.lat ?? null"), true);
  }
  const checkout = read("src/components/checkout/checkout-view.tsx");
  check("checkout still re-checks the delivery area (safety check preserved)", checkout.includes("addressUnpinned") && checkout.includes("serviceability"), true);
  const orders = read("src/lib/data-access/orders.ts");
  check("and the server still refuses out-of-area orders", orders.includes("outside_delivery_area"), true);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
