"use client";

import { useEffect, useState, useTransition } from "react";
import { Coffee, Loader2, Play, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/confirm-dialog";
import { setAvailabilityAction } from "@/app/driver/actions";
import { BREAK_MINUTES, riderPhase, type RiderAvailability } from "@/lib/rider/availability";
import { breakLabel } from "@/lib/rider/break-label";
import { cn } from "@/lib/utils/cn";

/** Same refresh cadence as the board, but only to notice a fix going stale or a break ending. */
const CLOCK_TICK_MS = 15_000;

type AvailabilityAnswer = Awaited<ReturnType<typeof setAvailabilityAction>>;
type AvailabilityError = Extract<AvailabilityAnswer, { ok: false }>["error"];

/** The sentence a rider reads when the server said no. */
function errorMessage(code: AvailabilityError): string {
  switch (code) {
    case "active_delivery":
      return "Finish or hand back your current order first.";
    case "unavailable":
      return "Online status isn't available yet — Deligro is updating.";
    case "rate_limited":
      return "Too many changes — wait a minute and try again.";
    case "not_online":
      return "You're not online. Go online first.";
    case "invalid_minutes":
      return "Pick one of the break lengths listed.";
    default:
      return "Couldn't update your status. Try again.";
  }
}

const OFFLINE_NOTE = "Couldn't reach Deligro — check your internet and try again.";

/** Break lengths offered; `null` is "until I resume". The numbers are the server's (BREAK_MINUTES). */
const BREAK_CHOICES: readonly { minutes: number | null; label: string }[] = [
  ...BREAK_MINUTES.map((minutes) => ({
    minutes,
    label: minutes === 60 ? "1 hour" : `${minutes} minutes`,
  })),
  { minutes: null, label: "Until I resume" },
];

type LocationState = "off" | "starting" | "reporting" | "denied" | "unavailable";

const PHASE_LOOK = {
  offline: { title: "Offline", badge: "bg-surface-2 text-muted" },
  online: { title: "Online", badge: "bg-green-soft text-green" },
  break: { title: "On a break", badge: "bg-accent-soft text-accent-ink" },
  // In a shift but dispatch is skipping them: no recent position. Said in the
  // colour that means "look at this", because the rider thinks they are online.
  stale: { title: "Online", badge: "bg-deal-soft text-deal" },
} as const;

function subtitle(
  phase: keyof typeof PHASE_LOOK,
  availability: RiderAvailability,
  location: LocationState,
  delivering: boolean
): string {
  switch (phase) {
    case "offline":
      return "You won't get job offers";
    case "break":
      return breakLabel(availability.breakUntil) ?? "You won't get job offers";
    case "stale":
      if (location === "denied") return "Allow location to get job offers";
      if (location === "unavailable") return "This browser can't share your location";
      return "Waiting for your location…";
    default:
      return delivering ? "Delivering now" : "You're getting job offers";
  }
}

/**
 * The rider's Online / Offline / On a break switch, for the web portal.
 *
 * The server decides — every tap goes through `setAvailabilityAction`, which
 * runs the same rules as `/api/rider/status` — and this component only shows
 * what came back. The state it draws is the `availability` prop (the page
 * re-renders every few seconds and after every action), never a local guess, so
 * a status changed from the rider's phone shows here too.
 *
 * Lives in the phone frame, so: tokens only, no viewport breakpoints.
 */
export function AvailabilitySwitch({
  availability,
  location,
  delivering,
}: Readonly<{
  availability: RiderAvailability;
  /** What the board's location watch is doing, to explain a rider with no position. */
  location: LocationState;
  /** A delivery is in flight (the server will refuse a break or go-offline). */
  delivering: boolean;
}>) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const phase = riderPhase(availability, new Date(now));
  const look = PHASE_LOOK[phase];

  function run(action: "online" | "offline" | "break" | "resume", minutes?: number | null) {
    setMessage(null);
    // Closed straight away: the spinner is on the button the menu opened from.
    setMenuOpen(false);
    setBusyAction(action);
    startTransition(async () => {
      try {
        const result = await setAvailabilityAction(action, minutes);
        if (!result.ok) setMessage(errorMessage(result.error));
      } catch {
        // No signal, or the server threw. Uncaught, this would replace the whole
        // board with the route's error page.
        setMessage(OFFLINE_NOTE);
      } finally {
        setBusyAction(null);
      }
    });
  }

  const busy = (action: string) => pending && busyAction === action;

  return (
    <section aria-label="Availability" className="card p-3.5">
      <div className="flex items-center gap-3">
        <span
          className={cn("grid size-10 shrink-0 place-items-center rounded-full", look.badge)}
        >
          <Power className="size-5" />
        </span>
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="text-[17px] font-extrabold leading-none tracking-tight">{look.title}</p>
          <p className="mt-1.5 text-xs text-muted">
            {subtitle(phase, availability, location, delivering)}
          </p>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        {phase === "offline" ? (
          <Button
            size="md"
            className="min-w-0 flex-1"
            disabled={pending}
            onClick={() => run("online")}
          >
            {busy("online") ? <Loader2 className="size-5 animate-spin" /> : "Go online"}
          </Button>
        ) : (
          <>
            {phase === "break" ? (
              <Button
                size="md"
                className="min-w-0 flex-1"
                disabled={pending}
                onClick={() => run("resume")}
              >
                {busy("resume") ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <>
                    <Play className="size-4" /> Resume
                  </>
                )}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="md"
                className="min-w-0 flex-1"
                disabled={pending}
                onClick={() => setMenuOpen(true)}
              >
                {busy("break") ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <>
                    <Coffee className="size-4" /> Take a break
                  </>
                )}
              </Button>
            )}
            <Button
              variant="outline"
              size="md"
              className="min-w-0 flex-1"
              disabled={pending}
              onClick={() => run("offline")}
            >
              {busy("offline") ? <Loader2 className="size-5 animate-spin" /> : "Go offline"}
            </Button>
          </>
        )}
      </div>

      {message ? (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-deal-soft px-3 py-2 text-sm font-semibold text-deal"
        >
          {message}
        </p>
      ) : null}

      <Modal open={menuOpen} onClose={() => setMenuOpen(false)} title="Take a break">
        <div className="space-y-2">
          <p className="text-sm text-muted">
            You stay on shift but won&apos;t be offered new orders until the break ends.
          </p>
          {BREAK_CHOICES.map((choice) => (
            <Button
              key={choice.label}
              variant="outline"
              size="lg"
              className="w-full"
              disabled={pending}
              onClick={() => run("break", choice.minutes)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      </Modal>
    </section>
  );
}
