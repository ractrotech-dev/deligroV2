/**
 * QA — service-worker caching rules.
 *
 * The worker decides, per request, whether a response may be written to disk on
 * the user's device. Get that wrong in the permissive direction and a shared or
 * handed-on phone hands the next person the previous user's admin console,
 * order history or API payload — somewhere RLS cannot reach, because the bytes
 * are already local.
 *
 * So the classifier is tested rather than trusted. `public/sw-core.js` is a
 * worker script, not a module, so it is evaluated in a `vm` context with a stub
 * `self`: its top-level function declarations land on that context's global,
 * which is what lets this file reach them without exporting anything from a
 * file the browser has to be able to run verbatim.
 *
 * Runs offline. Usage:  npm run test:sw
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface SwGlobals {
  isPrivatePath: (pathname: string) => boolean;
  isRscRequest: (req: { headers: Headers }, url: URL) => boolean;
  isImmutableAsset: (url: URL) => boolean;
  isAsset: (req: { destination: string }, url: URL) => boolean;
}

type Listener = (event: unknown) => void;
const listeners = new Map<string, Listener>();
let skipWaitingCalls = 0;
let deletedCaches: string[] = [];

const sandbox = {
  self: {
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, fn);
    },
    skipWaiting() {
      skipWaitingCalls++;
    },
    location: { origin: "https://deligro.example" },
    clients: { claim() {} },
  },
  caches: {
    open: () => Promise.resolve({}),
    keys: () => Promise.resolve([]),
    match: () => Promise.resolve(undefined),
    delete: (name: string) => {
      deletedCaches.push(name);
      return Promise.resolve(true);
    },
  },
  fetch: () => Promise.resolve(new Response("")),
  Response,
  Request,
  URL,
  Headers,
  console,
};

const context = createContext(sandbox);
runInContext(readFileSync(join(root, "public/sw-core.js"), "utf8"), context);
const sw = context as unknown as SwGlobals;

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

console.log("\n═══ Private paths are never cached ═══");

// Every one of these renders something belonging to one signed-in person.
for (const path of [
  "/api/orders",
  "/api/me",
  "/admin",
  "/admin/settings/platform",
  "/vendor",
  "/vendor/earnings",
  "/driver",
  "/manager",
  "/profile",
  "/profile/addresses",
  "/orders",
  "/orders/abc-123",
  "/checkout",
  "/switch",
  "/auth/signout",
  // Render the saved address / active order into the HTML.
  "/",
  "/stores",
]) {
  check(`${path} is private`, sw.isPrivatePath(path), true);
}

console.log("\n═══ Public paths may be cached ═══");

for (const path of ["/login", "/search", "/restaurant/burger-republic", "/offline.html"]) {
  check(`${path} is cacheable`, sw.isPrivatePath(path), false);
}

// "/" is in the private list, so make sure it did not turn every path private.
check("/ does not swallow other paths", sw.isPrivatePath("/anything"), false);

console.log("\n═══ Prefix matching is on segments, not substrings ═══");

// The danger in both directions: "/orders-archive" must not be treated as
// private-by-accident, and more importantly "/adminx" must not slip past the
// gate by not matching "/admin/".
check("/orderly is not the /orders prefix", sw.isPrivatePath("/orderly"), false);
check("/administrative is not the /admin prefix", sw.isPrivatePath("/administrative"), false);
check("/admin exactly is private", sw.isPrivatePath("/admin"), true);
check("/admin/ subtree is private", sw.isPrivatePath("/admin/vendors"), true);

console.log("\n═══ RSC payloads always go to the network ═══");

const rscUrl = new URL("https://deligro.example/orders?_rsc=abc");
const plainUrl = new URL("https://deligro.example/");
check(
  "?_rsc= is an RSC request",
  sw.isRscRequest({ headers: new Headers() }, rscUrl),
  true
);
check(
  "RSC header is an RSC request",
  sw.isRscRequest({ headers: new Headers({ RSC: "1" }) }, plainUrl),
  true
);
check(
  "Next-Router-Prefetch is an RSC request",
  sw.isRscRequest({ headers: new Headers({ "Next-Router-Prefetch": "1" }) }, plainUrl),
  true
);
check(
  "a plain navigation is not",
  sw.isRscRequest({ headers: new Headers() }, plainUrl),
  false
);

console.log("\n═══ The worker does not run outside production ═══");

{
  /*
   * `isImmutableAsset` serves everything under `/_next/static/` cache-first
   * because production filenames are content-hashed. `next dev` uses that same
   * prefix with stable, unhashed names and mutates the bytes, so a worker
   * registered in development pins the first stylesheet forever — new markup
   * against old CSS, surviving reloads and dev-server restarts.
   *
   * The registration guard is what keeps that from happening, so it is pinned
   * here: the rule it protects lives in this file's subject and a future
   * "simplify the PWA setup" must trip over this rather than the symptom.
   */
  const source = readFileSync(
    join(root, "src/lib/pwa/service-worker.ts"),
    "utf8"
  );
  check(
    "registerServiceWorker bails out when NODE_ENV is not production",
    /process\.env\.NODE_ENV\s*!==\s*"production"/.test(source),
    true
  );
  check(
    "and tears down anything already installed rather than leaving it",
    /unregisterAndPurge\(\)/.test(source) && /\.unregister\(\)/.test(source),
    true
  );
}

console.log("\n═══ Asset classification ═══");

check(
  "/_next/static is immutable",
  sw.isImmutableAsset(new URL("https://deligro.example/_next/static/chunks/a1b2.js")),
  true
);
check(
  "/_next/image is not immutable",
  sw.isImmutableAsset(new URL("https://deligro.example/_next/image?url=x")),
  false
);
check(
  "an icon is an asset",
  sw.isAsset({ destination: "" }, new URL("https://deligro.example/icons/icon-192.png")),
  true
);
check(
  "a webp is an asset",
  sw.isAsset({ destination: "" }, new URL("https://deligro.example/splash-art.webp")),
  true
);
check(
  "an HTML document is not an asset",
  sw.isAsset({ destination: "document" }, new URL("https://deligro.example/")),
  false
);

async function messageOrigin(): Promise<void> {
  console.log("\n═══ Messages are only obeyed from this origin ═══");

  /*
   * SKIP_WAITING and CLEAR_CACHES are destructive to the running app, so the
   * worker must refuse them from anything it cannot trace to its own origin.
   * The fake events carry what a browser's ExtendableMessageEvent does: the
   * sender's origin and the Client that sent it.
   */
  const onMessage = listeners.get("message");
  const waits: Promise<unknown>[] = [];
  const message = (data: unknown, origin: string, sourceUrl: string | null) => {
    onMessage?.({
      data,
      origin,
      source: sourceUrl === null ? null : { url: sourceUrl },
      ports: [],
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
  };
  const OWN = "https://deligro.example";
  const skip = { type: "SKIP_WAITING" };
  const clear = { type: "CLEAR_CACHES" };

  check("a message listener is registered", typeof onMessage, "function");

  message(skip, OWN, `${OWN}/profile`);
  check("SKIP_WAITING from our own page is obeyed", skipWaitingCalls, 1);

  skipWaitingCalls = 0;
  message(skip, "https://evil.example", "https://evil.example/");
  check("SKIP_WAITING from another origin is dropped", skipWaitingCalls, 0);
  message(skip, OWN, "https://evil.example/");
  check("a claimed origin that its sender's URL contradicts is dropped", skipWaitingCalls, 0);
  message(skip, "", `${OWN}/`);
  check("no origin but a same-origin sender is obeyed", skipWaitingCalls, 1);

  skipWaitingCalls = 0;
  message(skip, "", null);
  check("no origin and no sender is dropped (fails closed)", skipWaitingCalls, 0);
  message(skip, OWN, "not a url");
  check("an unparsable sender URL is dropped", skipWaitingCalls, 0);

  deletedCaches = [];
  message(clear, "https://evil.example", "https://evil.example/");
  await Promise.all(waits);
  check("CLEAR_CACHES from another origin deletes nothing", deletedCaches.length, 0);
  message(clear, OWN, `${OWN}/auth/signout`);
  await Promise.all(waits);
  check("CLEAR_CACHES from our own page empties our caches", deletedCaches.length, 3);
}

messageOrigin().then(
  () => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
