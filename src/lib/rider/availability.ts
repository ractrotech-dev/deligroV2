/**
 * Rider availability — the rules, with no database and no clock of their own.
 *
 * Pure on purpose (no `server-only`, no imports): `scripts/qa/rider-availability.ts`
 * runs it under tsx, and the data layer (`lib/data-access/rider-status.ts`) is
 * a thin wrapper that loads the row, asks this module what the next row is,
 * and writes it. The server decides; the app only asks.
 *
 * ## What "available" means
 *
 * A rider is dispatchable when all three hold:
 *   1. they are online (they tapped Go online and have not gone offline);
 *   2. they are not on a break that ends after now;
 *   3. their phone has reported a position within RIDER_PRESENCE_MS.
 *
 * (3) is what keeps a dead phone from staying "online": the flag is only ever
 * a claim, the fix is the evidence. An online rider whose fix has gone stale is
 * phase "stale" — still in a shift, but dispatch skips them.
 */

/** A fix older than this takes an online rider out of dispatch. */
export const RIDER_PRESENCE_MS = 5 * 60_000;

/** Break lengths the app offers. `null` (until I resume) is the fourth. */
export const BREAK_MINUTES = [15, 30, 60] as const;

/**
 * "Until I resume" is stored as a far-future `break_until` rather than a second
 * column: every reader keeps asking the one question, "does the break end after
 * now?", and the answer is simply yes until the rider resumes (ruling R4).
 */
export const BREAK_UNTIL_RESUMED = "9999-12-31T00:00:00.000Z";

export type AvailabilityAction = "online" | "offline" | "break" | "resume";

export interface RiderAvailability {
  isOnline: boolean;
  /** ISO instant the current break ends; null when not on a break. */
  breakUntil: string | null;
  /** When the current shift began; null while offline. */
  onlineSince: string | null;
  /** When the last position arrived; null if none is kept. */
  lastFixAt: string | null;
}

export type AvailabilityResult =
  | { ok: true; next: RiderAvailability; shift: "open" | "close" | "none" }
  | { ok: false; error: "active_delivery" | "invalid_minutes" | "not_online" };

export interface AvailabilityContext {
  /**
   * The rider is carrying a delivery, or holds an offer they have not answered.
   * Computed by the caller from the database — this module has no way to know.
   */
  hasCommitment: boolean;
  now: Date;
  /** For `break` only: one of BREAK_MINUTES, or null for "until I resume". */
  minutes?: number | null;
}

/** The state the rider ends up in after `action`, or why they may not. */
export function nextAvailability(
  current: RiderAvailability,
  action: AvailabilityAction,
  ctx: AvailabilityContext
): AvailabilityResult {
  const now = ctx.now.toISOString();

  switch (action) {
    case "online": {
      if (!current.isOnline) {
        return {
          ok: true,
          shift: "open",
          // A fresh shift carries nothing over: no leftover break, and no fix
          // from the last one — presence has to be earned again.
          next: { isOnline: true, breakUntil: null, onlineSince: now, lastFixAt: null },
        };
      }
      // Already in a shift. Tapping online while on a break ends the break
      // (the rider means "I'm back"); the shift is untouched.
      return {
        ok: true,
        shift: "none",
        next: current.breakUntil ? { ...current, breakUntil: null } : current,
      };
    }

    case "offline": {
      if (!current.isOnline) return { ok: true, shift: "none", next: current };
      if (ctx.hasCommitment) return { ok: false, error: "active_delivery" };
      return {
        ok: true,
        shift: "close",
        // No position is kept for an offline rider.
        next: { isOnline: false, breakUntil: null, onlineSince: null, lastFixAt: null },
      };
    }

    case "break": {
      if (!current.isOnline) return { ok: false, error: "not_online" };
      if (ctx.hasCommitment) return { ok: false, error: "active_delivery" };
      const minutes = ctx.minutes;
      let until: string;
      if (minutes === null) {
        until = BREAK_UNTIL_RESUMED;
      } else if (
        typeof minutes === "number" &&
        (BREAK_MINUTES as readonly number[]).includes(minutes)
      ) {
        until = new Date(ctx.now.getTime() + minutes * 60_000).toISOString();
      } else {
        return { ok: false, error: "invalid_minutes" };
      }
      return { ok: true, shift: "none", next: { ...current, breakUntil: until } };
    }

    case "resume": {
      if (!current.isOnline) return { ok: false, error: "not_online" };
      return {
        ok: true,
        shift: "none",
        next: current.breakUntil ? { ...current, breakUntil: null } : current,
      };
    }
  }
}

function instant(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function onBreak(s: RiderAvailability, nowMs: number): boolean {
  const until = instant(s.breakUntil);
  return until !== null && until > nowMs;
}

/**
 * Whether the position is recent. Compared in both directions: a phone whose
 * clock runs far ahead would otherwise report fixes "from the future" that
 * never age out, and a rider with a dead battery would stay dispatchable.
 */
function fixIsFresh(s: RiderAvailability, nowMs: number): boolean {
  const fix = instant(s.lastFixAt);
  return fix !== null && Math.abs(nowMs - fix) < RIDER_PRESENCE_MS;
}

/** Whether dispatch may offer this rider a job right now. */
export function isDispatchable(s: RiderAvailability, now: Date): boolean {
  const nowMs = now.getTime();
  return s.isOnline && !onBreak(s, nowMs) && fixIsFresh(s, nowMs);
}

/**
 * What the app should show:
 *   offline — not in a shift;
 *   break   — in a shift, paused (outranks stale: the rider chose to pause);
 *   stale   — in a shift, but no recent position, so dispatch is skipping them;
 *   online  — dispatchable.
 */
export function riderPhase(
  s: RiderAvailability,
  now: Date
): "offline" | "online" | "break" | "stale" {
  if (!s.isOnline) return "offline";
  const nowMs = now.getTime();
  if (onBreak(s, nowMs)) return "break";
  return fixIsFresh(s, nowMs) ? "online" : "stale";
}
