/* Deligro service worker — caching, offline, and update plumbing.
 *
 * WHY THIS FILE IS NOT THE REGISTERED WORKER
 * ------------------------------------------
 * OneSignal owns the one service-worker registration this origin can have at
 * scope "/" (`/OneSignalSDKWorker.js`, registered by the v16 SDK). A second
 * `register()` at the same scope REPLACES the first, so registering an app
 * worker of our own would silently tear down push — and push is how a rider
 * learns there is an order waiting. So there is exactly one worker file, and
 * this module is pulled into it with `importScripts`.
 *
 * That also gives update detection for free: the spec has browsers re-fetch a
 * worker's imported scripts during an update check (this is what
 * `updateViaCache: "imports"` means), so a change to THIS file installs a new
 * worker even though OneSignalSDKWorker.js itself never changes.
 *
 * Plain JS on purpose — `public/` is served verbatim, so there is no build step
 * to strip types, and Turbopack never sees this file.
 */

/* Bump on any behavioural change here. It names the caches, so bumping it is
 * also what evicts the previous version's entries in `activate`. */
const SW_VERSION = "v2";

const NAV_CACHE = `deligro-nav-${SW_VERSION}`;
const STATIC_CACHE = `deligro-static-${SW_VERSION}`;
const ASSET_CACHE = `deligro-assets-${SW_VERSION}`;
const OWNED = [NAV_CACHE, STATIC_CACHE, ASSET_CACHE];

/* A plain static file, NOT a Next route. A route's HTML caches fine but needs
 * its `/_next/static/chunks/*` to hydrate, and those are only cached if the app
 * happened to request them while online — when they 404 the router throws and
 * the user gets the app's error boundary instead of this screen. Measured, in
 * headless Chrome against a stopped server. See public/offline.html. */
const OFFLINE_URL = "/offline.html";

/* Next sets `Vary: rsc, next-router-state-tree, next-router-prefetch, …` on
 * every App Router HTML response, and the Cache API honours Vary when matching.
 * Without ignoring it a stored page is effectively unreachable: the offline
 * screen was verified present in the cache and still failed to match, because
 * the lookup request's router headers did not equal the ones it was stored
 * with. Every entry these caches hold is a whole document or a static asset —
 * one representation per URL, never a negotiated variant — so Vary has nothing
 * useful to say here. RSC payloads, which ARE header-negotiated, never reach a
 * cache at all (see isRscRequest). */
const MATCH = { ignoreVary: true };

/* Precached at install so the offline screen is available on the very first
 * disconnection. Deliberately tiny: everything else is filled in at runtime,
 * because the hashed chunk names are not knowable from a static file. */
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];

/* Routes whose HTML is private to one signed-in person. Never written to a
 * cache — a shared or handed-on phone must not be able to pull a previous
 * user's admin console or order history out of local storage, and RLS cannot
 * help once the bytes are on the device. These fall back to the offline screen
 * instead, which is the honest answer: the data genuinely is not available.
 *
 * `/api` is here too, though it is also excluded by `isPrivatePath` being
 * checked before any caching branch — belt and braces, because the cost of
 * getting this wrong is serving one customer another's order. */
const PRIVATE_PREFIXES = [
  "/api",
  "/admin",
  "/vendor",
  "/driver",
  "/manager",
  "/profile",
  "/orders",
  "/checkout",
  "/switch",
  "/auth",
  // The home feed and the stores list render the signed-in customer's saved
  // default address and active-order strip into the HTML (see HomeHeader), so
  // they are private pages even though they look public. "/" only ever matches
  // the exact root: isPrivatePath tests `p + "/"` for the prefix case, which is
  // "//" and never a real path. Cost: no stale home feed offline.
  "/",
  "/stores",
];

function isPrivatePath(pathname) {
  return PRIVATE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

/* React Server Component payloads. Next fetches these for client-side
 * navigations, and they are content-negotiated on headers rather than the URL —
 * so a cached copy can be served for the wrong variant, and for a signed-in
 * page it carries that user's data. Always straight to the network. */
function isRscRequest(request, url) {
  return (
    request.headers.has("RSC") ||
    request.headers.get("Next-Router-Prefetch") === "1" ||
    url.searchParams.has("_rsc")
  );
}

/* Hashed build output. The filename changes whenever the bytes do, so a hit is
 * always correct and never needs revalidating.
 *
 * That holds for a production build and ONLY for a production build. `next dev`
 * serves this same prefix from stable, unhashed paths and changes the bytes
 * underneath them, so cache-first here would pin the first stylesheet the
 * browser ever saw. The worker is therefore not registered outside production —
 * see the guard in `lib/pwa/service-worker.ts`, which is load-bearing for this
 * function rather than a convenience. */
function isImmutableAsset(url) {
  return url.pathname.startsWith("/_next/static/");
}

function isAsset(request, url) {
  if (url.pathname.startsWith("/icons/")) return true;
  if (/\.(?:png|jpe?g|webp|avif|gif|svg|ico|woff2?)$/i.test(url.pathname)) {
    return true;
  }
  return request.destination === "image" || request.destination === "font";
}

/* Fill the static cache, skipping anything already there.
 *
 * Individually, not `addAll`: addAll rejects the whole batch if any one entry
 * 404s, which would leave the app with no worker at all over a single renamed
 * icon. Each failure is swallowed on purpose — and that is exactly why this
 * runs on activate as well as install (see below). */
async function precache() {
  const cache = await caches.open(STATIC_CACHE);
  await Promise.all(
    PRECACHE.map(async (path) => {
      // Cheap: an entry that survived from the previous version does not need
      // fetching again.
      if (await cache.match(path, MATCH)) return;
      try {
        await cache.add(new Request(path, { cache: "reload" }));
      } catch {
        // Left to the activate pass, or the next install.
      }
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          // Only ours. Another worker's caches on this origin are not ours to
          // delete — OneSignal keeps its own.
          .filter((n) => n.startsWith("deligro-") && !OWNED.includes(n))
          .map((n) => caches.delete(n))
      );

      // Precache AGAIN, because the install pass is allowed to lose entries and
      // does. A reload landing while install is still fetching drops whatever
      // was in flight, and every failure there is swallowed — so the offline
      // screen could end up permanently missing on exactly the visit where the
      // user was impatient. Observed in a headless-Chrome run: install-only
      // precaching left /offline absent, and the fallback then had nothing to
      // serve. Idempotent, so the normal case costs two cache lookups.
      await precache();

      // Take over open tabs so the page that showed "update available" is
      // actually controlled by this worker after it reloads.
      await self.clients.claim();
    })()
  );
});

/* A message is only acted on when it provably comes from one of our own pages.
 * Both commands below are destructive to the running app (swap its chunks,
 * empty its caches), so anything that cannot be traced to this origin — a
 * missing origin, a sender with no URL, an unparsable URL — is dropped rather
 * than trusted. */
function isOwnSource(source, own) {
  if (!source || typeof source.url !== "string") return false;
  try {
    return new URL(source.url).origin === own;
  } catch {
    return false;
  }
}

/* The page asks for this after the user accepts an update. Never called on our
 * own initiative: skipping the wait unprompted swaps the running app's chunks
 * mid-session, and a half-typed checkout form is a bad thing to lose. */
self.addEventListener("message", (event) => {
  const own = self.location.origin;
  if (event.origin && event.origin !== own) return;
  if (!isOwnSource(event.source, own)) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  // Sent on sign-out. Public pages are cached by path, and "public" is not the
  // same as "fine to show the next person who picks up this phone" once someone
  // has deliberately ended their session.
  if (data.type === "CLEAR_CACHES") {
    event.waitUntil(
      (async () => {
        await Promise.all(OWNED.map((n) => caches.delete(n)));
        if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true });
      })()
    );
  }
});

async function ensureOfflinePage() {
  try {
    const cache = await caches.open(STATIC_CACHE);
    if (await cache.match(OFFLINE_URL, MATCH)) return;
    await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
  } catch {
    // Nothing to do — the next successful navigation tries again.
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(NAV_CACHE);
  try {
    const response = await fetch(request);
    // Only stash a real, complete answer. An opaque or errored response cached
    // here would be served as the app shell on the next disconnection.
    if (response && response.ok && response.type === "basic") {
      // Not awaited: the page should not wait on the disk write. A failed write
      // (quota, a body that errored mid-stream) only means no offline copy.
      putQuietly(cache, request, response);
      // The network is demonstrably up right now, which is the only time the
      // offline screen can be repaired. Costs one cache lookup per navigation.
      void ensureOfflinePage();
    }
    return response;
  } catch {
    const cached = await cache.match(request, MATCH);
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL, MATCH);
    if (offline) return offline;
    return new Response("", { status: 503, statusText: "Offline" });
  }
}

/* Writes a copy of `response` into `cache` without waiting on it. A failed
 * write is swallowed: it only ever costs an offline copy or a refetch. */
function putQuietly(cache, request, response) {
  cache.put(request, response.clone()).catch(() => {});
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, MATCH);
  if (cached) return cached;
  const response = await fetch(request);
  // Not awaited, for the same reason as above: a failed write costs a refetch.
  if (response && response.ok) putQuietly(cache, request, response);
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, MATCH);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) putQuietly(cache, request, response);
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const response = await network;
  return response ?? new Response("", { status: 504, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Anything that changes state goes to the network, always. A cached POST is
  // not a thing, and quietly replaying one would be worse than failing.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin (Supabase, OneSignal, Razorpay, Maps) is left entirely alone:
  // those responses are authenticated, metered, or both, and none of them are
  // ours to store.
  if (url.origin !== self.location.origin) return;

  if (isRscRequest(request, url)) return;
  if (isPrivatePath(url.pathname)) {
    // Still worth a fallback: a rider tapping their board with no signal should
    // land on the offline screen, not the browser's dinosaur.
    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request).catch(async () => {
          const offline = await caches.match(OFFLINE_URL, MATCH);
          return offline ?? new Response("", { status: 503 });
        })
      );
    }
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (isAsset(request, url)) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
  }
});
