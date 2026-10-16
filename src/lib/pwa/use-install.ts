"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Install state for the "add to home screen" affordance.
 *
 * Deliberately does not prompt on its own. `beforeinstallprompt` is captured and
 * held; the banner that uses it only appears after a few visits, and a dismissal
 * is remembered. An install prompt thrown at a first-time visitor mid-order is
 * the kind of thing that loses the order.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "deligro-install-dismissed";
const VISITS_KEY = "deligro-visits";
/** Enough visits to suggest the app is actually being used. */
const VISITS_BEFORE_PROMPT = 3;

/** iOS Safari never fires `beforeinstallprompt`; it installs from the Share sheet. */
function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports as a Mac; the touch points give it away.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Safari's own, non-standard, flag.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function subscribeStandalone(callback: () => void): () => void {
  const query = window.matchMedia("(display-mode: standalone)");
  query.addEventListener("change", callback);
  window.addEventListener("appinstalled", callback);
  return () => {
    query.removeEventListener("change", callback);
    window.removeEventListener("appinstalled", callback);
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode, or storage blocked. Treat as "nothing remembered".
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export interface InstallState {
  /** Already running as an installed app — never offer to install. */
  installed: boolean;
  /** A real prompt is held and can be shown. */
  canPrompt: boolean;
  /** No prompt API, but the browser can install via its own UI (iOS Safari). */
  needsManualSteps: boolean;
  /** Enough signal to be worth asking, and not previously dismissed. */
  shouldSuggest: boolean;
  promptInstall: () => Promise<"accepted" | "dismissed" | "unavailable">;
  dismiss: () => void;
}

export function useInstall(): InstallState {
  // Assume installed on the server so nothing install-related is ever part of
  // the SSR output; the real answer arrives with the client snapshot.
  const installed = useSyncExternalStore(
    subscribeStandalone,
    isStandalone,
    () => true
  );

  // Read once, during the first client render. A lazy initializer rather than
  // an effect: this is derived-on-mount state, not a subscription, and setting
  // it from an effect body is both a wasted render and a lint error.
  const [visits] = useState(() => {
    if (typeof window === "undefined") return 0;
    const seen = Number(read(VISITS_KEY) ?? "0") + 1;
    write(VISITS_KEY, String(seen));
    return seen;
  });

  const [dismissed, setDismissed] = useState(() =>
    typeof window === "undefined" ? true : read(DISMISSED_KEY) === "1"
  );

  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [ios] = useState(() => isIos());

  useEffect(() => {
    const onBeforePrompt = (event: Event) => {
      // Holding the event is what lets the app choose the moment. Without
      // preventDefault Chrome shows its own mini-infobar immediately.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);

    window.addEventListener("beforeinstallprompt", onBeforePrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforePrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return "unavailable" as const;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // The event is single-use — Chrome fires a fresh one if the app still
    // qualifies, so drop this one either way.
    setDeferred(null);
    if (outcome === "dismissed") {
      write(DISMISSED_KEY, "1");
      setDismissed(true);
    }
    return outcome;
  }, [deferred]);

  const dismiss = useCallback(() => {
    write(DISMISSED_KEY, "1");
    setDismissed(true);
  }, []);

  const canPrompt = deferred !== null;
  const needsManualSteps = ios && !installed && !canPrompt;

  return {
    installed,
    canPrompt,
    needsManualSteps,
    shouldSuggest:
      !installed &&
      !dismissed &&
      visits >= VISITS_BEFORE_PROMPT &&
      (canPrompt || needsManualSteps),
    promptInstall,
    dismiss,
  };
}
