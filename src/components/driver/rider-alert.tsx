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
 * Tells a rider a job has appeared in the available pool.
 *
 * The rider board had no alert of any kind — a rider had to be looking at the
 * screen, or refresh it, to notice a new pickup. Mirrors `kitchen-alert.tsx`
 * exactly (same arm/disarm/localStorage pattern, same three channels: tone,
 * vibration, system notification) rather than sharing code with it, so each
 * stays a single self-contained unit — see that file for the full reasoning
 * on why a button is required at all (a browser will not start audio or ask
 * for notification permission without a user gesture).
 *
 * `incomingIds` is expected to already be empty while the rider has an active
 * delivery — the pool is not something they can act on then, so the caller
 * (driver-board.tsx) passes `[]` rather than this component special-casing it.
 */

const STORAGE_KEY = "deligro-rider-alerts";
/** Back-to-back, until the pool is empty or the rider has a job — see kitchen-alert.tsx. */
const RING_REPEAT_MS = 2_500;

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

function disarm(): void {
  writeArmed(false);
}

function subscribeNever(): () => void {
  return () => {};
}

function audioSupported(): boolean {
  return window.AudioContext !== undefined;
}

function audioSupportedOnServer(): boolean {
  return true;
}

export function RiderAlert({
  /** Ids currently in the available pool. Empty while a delivery is active. */
  incomingIds,
  /** From platform_settings (0044), admin-configured — same for every rider. */
  soundPreset = "chime",
  soundUrl = null,
}: Readonly<{
  incomingIds: string[];
  soundPreset?: string;
  soundUrl?: string | null;
}>) {
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
  const [audioFailed, setAudioFailed] = useState(false);
  const on = armed && supported && !audioFailed;

  const audioRef = useRef<AudioContext | null>(null);
  const announced = useRef<Set<string>>(new Set());
  const lastRepeat = useRef(0);
  const seeded = useRef(false);

  const fire = useCallback(
    (count: number) => {
      const ctx = audioRef.current;
      if (ctx) {
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
          new Notification(count > 1 ? `${count} jobs available` : "New job available", {
            body: "Open the app to accept it before someone else does.",
            tag: "deligro-new-job",
            requireInteraction: true,
          });
        } catch {
          // Some browsers refuse constructor notifications outside a service
          // worker. The tone and the vibration still did their job.
        }
      }
    },
    [soundPreset, soundUrl]
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
      playAlertSound(ctx, soundPreset, soundUrl);
    } catch {
      setAudioFailed(true);
      return;
    }

    if (typeof Notification !== "undefined" && Notification.permission === "default") {
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

  // New arrivals.
  useEffect(() => {
    if (!on) return;

    if (!seeded.current) {
      seeded.current = true;
      announced.current = new Set(incomingIds);
      lastRepeat.current = Date.now();
      return;
    }

    const fresh = incomingIds.filter((id) => !announced.current.has(id));
    announced.current = new Set(incomingIds);
    if (fresh.length === 0) return;
    lastRepeat.current = Date.now();
    fire(incomingIds.length);
  }, [incomingIds, on, fire]);

  // Still unclaimed — keep ringing. Not inside the Android app: the native ring
  // below is already doing it.
  useEffect(() => {
    if (!on || incomingIds.length === 0 || nativeRing()) return;
    const id = setInterval(() => {
      if (Date.now() - lastRepeat.current < RING_REPEAT_MS) return;
      lastRepeat.current = Date.now();
      ringTone();
    }, 500);
    return () => clearInterval(id);
  }, [incomingIds, on, ringTone]);

  // Inside the Android app: ring natively for every job in the pool, and stop
  // when it leaves — taken by this rider (the caller then passes []), taken by
  // someone else, or cancelled. Covers a ring push that never arrived.
  const nativeSeen = useRef<string[]>([]);
  useEffect(() => {
    const ring = nativeRing();
    if (!ring) return;
    const { started, stopped } = ringDiff(nativeSeen.current, incomingIds);
    nativeSeen.current = incomingIds;
    for (const id of started) {
      void ring
        .startRing({
          ringId: ringId("rider", id),
          title: "New pickup 🛵",
          body: "Accept",
          timeoutSec: RING_TIMEOUT_SEC.rider,
        })
        .catch(() => {});
    }
    for (const id of stopped) {
      void ring.stopRing({ ringId: ringId("rider", id) }).catch(() => {});
    }
  }, [incomingIds]);

  if (!supported) return null;

  // One compact row: status dot-icon, a two-line label, one small action.
  // This was a full-width red panel with a paragraph of bilingual copy and a
  // button as wide as the screen — the loudest thing on the page for what is a
  // single on/off setting. The red is now confined to the icon.
  let title = "Alerts off";
  let detail = "New jobs will arrive silently.";
  if (on) {
    title = "Alerts on";
    detail = "Sound and vibration for new jobs.";
  } else if (audioFailed) {
    title = "Couldn't start the alert sound";
    detail = "Try again, or use another device.";
  }

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
