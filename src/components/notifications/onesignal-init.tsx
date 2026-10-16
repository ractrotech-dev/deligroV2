"use client";

import { useEffect } from "react";
import { nativePush, nativeSessionSync } from "@/lib/native/bridge";

/**
 * Loads the OneSignal Web SDK (v16), ties this device's subscription to the
 * signed-in user, and keeps /api/notifications/register told of its id.
 *
 * Mounted in EVERY portal — customer, vendor, driver, manager, admin. It used
 * to live only in the customer layout, so kitchens and riders never had a push
 * subscription at all and every "new order" / "pickup coming" push the server
 * sent went to nobody. The screens that most need a push — a tablet on a shelf,
 * a phone in a rider's pocket — were exactly the ones that could not get one.
 *
 * `OneSignal.login(userId)` makes the profile id the subscription's
 * `external_id`, which is what the server targets (lib/notifications/onesignal.ts).
 * That is also what makes it multi-device: a vendor's counter tablet and phone
 * both receive, instead of whichever registered last overwriting
 * `profiles.onesignal_id`. The player id is still saved as a fallback.
 *
 * `userId={null}` (signed out): if this browser was logged in to OneSignal
 * before, log it out, so the next person on a shared phone does not receive the
 * last person's orders. Signing out is a full page load (/auth/signout), so this
 * runs on the first page after it. A browser that never subscribed loads nothing.
 *
 * Renders nothing and does nothing unless NEXT_PUBLIC_ONESIGNAL_APP_ID is set.
 *
 * Inside the Android app shells (mobile/) push is native: see src/lib/native/bridge.ts.
 */

const APP_ID = process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID ?? "";
const SDK_SRC = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
/** Which user this browser is logged in to OneSignal as, if any. */
const LOGGED_IN_KEY = "deligro-push-user";

declare global {
  interface Window {
    OneSignalDeferred?: Array<(os: OneSignalApi) => void | Promise<void>>;
  }
}

interface OneSignalApi {
  init: (opts: { appId: string; allowLocalhostAsSecureOrigin?: boolean }) => Promise<void>;
  login: (externalId: string) => Promise<void>;
  logout: () => Promise<void>;
  User: {
    PushSubscription: {
      id?: string | null;
      optIn: () => Promise<void>;
      addEventListener: (
        event: "change",
        cb: (e: { current: { id?: string | null } }) => void
      ) => void;
    };
  };
}

async function savePlayerId(id: string | null | undefined) {
  if (!id) return;
  try {
    await fetch("/api/notifications/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: id }),
    });
  } catch {
    // best-effort — a failed register just means no push until next visit
  }
}

function readLoggedIn(): string | null {
  try {
    return window.localStorage.getItem(LOGGED_IN_KEY);
  } catch {
    return null;
  }
}

function writeLoggedIn(userId: string | null): void {
  try {
    if (userId) window.localStorage.setItem(LOGGED_IN_KEY, userId);
    else window.localStorage.removeItem(LOGGED_IN_KEY);
  } catch {
    /* private mode — login still happened, logout just won't be remembered */
  }
}

function loadSdk(): void {
  if (document.querySelector(`script[src="${SDK_SRC}"]`)) return;
  const script = document.createElement("script");
  script.src = SDK_SRC;
  script.defer = true;
  document.head.appendChild(script);
}

/**
 * The SDK throws "SDK already initialized" on a second `init`, and this effect
 * runs again whenever a layout remounts (and twice under React dev StrictMode).
 * Once per page load is the contract.
 */
let initQueued = false;

/**
 * Tie this device's push identity to `userId`, or detach it when null.
 * Shared by <OneSignalInit> and the sign-out landing (signOutPush).
 */
function syncPushIdentity(userId: string | null): void {
  // Inside the Android app: push goes through the native plugin. The web
  // SDK cannot receive push in a WebView, so it is not loaded at all here.
  const native = nativePush();
  if (native) {
    void nativeSessionSync(native, userId).catch(() => {});
    return;
  }

  if (!APP_ID || initQueued) return;

  // Signed out, and this browser was never logged in: nothing to undo, so
  // don't load a third-party SDK for an anonymous visitor.
  if (!userId && !readLoggedIn()) return;

  initQueued = true;
  window.OneSignalDeferred = window.OneSignalDeferred ?? [];
  window.OneSignalDeferred.push(async (OneSignal) => {
    try {
      await OneSignal.init({
        appId: APP_ID,
        allowLocalhostAsSecureOrigin: true,
      });
    } catch {
      // "App not configured for web push" — the OneSignal app's Web
      // configuration names a different site origin (every localhost and
      // preview deploy). Nothing below can work without init; the in-app
      // alerts and the server's player-id fallback are unaffected.
      return;
    }

    if (!userId) {
      try {
        await OneSignal.logout();
      } catch {
        /* ignore — worst case the old alias lingers until the next login */
      }
      writeLoggedIn(null);
      return;
    }

    if (readLoggedIn() !== userId) {
      try {
        await OneSignal.login(userId);
        writeLoggedIn(userId);
      } catch {
        /* ignore — the player-id fallback below still registers the device */
      }
    }

    // Persist the id now if already subscribed, and on any later change.
    void savePlayerId(OneSignal.User.PushSubscription.id);
    OneSignal.User.PushSubscription.addEventListener("change", (e) => {
      void savePlayerId(e.current.id);
    });
  });
  loadSdk();
}

export function OneSignalInit({ userId }: { userId: string | null }) {
  useEffect(() => {
    syncPushIdentity(userId);
  }, [userId]);

  return null;
}

/**
 * Called on the page /auth/signout lands on (`?signedout=1`, pwa-provider).
 * Every sign-in page is outside the layouts that mount <OneSignalInit>, so
 * without this a signed-out phone — a shared kitchen tablet, a rider's handed-on
 * phone — kept receiving the previous person's pushes.
 */
export function signOutPush(): void {
  syncPushIdentity(null);
}

/**
 * Subscribe this device to push, from a user gesture.
 *
 * `Notification.requestPermission()` alone grants the browser permission but
 * leaves the OneSignal subscription to the SDK's own change detection; `optIn()`
 * asks for permission if needed AND subscribes, so the id reaches the server on
 * this tap rather than on some later page load. No-op when push isn't configured
 * or the SDK isn't on this page.
 */
export function requestPushOptIn(): void {
  const native = nativePush();
  if (native) {
    // An explicit tap: if permission was denied before, open Android settings.
    void native.requestPermission({ fallbackToSettings: true }).catch(() => {});
    return;
  }
  if (!APP_ID || typeof window === "undefined") return;
  window.OneSignalDeferred = window.OneSignalDeferred ?? [];
  window.OneSignalDeferred.push(async (OneSignal) => {
    try {
      await OneSignal.User.PushSubscription.optIn();
    } catch {
      /* refused or unsupported — the caller's own fallbacks still apply */
    }
  });
}
