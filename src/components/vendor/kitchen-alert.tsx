"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { playAlertSound } from "@/lib/alerts/tones";
import { requestPushOptIn } from "@/components/notifications/onesignal-init";
import { nativeRing, ringDiff } from "@/lib/native/bridge";
import { ringId, RING_TIMEOUT_SEC } from "@/lib/alerts/ring";

/**
 * Tells the kitchen an order has arrived.
 *
 * The board had no alert of any kind: arrival was discovered by an 8-second
 * `router.refresh()` that only ran while the tab was visible. A tablet on
 * another tab, asleep, or simply not being watched accumulated orders in
 * silence — a 3-minute acceptance time turning into 30, and every downstream
 * ETA the customer was promised going with it. Server-side push
 * (`notifyVendorNewOrder`) covers a board that isn't running at all; arming
 * here also subscribes the device to it (`requestPushOptIn`).
 *
 * Three channels, because a kitchen defeats any one of them: a tone loud enough
 * to hear over extraction fans, a vibration for a tablet on a steel counter, and
 * a system notification for when the tab is in the background.
 *
 * ## Why this needs a button
 *
 * Neither audio nor notifications can be started by a page on its own — the
 * browser requires a user gesture to unlock an AudioContext, and a user gesture
 * to prompt for Notification permission. So the kitchen arms it once per device
 * and the choice is remembered in localStorage. Nothing here can be enabled
 * behind the operator's back, which is also why the disarmed state is visible
 * rather than silent: a board that looks armed and isn't is the failure this
 * component exists to fix.
 */

const STORAGE_KEY = "deligro-kitchen-alerts";

/**
 * How often the tone repeats while an order waits in New.
 *
 * It used to be 25 s — a beep now and then, easy to miss over a busy kitchen.
 * The owner asked for a ring that does not stop until somebody accepts or
 * rejects, so in a browser the tone now repeats back-to-back until the order
 * leaves the New column. Inside the Android app the native ring does this
 * instead (lib/alerts/ring.ts) and this tone stays quiet, so the two never play
 * over each other.
 */
const RING_REPEAT_MS = 2_500;

/* ------------------------------------------------------------------
 * The armed preference, and whether this device can alert at all, are both
 * external state — localStorage and a browser capability. They are read with
 * `useSyncExternalStore` rather than copied into React state by a mount effect,
 * which is what that hook is for and what keeps the server render (never armed,
 * assume capable) from mismatching the client's.
 *
 * The listener list exists because `storage` events do not fire in the tab that
 * wrote them, so the Mute button has to notify this tab itself.
 * ------------------------------------------------------------------ */

const armedListeners = new Set<() => void>();

function subscribeArmed(cb: () => void): () => void {
  armedListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    armedListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function armedSnapshot(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    // Private mode / storage disabled. Not armed, and the button still works
    // for this session.
    return false;
  }
}

function armedServerSnapshot(): boolean {
  return false;
}

function writeArmed(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    /* ignore — the in-memory toggle below still takes effect */
  }
  for (const cb of armedListeners) cb();
}

/** Capability never changes within a page's life, so nothing to subscribe to. */
function subscribeNever(): () => void {
  return () => {};
}

function audioSupported(): boolean {
  return typeof window.AudioContext !== "undefined";
}

function audioSupportedOnServer(): boolean {
  return true;
}

export function KitchenAlert({
  /** Ids currently in the New column. Membership is the alert condition. */
  incomingIds,
  restaurantName,
  /** From platform_settings (0044), admin-configured — same for every vendor. */
  soundPreset = "chime",
  soundUrl = null,
}: {
  incomingIds: string[];
  restaurantName?: string;
  soundPreset?: string;
  soundUrl?: string | null;
}) {
  const armed = useSyncExternalStore(
    subscribeArmed,
    armedSnapshot,
    armedServerSnapshot
  );
  const supported = useSyncExternalStore(
    subscribeNever,
    audioSupported,
    audioSupportedOnServer
  );
  /** Set only from the arm handler, when the browser refuses to give us audio. */
  const [audioFailed, setAudioFailed] = useState(false);
  const on = armed && supported && !audioFailed;

  const audioRef = useRef<AudioContext | null>(null);
  /**
   * Ids we have already announced. Seeded on arm rather than starting empty, so
   * switching alerts on does not immediately shout about the orders already
   * sitting on the board.
   */
  const announced = useRef<Set<string>>(new Set());
  const lastRepeat = useRef(0);
  /**
   * True until the first announcement pass has run against a board that was
   * already armed on load — so restoring the preference does not immediately
   * shout about orders that were sitting there before the page opened.
   */
  const seeded = useRef(false);

  const fire = useCallback(
    (count: number) => {
      const ctx = audioRef.current;
      if (ctx) {
        // A context can be suspended out from under us (tab backgrounded, OS
        // audio focus lost). Resuming is a no-op when it is already running.
        void ctx
          .resume()
          .then(() => playAlertSound(ctx, soundPreset, soundUrl))
          .catch(() => {});
      }

      navigator.vibrate?.([200, 100, 200]);

      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification(
            count > 1 ? `${count} new orders` : "New order",
            {
              body: restaurantName
                ? `Waiting to be accepted at ${restaurantName}.`
                : "Waiting to be accepted.",
              // Collapses repeats into one notification instead of stacking a
              // wall of them over an unattended lunch rush.
              tag: "deligro-new-order",
              requireInteraction: true,
            }
          );
        } catch {
          // Some browsers refuse constructor notifications outside a service
          // worker. The tone and the vibration still did their job.
        }
      }
    },
    [restaurantName, soundPreset, soundUrl]
  );

  /** The repeat: tone and buzz only — one system notification per arrival is enough. */
  const ringTone = useCallback(() => {
    const ctx = audioRef.current;
    if (ctx) {
      void ctx
        .resume()
        .then(() => playAlertSound(ctx, soundPreset, soundUrl))
        .catch(() => {});
    }
    navigator.vibrate?.([200, 100, 200]);
  }, [soundPreset, soundUrl]);

  async function arm() {
    try {
      const ctx = audioRef.current ?? new AudioContext();
      audioRef.current = ctx;
      await ctx.resume();
      // Confirms out loud that alerts work — the only way the kitchen learns
      // the volume is up before an order depends on it.
      playAlertSound(ctx, soundPreset, soundUrl);
    } catch {
      setAudioFailed(true);
      return;
    }

    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      // Best effort: a refused prompt still leaves sound and vibration.
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }

    // Same tap subscribes this device to server push, which is what reaches
    // it when the board isn't running at all — a sleeping screen, a closed tab.
    requestPushOptIn();

    announced.current = new Set(incomingIds);
    seeded.current = true;
    lastRepeat.current = Date.now();
    setAudioFailed(false);
    writeArmed(true);
  }

  function disarm() {
    writeArmed(false);
  }

  // New arrivals.
  useEffect(() => {
    if (!on) return;

    if (!seeded.current) {
      // Armed from a restored preference: adopt what is already on the board
      // without announcing it, then alert on everything after.
      seeded.current = true;
      announced.current = new Set(incomingIds);
      lastRepeat.current = Date.now();
      return;
    }

    const fresh = incomingIds.filter((id) => !announced.current.has(id));
    // Drop ids that have left the column, so an order re-entering it (an undone
    // rejection) announces itself again rather than being silently remembered.
    announced.current = new Set(incomingIds);
    if (fresh.length === 0) return;
    lastRepeat.current = Date.now();
    fire(incomingIds.length);
  }, [incomingIds, on, fire]);

  // Still unaccepted — keep ringing until the New column is empty. Not inside
  // the Android app: the native ring below is already doing it.
  useEffect(() => {
    if (!on || incomingIds.length === 0 || nativeRing()) return;
    const id = setInterval(() => {
      if (Date.now() - lastRepeat.current < RING_REPEAT_MS) return;
      lastRepeat.current = Date.now();
      ringTone();
    }, 500);
    return () => clearInterval(id);
  }, [incomingIds, on, ringTone]);

  // Inside the Android app: ring natively for every order in New, and stop the
  // moment it leaves (accepted, rejected, or cancelled by the customer). Covers
  // a ring push that never arrived. Needs no arming — the native ring does not
  // depend on a browser gesture. Orders already waiting when the board opens
  // ring too: they are still unanswered.
  const nativeSeen = useRef<string[]>([]);
  useEffect(() => {
    const ring = nativeRing();
    if (!ring) return;
    const { started, stopped } = ringDiff(nativeSeen.current, incomingIds);
    nativeSeen.current = incomingIds;
    for (const id of started) {
      void ring
        .startRing({
          ringId: ringId("vendor", id),
          title: "New order 🔔",
          body: restaurantName
            ? `${restaurantName} — Accept`
            : "Accept",
          timeoutSec: RING_TIMEOUT_SEC.vendor,
        })
        .catch(() => {});
    }
    for (const id of stopped) {
      void ring.stopRing({ ringId: ringId("vendor", id) }).catch(() => {});
    }
  }, [incomingIds, restaurantName]);

  if (!supported) return null;

  // One compact row: status dot-icon, a two-line label, one small action.
  // This was a full-width red panel with a paragraph of bilingual copy and a
  // button as wide as the screen — the loudest thing on the page for what is a
  // single on/off setting. The red is now confined to the icon.
  const title = on
    ? "Alerts on"
    : audioFailed
      ? "Couldn't start the alert sound"
      : "Alerts off";
  const detail = on
    ? "Sound and vibration for new orders."
    : audioFailed
      ? "Try again, or use another device."
      : "New orders will arrive silently.";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <span
        className={
          on
            ? "grid size-8 shrink-0 place-items-center rounded-full bg-green/10 text-green"
            : "grid size-8 shrink-0 place-items-center rounded-full bg-deal-soft text-deal"
        }
      >
        {on ? <BellRing className="size-4" /> : <BellOff className="size-4" />}
      </span>
      <p className="min-w-0 flex-1 leading-tight">
        <span className="block text-sm font-bold">{title}</span>
        <span className="mt-0.5 block text-xs text-muted">{detail}</span>
      </p>
      {on ? (
        <Button variant="ghost" size="sm" onClick={disarm} className="shrink-0">
          Mute
        </Button>
      ) : (
        <Button size="sm" onClick={arm} className="shrink-0">
          <Bell className="size-4" /> Turn on
        </Button>
      )}
    </div>
  );
}
