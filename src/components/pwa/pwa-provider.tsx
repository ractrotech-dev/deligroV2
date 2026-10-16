"use client";

import { useEffect, useState } from "react";
import { signOutPush } from "@/components/notifications/onesignal-init";
import { clearLocationCache } from "@/stores/location-store";
import { usePathname, useRouter } from "next/navigation";
import { PortalToShell } from "@/components/shared/portal-to-shell";
import {
  clearAppCaches,
  registerServiceWorker,
} from "@/lib/pwa/service-worker";
import { useIsClient } from "@/lib/pwa/use-is-client";
import { useConnection } from "@/lib/pwa/use-connection";
import { useInstall } from "@/lib/pwa/use-install";
import { ConnectionStatus } from "@/components/pwa/connection-status";
import { InstallPrompt } from "@/components/pwa/install-prompt";
import { UpdateBanner } from "@/components/pwa/update-banner";
import { LANG_COOKIE, parseLang, translator, type Lang } from "@/lib/i18n/lang";

/**
 * The customer app's routes. This provider sits in the root layout, above the
 * customer LangProvider, so it reads the language cookie itself — and only on
 * these paths: the operator consoles are not translated, and a customer's
 * Hindi choice on a shared phone must not leak into them.
 */
const CUSTOMER_PATH =
  /^\/(?:$|(?:checkout|location|orders|profile|restaurant|search|stores|login)(?:\/|$))/;

function cookieLang(): Lang {
  const match = new RegExp(`(?:^|; )${LANG_COOKIE}=([^;]*)`).exec(document.cookie);
  return parseLang(match?.[1]);
}

/**
 * The one place the PWA layer is wired in. Mounted once from the root layout,
 * so every portal gets it — the customer app, and equally the vendor, rider and
 * admin consoles, which is where a dropped connection actually costs someone
 * money.
 *
 * Renders nothing at all in the common case. Every piece below is conditional,
 * and each degrades to null on a browser that cannot do it, so this is inert on
 * anything from an old iOS Safari to a Firefox private window.
 *
 * Overlays go through `PortalToShell` for the same reason every other overlay
 * in this app does: `.app-shell` carries a transform, so a `position: fixed`
 * child rendered outside it would anchor to the viewport and float off the
 * phone frame on desktop.
 */
export function PwaProvider() {
  const router = useRouter();
  const pathname = usePathname();

  const { online, slow, recoveredAt } = useConnection();
  const install = useInstall();

  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const isClient = useIsClient();

  useEffect(() => {
    // setRegistration is called from the registration callback, not
    // synchronously here, so this stays a subscription rather than a cascading
    // render.
    void registerServiceWorker(setRegistration);
  }, []);

  // Coming back from a dead connection, the screen is showing whatever it had
  // when the signal went. `router.refresh()` re-runs the server components for
  // the current route without touching client state — the cart, a half-filled
  // form and the scroll position all survive, which a location.reload() would
  // not.
  useEffect(() => {
    if (!recoveredAt) return;
    router.refresh();
  }, [recoveredAt, router]);

  // A session just ended: drop every cached page. The navigation cache only
  // ever holds public pages, but "public" stops meaning "fine to show whoever
  // picks up this phone next" the moment someone deliberately signs out.
  //
  // Keyed on the `?signedout=1` marker that /auth/signout adds, NOT on being on
  // a login page. That was the first implementation and it was wrong in a way
  // that quietly defeated the whole cache: /login is the customer app's entry
  // screen, so every anonymous visitor lands there and every visit wiped the
  // caches — verified in a headless-Chrome run, where the precached offline
  // page disappeared between two ordinary navigations.
  //
  // Doing it here rather than on the sign-out buttons is still deliberate:
  // sign-out is a plain <form method="post"> in ten places across four portals
  // with no JavaScript in the path, and each would have had to become a client
  // component to run a callback.
  // Read off `window.location` rather than with `useSearchParams()`. This
  // component lives in the ROOT layout, and `useSearchParams` there opts every
  // page in the app out of static rendering unless it is wrapped in Suspense —
  // a real cost, paid on every route, for a flag that is only ever read once in
  // the browser.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("signedout") === "1") {
      void clearAppCaches();
      // The address this phone last showed belongs to the person who just left.
      clearLocationCache();
      // And detach this device from the signed-out person's pushes (native
      // app or web). Sign-in pages don't mount <OneSignalInit>, so nothing
      // else would.
      signOutPush();
    }
  }, []);

  // Nothing is rendered until after hydration. These overlays depend on
  // browser-only state (display-mode, localStorage, navigator.onLine), so
  // server-rendering them would produce a mismatch and a flash.
  if (!isClient) return null;

  const showUpdate = registration !== null && !updateDismissed;
  const t = translator(CUSTOMER_PATH.test(pathname) ? cookieLang() : "en");

  return (
    <PortalToShell>
      {/* Keyed on the recovery timestamp: each reconnection is a fresh mount, so
          the "Back online" confirmation restarts cleanly instead of needing the
          child to reset its own timer from an effect. */}
      <ConnectionStatus
        key={recoveredAt}
        online={online}
        slow={slow}
        recoveredAt={recoveredAt}
        t={t}
      />

      {showUpdate ? (
        <UpdateBanner
          registration={registration}
          onDismiss={() => setUpdateDismissed(true)}
          t={t}
        />
      ) : null}

      {/* An install nudge is the lowest-priority thing on screen: it waits for
          the update banner to be gone, and never competes with an offline
          warning the user needs to read. */}
      {!showUpdate && online && install.shouldSuggest ? (
        <InstallPrompt
          manual={install.needsManualSteps}
          onInstall={() => void install.promptInstall()}
          onDismiss={install.dismiss}
          t={t}
        />
      ) : null}
    </PortalToShell>
  );
}
