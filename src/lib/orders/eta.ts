import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";
import { roadMinutesFor } from "@/lib/orders/road-leg";
import type { OrderStatus } from "@/types";

/**
 * When the food actually arrives — and whether we are already past it.
 *
 * This module decides what a customer believes, so it is written to be boring:
 * pure, synchronous, no I/O, no clock except the one you hand it. Everything it
 * knows arrives as arguments, which is also what makes it safe to run on the
 * server for the first paint and on the client between polls and get the same
 * answer.
 *
 * What it replaces: `etaMinutes = restaurant.eta_min ?? 25`. A per-restaurant
 * constant, chosen at checkout, still on the screen at the door. It could not
 * count down, it could not slip, and it could not admit that an order had been
 * sitting on the pass for twenty minutes waiting for a rider. Meanwhile
 * `platform_settings.default_prep_minutes` — the one number an admin can
 * actually tune — was read by nothing at all.
 *
 * The model, in one paragraph. A restaurant advertises a band (eta_min–eta_max)
 * measured door to door. Split that promise into a kitchen leg and a road leg:
 * the kitchen leg is the admin's `defaultPrepMinutes`, the road leg is the
 * longer of what the band has left over and what the distance actually takes
 * (`road-leg.ts`, when the order has two real pins) — a band is a claim about a
 * kitchen, not about how far this particular address is. Each stage of the order then re-anchors the estimate
 * on the leg that is genuinely still ahead — which is the whole reason the
 * number moves. `placed` still owes prep + road; `kitchen` owes the rest of prep
 * plus road, measured from the moment the kitchen accepted (0026's
 * `accepted_at`); `ready` owes only the road, and owes it from *now*, because
 * nobody has picked it up yet; `on_the_way` owes the road from the moment it
 * left. An estimate is never allowed to be earlier than the checkout promise —
 * we do not talk a customer's expectations up — and never earlier than what is
 * physically still possible, which is what makes lateness fall out for free
 * instead of being a separate guess.
 */

const MINUTE = 60_000;

/**
 * `default_prep_minutes` is a free-text admin field. Clamped rather than
 * trusted: a stray 0 (or a 6000) must not turn every order's estimate into
 * nonsense, and silently substituting the default would hide the typo.
 */
const MIN_PREP_MINUTES = 1;
const MAX_PREP_MINUTES = 180;

/** No road leg is shorter than this, whatever the subtraction produces. */
const MIN_RIDE_MINUTES = 5;

/** Only reached when a restaurant has advertised no band at all. */
const FALLBACK_RIDE_MINUTES = 10;

/**
 * How far past the advertised band an order goes before we call it late.
 *
 * Not a fudge factor: a band is a promise with a range, and a minute either side
 * of its outer edge is noise. Announcing "running 1 minute late" the second the
 * band closes trains people to ignore the message that matters. `lateByMinutes`
 * is still reported from the true edge, so the first thing we ever say is
 * "about 5 minutes late" — understating it would be its own small lie.
 */
const LATE_GRACE_MINUTES = 5;

export interface OrderEtaInput {
  status: OrderStatus;
  /** `orders.created_at`. Without it there is no anchor and no estimate. */
  createdAt: string | null | undefined;
  /** `orders.accepted_at` (0026). Null while awaiting the kitchen — or on a database that predates the migration. */
  acceptedAt?: string | null;
  /** `orders.ready_at` (0026). */
  readyAt?: string | null;
  /** `deliveries.picked_up_at` — when the road leg actually started. */
  pickedUpAt?: string | null;
  /** The restaurant's advertised band, door to door. */
  etaMin?: number | null;
  etaMax?: number | null;
  /** `platform_settings.default_prep_minutes` — the platform-wide fallback. */
  defaultPrepMinutes?: number | null;
  /**
   * `restaurants.prep_minutes` (0036) — this kitchen's own leg, when it has set
   * one. Null inherits `defaultPrepMinutes`.
   *
   * Before this existed the admin default was the kitchen leg for every shop on
   * the platform, so a tandoor and a juice counter were modelled as cooking at
   * identical speed and every estimate split the band the same way.
   */
  restaurantPrepMinutes?: number | null;
  /**
   * Straight-line km from the shop to the address, or null when either end has
   * never been pinned. `roadLegBetween` is what produces it.
   *
   * The estimate's one distance input. Without it the road leg is whatever the
   * restaurant's band has left over after prep, which is a number about this
   * kitchen and not about this delivery: the same 30-minute band covered an
   * address across the street and one 75 km away, and both were counted down
   * identically. Null keeps exactly that old behaviour, because an unpinned
   * address genuinely has no distance and guessing one would be worse.
   */
  straightLineKm?: number | null;
  /** Injected for testing and for re-deriving the countdown between polls. */
  now?: number;
}

export interface OrderEta {
  /**
   * Best current belief about handover, ISO. Null once there is nothing left to
   * wait for (delivered, cancelled) or nothing to anchor on.
   */
  expectedAt: string | null;
  /**
   * The outer edge of what the restaurant advertised, ISO. Lateness is measured
   * from here, not from the optimistic edge the customer was shown.
   */
  dueAt: string | null;
  /** Whole minutes until `expectedAt`, floored at 0. Null when there is no estimate. */
  minutesRemaining: number | null;
  /** True once the overshoot is big enough to be worth saying out loud. */
  late: boolean;
  /**
   * Minutes past `dueAt` — either already elapsed, or now expected. 0 when not
   * late. Reported from the true edge even though `late` waits out the grace.
   */
  lateByMinutes: number;
  /** The kitchen leg, in minutes. */
  prepMinutes: number;
  /**
   * The road leg, in minutes: the longer of the band's leftover and the
   * modelled leg for the distance. This — not the door-to-door promise — is the
   * trip time a map interpolation should use; feeding it the full band is why
   * the rider pin used to crawl.
   */
  rideMinutes: number;
  /**
   * Was there a real distance to model, or is this the restaurant's advertised
   * band repeated back?
   *
   * The two produce a similar-looking number and mean different things: with a
   * distance we modelled THIS delivery, without one we quoted what the shop
   * says about its own cooking. A 70 km order from an unpinned shop reported
   * "25 min" because nothing downstream could tell the difference, so the
   * screen presented a kitchen's claim as a measured arrival time.
   *
   * Describes the INPUT, not which leg won: a nearby address whose modelled leg
   * loses to the band is still measured.
   */
  distanceKnown: boolean;
}

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function positiveMinutes(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The estimate, from whatever the caller could actually find out.
 *
 * Every optional input degrades to something honest rather than something
 * flattering: a database without migration 0026 has no `accepted_at`, so the
 * kitchen stage falls back to "it could finish at any moment" instead of
 * pretending cooking began when the order was placed — which would quietly
 * report a punctual order as overdue.
 */
/**
 * The kitchen leg on its own, in minutes.
 *
 * Split out of `computeOrderEta` so dispatch can quote it to a rider — "ready in
 * about 18 minutes" is the whole point of telling somebody about a pickup
 * before the food exists — without also computing a road leg and a due time it
 * has no use for. One implementation, so the number a rider is told to plan
 * around cannot drift from the number the customer's countdown is built on.
 */
export function kitchenPrepMinutes(input: {
  /** `restaurants.prep_minutes` (0036). */
  restaurantPrepMinutes?: number | null;
  /** `platform_settings.default_prep_minutes`. */
  defaultPrepMinutes?: number | null;
}): number {
  // This kitchen's own pace when it has declared one, the admin's platform-wide
  // number when it hasn't. Same clamp either way: both are free-text fields, and
  // a stray 0 must not turn every estimate into nonsense.
  return clamp(
    positiveMinutes(input.restaurantPrepMinutes) ??
      positiveMinutes(input.defaultPrepMinutes) ??
      DEFAULT_SETTINGS.defaultPrepMinutes,
    MIN_PREP_MINUTES,
    MAX_PREP_MINUTES
  );
}

export function computeOrderEta(input: OrderEtaInput): OrderEta {
  const now = input.now ?? Date.now();

  const prepMinutes = kitchenPrepMinutes(input);

  // The band. eta_min is the number the storefront and checkout showed, so it
  // is what we count down to; eta_max is what we are held to.
  const advertisedMin = positiveMinutes(input.etaMin);
  const advertisedMax = positiveMinutes(input.etaMax);
  const advertised =
    advertisedMin ?? advertisedMax ?? prepMinutes + FALLBACK_RIDE_MINUTES;

  // The band's leftover, which is what this always was.
  const bandRideMinutes = Math.max(advertised - prepMinutes, MIN_RIDE_MINUTES);

  // The modelled leg for the distance actually being covered, when the order
  // has two real pins. Whichever is longer wins: a shop's advertised band still
  // governs the ordinary in-town order it was written for — this must not
  // inflate the normal case — but it cannot promise a 75 km trip in half an
  // hour just because that is the number on the storefront card.
  const modelledRideMinutes = roadMinutesFor(input.straightLineKm);
  // `roadMinutesFor` is the single authority on what counts as a usable
  // distance — it already rejects null, non-finite and negative — so this reads
  // its answer rather than re-testing `straightLineKm` and risking a second,
  // subtly different definition.
  const distanceKnown = modelledRideMinutes !== null;
  const rideMinutes =
    modelledRideMinutes === null
      ? bandRideMinutes
      : Math.max(bandRideMinutes, modelledRideMinutes);

  // A promise shorter than its own two legs would make every order late from
  // the instant it was placed, so the target absorbs the difference. This
  // happens whenever an admin's prep default is longer than a fast
  // restaurant's advertised total, which is a configuration people do make.
  const targetMinutes = Math.max(advertised, prepMinutes + rideMinutes);
  const outerMinutes = Math.max(advertisedMax ?? targetMinutes, targetMinutes);

  const createdMs = parse(input.createdAt);

  const shell = { prepMinutes, rideMinutes, distanceKnown };

  if (createdMs === null) {
    return {
      ...shell,
      expectedAt: null,
      dueAt: null,
      minutesRemaining: null,
      late: false,
      lateByMinutes: 0,
    };
  }

  const targetAtMs = createdMs + targetMinutes * MINUTE;
  const dueAtMs = createdMs + outerMinutes * MINUTE;
  const dueAt = new Date(dueAtMs).toISOString();

  // Delivered or cancelled: there is nothing to wait for, so there is nothing
  // to promise and nobody to be late for.
  if (input.status === "DELIVERED" || input.status === "CANCELLED") {
    return {
      ...shell,
      expectedAt: null,
      dueAt,
      minutesRemaining: null,
      late: false,
      lateByMinutes: 0,
    };
  }

  const acceptedMs = parse(input.acceptedAt);
  const readyMs = parse(input.readyAt);
  const pickedUpMs = parse(input.pickedUpAt);

  // The earliest handover still physically possible, given what has actually
  // happened. This is the half of the estimate that moves.
  let earliestMs: number;

  switch (input.status) {
    case "PLACED":
      // Nobody has started cooking. Whenever they do, it is still a full prep
      // plus a full road from that moment — so every minute the restaurant
      // takes to accept pushes the door time back by a minute. That is not a
      // pessimistic assumption, it is arithmetic.
      earliestMs = now + (prepMinutes + rideMinutes) * MINUTE;
      break;

    case "KITCHEN":
      // Cooking started at accepted_at, so it should be plated at
      // accepted_at + prep — but never before now, because it plainly isn't.
      // Without accepted_at (pre-0026) all we can say is that it might be
      // plated at any moment, which is `now`.
      earliestMs =
        Math.max(
          acceptedMs === null ? now : acceptedMs + prepMinutes * MINUTE,
          now
        ) +
        rideMinutes * MINUTE;
      break;

    case "READY":
      // Packed and waiting for a rider. The road leg has not started, so it can
      // only start now: an order sitting on the pass genuinely does get later
      // by the minute, and this is the one stage the old tracker could not
      // describe at all because `ready` was displayed as `kitchen`.
      earliestMs = now + rideMinutes * MINUTE;
      break;

    case "ON_THE_WAY": {
      // On the road. Deliberately NOT re-floored at `now`: the rider is moving
      // and could knock at any second, so an estimate that has slipped into the
      // past is information ("should be with you"), not an impossibility.
      const leftMs = pickedUpMs ?? readyMs ?? acceptedMs;
      // Nothing recorded when it left — then the checkout promise is genuinely
      // all we know, and inventing a departure from created_at would make every
      // un-migrated order look overdue.
      earliestMs = leftMs === null ? targetAtMs : leftMs + rideMinutes * MINUTE;
      break;
    }

    default:
      earliestMs = targetAtMs;
  }

  const expectedAtMs = Math.max(targetAtMs, earliestMs);

  // Overshoot is whichever is worse: how far past the band we already are, or
  // how far past it we now expect to end up.
  const overshootMs = Math.max(expectedAtMs, now) - dueAtMs;
  const overshootMinutes = Math.max(0, Math.round(overshootMs / MINUTE));
  const late = overshootMinutes >= LATE_GRACE_MINUTES;

  return {
    ...shell,
    expectedAt: new Date(expectedAtMs).toISOString(),
    dueAt,
    minutesRemaining: Math.max(0, Math.ceil((expectedAtMs - now) / MINUTE)),
    late,
    // Zeroed below the grace so the two fields can never disagree — a caller
    // that renders the number without checking the flag still says nothing.
    lateByMinutes: late ? overshootMinutes : 0,
  };
}
