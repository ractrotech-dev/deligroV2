/**
 * Service-worker registration and update lifecycle.
 *
 * The worker itself is `/OneSignalSDKWorker.js` — see that file for why the app
 * shares OneSignal's registration instead of taking one of its own. Registering
 * it here rather than leaving it to the OneSignal SDK matters: the SDK only
 * loads on the customer shell, and only for a signed-in profile, so vendors,
 * riders and admins had no worker at all — exactly the people most likely to be
 * on a weak connection in a kitchen or on a road.
 *
 * Everything degrades to a no-op: no `serviceWorker` in navigator (Firefox
 * private windows, older iOS), an insecure origin, or a failed registration all
 * leave the app working exactly as it does today.
 */

const SW_URL = "/OneSignalSDKWorker.js";

export type UpdateListener = (registration: ServiceWorkerRegistration) => void;

function isServiceWorkerSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    // A worker only installs on a secure origin. localhost counts.
    (window.isSecureContext || location.hostname === "localhost")
  );
}

/**
 * Is `registration` sitting on a worker that has installed and is waiting for
 * the current one to let go? That is the state the update prompt exists for.
 */
function waitingWorker(
  registration: ServiceWorkerRegistration
): ServiceWorker | null {
  // `waiting` is only meaningful once something is already controlling the
  // page. On a first-ever install there is no old version to replace, so the
  // new worker activates by itself and there is nothing to tell the user about.
  if (!navigator.serviceWorker.controller) return null;
  return registration.waiting;
}

/**
 * Tear down a worker that should not be running here, and take its caches with
 * it. Without the second half, unregistering leaves the caches on disk and the
 * next registration adopts them.
 */
async function unregisterAndPurge(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    registration?.active?.postMessage({ type: "CLEAR_CACHES" });
    await registration?.unregister();
  } catch {
    // Best effort. A browser that will not let us clean up is one where the
    // worker was probably never installed either.
  }
}

export async function registerServiceWorker(
  onUpdateReady: UpdateListener
): Promise<ServiceWorkerRegistration | null> {
  if (!isServiceWorkerSupported()) return null;

  /*
   * Not in development, and this is not tidiness — it is a correctness bug.
   *
   * `sw-core.js` serves everything under `/_next/static/` cache-first, on the
   * stated grounds that the filenames are content-hashed so a hit is always
   * correct. That is true of a production build and false of `next dev`, which
   * serves the stylesheet from a stable unhashed path
   * (`[root-of-the-server]__*.css`) and simply changes its bytes on every edit.
   *
   * So in development the worker pins the first stylesheet it ever sees, for
   * good. Javascript still updates — HMR pushes that over its own socket,
   * past the fetch handler — which produces the worst version of the symptom:
   * new markup rendered against old CSS, surviving reloads, hard reloads and
   * dev-server restarts, and looking exactly like a layout the developer just
   * broke. It cost this project a round of "it's still broken" before anyone
   * suspected the worker.
   *
   * Anything already installed from before this guard is torn down here, so a
   * browser that has one recovers on its next load rather than needing
   * DevTools.
   */
  if (process.env.NODE_ENV !== "production") {
    await unregisterAndPurge();
    return null;
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(SW_URL, {
      scope: "/",
      // "imports" is the default, spelled out because the whole update
      // mechanism depends on it: OneSignalSDKWorker.js never changes, and it is
      // the imported sw-core.js whose bytes move between releases.
      updateViaCache: "imports",
    });
  } catch {
    // A blocked or failed registration is not worth surfacing to the user —
    // they lose offline support, not the app.
    return null;
  }

  if (waitingWorker(registration)) onUpdateReady(registration);

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && waitingWorker(registration)) {
        onUpdateReady(registration);
      }
    });
  });

  return registration;
}

/**
 * Accept a pending update: tell the waiting worker to take over, then reload
 * once it has. The reload is driven by `controllerchange` rather than fired
 * immediately, because reloading before the new worker controls the page just
 * serves the old version again and the prompt comes straight back.
 */
export function applyUpdate(registration: ServiceWorkerRegistration): void {
  const waiting = registration.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }

  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Chrome can fire this more than once; a second reload would loop.
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  waiting.postMessage({ type: "SKIP_WAITING" });
}

/**
 * Drop every cache this app owns. Called on sign-out: the navigation cache
 * holds public pages, but "public" and "safe to show whoever picks up this
 * phone next" stop being the same thing the moment someone signs out.
 *
 * Best-effort and never throws — a failed cache clear must not block a logout.
 */
export async function clearAppCaches(): Promise<void> {
  if (!isServiceWorkerSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = registration?.active;
    if (!worker) return;
    worker.postMessage({ type: "CLEAR_CACHES" });
  } catch {
    // ignore
  }
}
