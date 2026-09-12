"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Banknote,
  Bike,
  ChefHat,
  MapPin,
  Package,
  Navigation,
  Phone,
  CheckCircle2,
  KeyRound,
  Loader2,
  LocateFixed,
  LocateOff,
  ShieldCheck,
  Store,
  Timer,
} from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { StatCard, SectionTitle, Pill } from "@/components/roles/role-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { formatINR } from "@/lib/utils/format";
import { callablePhone, stopDirectionsUrl } from "@/lib/utils/phone";
import { staticMapUrl } from "@/lib/maps/config";
import type { DriverBoardData } from "@/lib/data-access/driver-orders";
import type { DeliveryStop } from "@/lib/roles-data";
import type { TrackPoint } from "@/lib/tracking/rider-position";
import { cn } from "@/lib/utils/cn";
import { acceptDeliveryAction, advanceDeliveryAction } from "@/app/driver/actions";
import { RiderAlert } from "@/components/driver/rider-alert";
import { RouteSheet } from "@/components/driver/route-sheet";

/**
 * One position posted per this many milliseconds, however fast the device
 * produces fixes. A phone on a moving bike emits a reading roughly every second;
 * the customer's map is not more truthful for being told sixty times a minute,
 * and the rider's data plan and battery are real costs.
 */
const LOCATION_REPORT_INTERVAL_MS = 10_000;

type ReportingState =
  | "off" // nothing in flight, or the server said the delivery is over
  | "starting" // watching, no fix accepted yet
  | "reporting" // the server has our position
  | "denied" // the device refused, and will not be asked again
  | "unavailable"; // no geolocation here at all

/**
 * The device's standing answer about geolocation, before we subscribe to
 * anything. Same helper — and same caveat, that plenty of mobile browsers just
 * don't answer — as src/stores/location-store.ts.
 */
async function geolocationPermission(): Promise<PermissionState | null> {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" });
    return status?.state ?? null;
  } catch {
    return null;
  }
}

/**
 * Report this device's position for as long as a delivery is in flight.
 *
 * Not `useLocation` (src/stores/location-store.ts). That store answers a
 * different question — "which area is this person shopping from" — and answers
 * it once: best single fix, reverse-geocoded to a place name, cached in
 * localStorage, wired to an explainer sheet. A rider needs the opposite
 * lifecycle: a continuous watch, no label, no cache, and no UI in the way of
 * someone holding a bag of food. What is worth borrowing is borrowed — the
 * permission probe above, the secure-origin guard (on plain http the browser
 * reports PERMISSION_DENIED without ever prompting, which reads as a refusal
 * the user never made), and the rule that a real refusal is final and silent.
 *
 * The reported state is *derived* from the delivery it belongs to, so a new job
 * starts from "starting" without the effect having to reset anything. Every
 * write to it comes from a callback — a fetch settling, the device objecting —
 * never from the body of the effect.
 */
function useLocationReporting(activeOrderId: string | null): {
  state: ReportingState;
  /**
   * The most recent fix this watch saw, for anything on screen that needs to
   * know where the rider is — currently the route sheet's origin.
   *
   * Handed back from the watch that is already running rather than opened as a
   * second one. Two `watchPosition` subscriptions on the same screen means two
   * sets of GPS wake-ups on a phone that is already on all shift, for one
   * answer. Null until the first fix lands, and it stays at the last known
   * position afterwards — a rider entering a basement does not stop having been
   * somewhere.
   */
  position: TrackPoint | null;
} {
  const [tracked, setTracked] = useState<{
    orderId: string;
    state: ReportingState;
  } | null>(null);
  const [position, setPosition] = useState<TrackPoint | null>(null);

  const state: ReportingState = !activeOrderId
    ? "off"
    : tracked?.orderId === activeOrderId
      ? tracked.state
      : "starting";

  useEffect(() => {
    if (!activeOrderId) return;

    let watchId: number | null = null;
    let lastSentAt = 0;
    let inFlight = false;
    let cancelled = false; // the effect was torn down
    let done = false; // we have stopped watching on purpose

    const clearWatch = () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    };

    const settle = (next: ReportingState) => {
      if (!cancelled) setTracked({ orderId: activeOrderId, state: next });
    };

    /** Stop watching for good, and say why. */
    const finish = (next: ReportingState) => {
      if (done) return;
      done = true;
      clearWatch();
      settle(next);
    };

    const send = async (position: GeolocationPosition) => {
      const now = Date.now();
      // Throttled on the way out rather than by asking the device for fewer
      // fixes: a sparse watch takes longer to notice the rider has moved.
      if (
        cancelled ||
        done ||
        inFlight ||
        now - lastSentAt < LOCATION_REPORT_INTERVAL_MS
      ) {
        return;
      }
      inFlight = true;
      lastSentAt = now;

      try {
        const response = await fetch("/api/driver/location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          }),
        });
        if (cancelled || done) return;

        if (response.status === 401 || response.status === 403) {
          // The session ended, or the role changed under us. Neither is fixed by
          // trying again, so stop rather than hammer.
          finish("off");
          return;
        }

        if (response.ok) {
          const body = (await response.json().catch(() => null)) as {
            active?: boolean;
          } | null;
          if (cancelled || done) return;
          if (body?.active === false) {
            // Delivery closed somewhere else — completed on another device, or
            // reassigned by an operator. Nothing left to report.
            finish("off");
            return;
          }
          settle("reporting");
        }
        // Anything else (429, 5xx, a rejected fix) is transient from here: keep
        // the watch and let the next position try again.
      } catch {
        // Offline, or the request was dropped mid-ride. Normal on a bike.
      } finally {
        inFlight = false;
      }
    };

    const start = async () => {
      const permission = await geolocationPermission();
      if (cancelled) return;

      if (!("geolocation" in navigator) || !window.isSecureContext) {
        finish("unavailable");
        return;
      }

      if (permission === "denied") {
        // Already refused in device settings. Subscribing would produce a watch
        // that silently never fires; say so instead.
        finish("denied");
        return;
      }

      watchId = navigator.geolocation.watchPosition(
        (position) => {
          // Recorded on EVERY fix, not on every send: `send` is throttled to
          // one report per LOCATION_REPORT_INTERVAL_MS to spare the API, and
          // the map on this device should not be that stale.
          if (!cancelled) {
            setPosition({
              lat: position.coords.latitude,
              lng: position.coords.longitude,
            });
          }
          void send(position);
        },
        (error) => {
          if (error.code === error.PERMISSION_DENIED) {
            // Final, and silent. The OS will not prompt again from here, there
            // is no dialog we could raise that would change that, and a rider
            // halfway through a delivery should not be arguing with a popup. We
            // report nothing at all rather than anything invented; the
            // customer's map falls back to an interpolated position and says so.
            finish("denied");
          }
          // POSITION_UNAVAILABLE and TIMEOUT are weather, not answers — a
          // tunnel, a basement, a cold GPS chip. Keep watching.
        },
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 }
      );
    };

    void start();

    return () => {
      cancelled = true;
      clearWatch();
    };
  }, [activeOrderId]);

  return { state, position };
}

/**
 * The address of one end of a job, written out.
 *
 * Two rules, both learned from the version this replaces. Nothing here
 * `truncate`s — an address cut off at the width of a phone is not an address —
 * and the label ("Home", the shop's name) never appears *instead of* the street
 * line, only above it. The label is how the rider recognises the stop; the line
 * is how they find it.
 */
function StopLines({ stop }: { stop: DeliveryStop }) {
  return (
    <>
      {stop.address ? (
        <p className="text-sm leading-snug text-ink">{stop.address}</p>
      ) : (
        <p className="text-sm leading-snug text-muted">
          No street address recorded — call before you set off.
        </p>
      )}
      {stop.landmark ? (
        <p className="text-sm leading-snug text-muted">{stop.landmark}</p>
      ) : null}
    </>
  );
}

/** The full address block on the active delivery card. */
function ActiveStop({
  heading,
  name,
  stop,
  distanceKm,
  navigationUrl,
}: {
  heading: string;
  name: string;
  stop: DeliveryStop | null;
  distanceKm?: number;
  navigationUrl: string | null;
}) {
  if (!stop) return null;
  // Only when the stop has an exact pin — an address string geocodes
  // approximately, and a marker planted in the wrong place is worse than no
  // marker (see mapsDirectionsUrl's reasoning for the same tradeoff).
  const mapUrl = stop.point ? staticMapUrl(stop.point) : null;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface-2">
      {mapUrl ? (
        navigationUrl ? (
          <a href={navigationUrl} target="_blank" rel="noopener noreferrer">
            <img
              src={mapUrl}
              alt={`Map of ${name}`}
              width={400}
              height={160}
              className="h-32 w-full object-cover"
            />
          </a>
        ) : (
          <img
            src={mapUrl}
            alt={`Map of ${name}`}
            width={400}
            height={160}
            className="h-32 w-full object-cover"
          />
        )
      ) : null}
      <div className="flex items-start gap-3 p-3.5">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
          <MapPin className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-label">{heading}</p>
            <span className="text-data shrink-0 text-xs text-muted">
              {distanceKm !== undefined ? `${distanceKm} km` : "Distance unknown"}
            </span>
          </div>
          <p className="mt-0.5 font-bold leading-tight">{name}</p>
          {/* The saved label ("Home", "Work") only when it adds something the
              name above hasn't already said — on the pickup leg the "area" IS
              the shop's name, and printing it twice is what the old card did. */}
          {stop.area && stop.area !== name ? (
            <p className="text-xs font-semibold text-muted">{stop.area}</p>
          ) : null}
          <div className="mt-1.5 space-y-0.5">
            <StopLines stop={stop} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One line of address on a compact job card. */
function JobStop({
  icon,
  label,
  stop,
}: {
  icon: React.ReactNode;
  label: string;
  stop: DeliveryStop;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted">
          {label} · {stop.area}
        </p>
        <StopLines stop={stop} />
      </div>
    </div>
  );
}

export function DriverBoard({
  initial,
  live,
  alertSoundPreset = "chime",
  alertSoundUrl = null,
}: {
  initial: DriverBoardData;
  live: boolean;
  /** From platform_settings (0044) — same sound for every rider. */
  alertSoundPreset?: string;
  alertSoundUrl?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { available, upcoming, active, today } = initial;
  const customerTel = callablePhone(active?.customerPhone);
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  // Where this leg ends. Derived from the leg rather than carried as a separate
  // `navigateTo` pin on the active delivery, so the address printed on the card
  // and the place the Navigate button opens are the same fact and cannot drift.
  const destination = active
    ? active.leg === "TO_PICKUP"
      ? active.job.pickup
      : active.job.drop
    : null;
  const navigationUrl = destination ? stopDirectionsUrl(destination) : null;

  // Tied to the delivery: a rider carrying someone's dinner is sharing their
  // position for as long as they are carrying it. (This used to be phrased
  // against the online/offline toggle, which has since gone — see below.)
  const { state: reporting, position: riderPosition } = useLocationReporting(
    live && active ? active.job.id : null
  );

  /**
   * Which stop the route sheet is open for, or null when it is closed.
   *
   * Holds the stop itself rather than a boolean: the board has two Navigate
   * controls — the active leg's, and "Navigate to the kitchen" on an upcoming
   * pickup — and they point at different places.
   */
  const [routeTo, setRouteTo] = useState<{
    stop: DeliveryStop;
    label: string;
  } | null>(null);

  function accept(orderId: string) {
    setBusyId(orderId);
    setAcceptError(null);
    startTransition(async () => {
      try {
        const result = await acceptDeliveryAction(orderId);
        if (result && !result.ok) {
          setAcceptError(
            result.error === "already_taken"
              ? "Another rider just grabbed this order."
              : result.error === "reserved"
                ? "That one is held for another rider for a few more minutes."
                : result.error === "rate_limited"
                  ? "Too many attempts — wait a minute and try again."
                  : "Couldn't accept the order. Try again."
          );
        }
        // Refresh either way: on success the job becomes active; on a lost race
        // it leaves the available pool.
        router.refresh();
      } finally {
        setBusyId(null);
      }
    });
  }

  function advance(orderId: string, code?: string) {
    setBusyId(orderId);
    setOtpError(null);
    startTransition(async () => {
      try {
        const result = await advanceDeliveryAction(orderId, code);
        if (result && !result.ok) {
          setOtpError(
            result.error === "bad_otp"
              ? "Wrong code — ask the customer again."
              : result.error === "bad_pickup_otp"
                ? "Wrong code — ask the restaurant to read it again."
              : result.error === "rate_limited"
                ? "Too many attempts — wait a minute and try again."
                : result.error === "order_not_active"
                  ? "This order is no longer active — it may have been cancelled. Refreshing your board."
                  : "Couldn't update. Try again."
          );
          // A cancelled/reassigned order won't become active again by
          // retrying — refresh now so the stale job clears from the board
          // instead of leaving the rider stuck retapping a dead delivery.
          if (result.error === "order_not_active") router.refresh();
          return;
        }
        setOtp("");
        router.refresh();
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="space-y-6">
      {live ? <AutoRefresh interval={4000} /> : null}

      {/* This was an online/offline switch. It was `useState(true)` — never
          persisted, never sent anywhere, reset to online on every mount — and
          its only effects were hiding this page's own job list and pausing this
          page's own polling. A rider who ended a shift with it and closed the
          app was never off duty as far as the platform was concerned, and
          reopening the app put them back to "online" regardless.

          It is gone rather than wired up because there is nothing behind it to
          wire to: no driver-availability column, no dispatch, no assignment, no
          shift state. The pool is every ready order not yet claimed, shown to
          whoever opens the board. That is what this card now says, because a
          rider deciding whether to stop for lunch should know that logging off
          is not a thing this system can currently do. */}
      <div className="card flex items-center gap-3 p-4">
        <span className="grid size-11 place-items-center rounded-full bg-surface-2 text-muted">
          <Bike className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold leading-tight">
            {live ? "On the dispatch list" : "Demo data"}
          </p>
          <p className="text-xs text-muted">
            {live
              ? "Pickups are offered to whoever is free and nearest first, and open to everyone after a few minutes. There's no shift or duty status yet."
              : "Connect Supabase for live requests"}
          </p>
        </div>
      </div>

      {/* Today. This was a two-up with "Today's earnings" beside it — a money
          figure on a salaried rider's board. It is gone from the data as well as
          from here (DriverBoardData.today has no `earnings` field any more), so
          a screen cannot put it back by accident. "Online 5.5 h" and
          "Rating 4.8 ★" went earlier: constants, identical for every driver
          forever, standing in for two things we have never tracked. */}
      <RiderAlert
        incomingIds={active ? [] : available.map((j) => j.id)}
        soundPreset={alertSoundPreset}
        soundUrl={alertSoundUrl}
      />

      {/* Mounted only while open, so each opening starts a fresh Directions
          request for the stop actually being routed to rather than reviving the
          last one. It covers the phone frame (`absolute inset-0` against
          `.app-shell`), which is what keeps the OTP and the handover button one
          tap behind it instead of a page away. */}
      {routeTo ? (
        <RouteSheet
          destination={routeTo.stop.point ?? null}
          destinationLabel={routeTo.label}
          origin={riderPosition}
          mapsUrl={stopDirectionsUrl(routeTo.stop)}
          onClose={() => setRouteTo(null)}
        />
      ) : null}

      <StatCard label="Trips today" value={String(today.trips)} tone="accent" />

      {/* Active delivery */}
      {active ? (
        <section>
          <SectionTitle right={<Pill tone="accent">In progress</Pill>}>
            Active delivery
          </SectionTitle>
          <div className="card overflow-hidden">
            {/* This strip used to be a 128px gradient captioned "Live map". There
                was no map, and there was nothing live about it. It now carries the
                one piece of live information the rider needs from this app about
                the customer's view: whether the customer can actually see them. */}
            <div className="flex items-center justify-center gap-2 border-b border-line bg-surface-2 px-4 py-3 text-center">
              {reporting === "reporting" ? (
                <>
                  <LocateFixed className="size-4 shrink-0 text-green" />
                  <span className="text-sm font-semibold text-green">
                    Sharing your location with the customer
                  </span>
                </>
              ) : reporting === "starting" ? (
                <>
                  <LocateFixed className="size-4 shrink-0 text-muted" />
                  <span className="text-sm text-muted">Finding your position…</span>
                </>
              ) : (
                <>
                  <LocateOff className="size-4 shrink-0 text-muted" />
                  <span className="text-sm text-muted">
                    {reporting === "denied"
                      ? "Location off — the customer sees an estimate, not you"
                      : reporting === "unavailable"
                        ? "This device can't share its location"
                        : "Not sharing your location"}
                  </span>
                </>
              )}
            </div>

            <div className="space-y-4 p-4">
              {/* Money first, and unmissably. A rider glances at this card once,
                  at the door, with a bag in one hand. */}
              {active.payment.instruction === "collect" ? (
                <div className="rounded-xl border-2 border-deal bg-deal-soft px-4 py-3 text-center">
                  <p className="flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-wider text-deal">
                    <Banknote className="size-4" /> Collect cash
                  </p>
                  <p className="text-data mt-1 text-3xl font-extrabold text-deal">
                    {formatINR(active.payment.collectAmount)}
                  </p>
                  <p className="mt-1 text-xs font-medium text-deal">
                    Take the full amount before handing the order over.
                  </p>
                </div>
              ) : active.payment.instruction === "prepaid" ? (
                <div className="flex items-center gap-2.5 rounded-xl border border-green bg-green-soft px-4 py-3">
                  <ShieldCheck className="size-5 shrink-0 text-green" />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-green">
                      Prepaid — collect nothing
                    </p>
                    <p className="text-xs text-muted">
                      Already paid online. Do not ask for money.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2.5 rounded-xl border border-accent bg-accent-soft px-4 py-3">
                  <AlertTriangle className="size-5 shrink-0 text-accent" />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-accent">
                      Payment not confirmed
                    </p>
                    <p className="text-xs text-muted">
                      Placed as an online payment that hasn&apos;t settled. Don&apos;t
                      collect cash — check with support before handing over.
                    </p>
                  </div>
                </div>
              )}

              {/* The address, in full and not truncated.

                  This block used to be three lines that between them never said
                  where to go: a heading, the shop or customer's NAME, and then
                  `pickupArea`/`dropArea` — which were the shop's name again and
                  the customer's saved LABEL. A rider on the delivery leg was
                  shown "Deliver to / Priya S. / Home", all of it `truncate`d to
                  one line, and expected to find it. The street line the customer
                  typed at checkout — flat number, entry code, floor, landmark,
                  courier note, all of it — was sitting in the same row we were
                  reading and was being thrown away.

                  It now wraps rather than truncating. An address that doesn't
                  fit on one line is not an address you can cut in half. */}
              <ActiveStop
                heading={active.leg === "TO_PICKUP" ? "Pick up from" : "Deliver to"}
                name={
                  active.leg === "TO_PICKUP"
                    ? active.job.restaurant
                    : active.job.customer
                }
                stop={destination}
                distanceKm={active.job.distanceKm}
                navigationUrl={navigationUrl}
              />

              {/* Both of these were full-width outline buttons with no onClick,
                  no href and no disabled state — so they looked and pressed
                  like working controls and did nothing, to a courier standing
                  at an address they don't know. They now open the phone's maps
                  app and dialler.

                  Navigate is primary, and it is the one control on this screen
                  that has to be unmissable: it is what a rider presses while
                  holding a bag. It falls back to the written address when the
                  end has no pin (a vendor who skipped the map step in the
                  onboarding wizard used to leave the rider with a greyed-out
                  button), and only greys out when there is neither.

                  Stacked rather than side-by-side with Call customer, and a
                  size up from it — this comment already said Navigate should
                  be unmissable, but a 50/50 split with a same-size button next
                  to it was the opposite of that. */}
              <div className="space-y-2">
                {destination ? (
                  <Button
                    size="lg"
                    className="w-full"
                    onClick={() =>
                      setRouteTo({
                        stop: destination,
                        label:
                          active.leg === "TO_PICKUP"
                            ? active.job.pickup.area
                            : active.job.drop.area,
                      })
                    }
                  >
                    <Navigation className="size-4" /> Navigate
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    className="w-full"
                    disabled
                    title={
                      active.leg === "TO_PICKUP"
                        ? "This shop has no map pin and no address on file"
                        : "This address has no map pin and no street line"
                    }
                  >
                    <Navigation className="size-4" /> No address
                  </Button>
                )}

                {customerTel ? (
                  <a
                    href={`tel:${customerTel}`}
                    className={buttonClasses({
                      variant: "outline",
                      size: "md",
                      className: "w-full",
                    })}
                  >
                    <Phone className="size-4" /> Call customer
                  </a>
                ) : (
                  <Button
                    variant="outline"
                    size="md"
                    className="w-full"
                    disabled
                    title="No phone number recorded for this customer"
                  >
                    <Phone className="size-4" /> No number
                  </Button>
                )}
              </div>

              {active.leg === "TO_CUSTOMER" ? (
                <div className="space-y-2">
                  <label className="text-label block">Ask the customer for their delivery code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                    className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-center text-2xl tracking-[0.4em] outline-none focus:border-accent"
                    placeholder="••••"
                  />
                  {otpError ? <p className="text-sm text-accent">{otpError}</p> : null}
                  <Button
                    className="w-full"
                    size="lg"
                    disabled={pending || otp.length !== 4}
                    onClick={() => advance(active.job.id, otp)}
                  >
                    {pending && busyId === active.job.id ? (
                      <><Loader2 className="size-5 animate-spin" /> Verifying…</>
                    ) : (
                      <><CheckCircle2 className="size-5" /> Confirm delivery</>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* The other half of the handover, and it now works the same
                      way round as the delivery leg: the counter holds the code
                      and the rider enters it. The rider used to be SHOWN this
                      code to read out, while the server wrote `picked_up`
                      without checking anything — so a pickup could be marked
                      from anywhere. Typing what the kitchen tells you is what
                      makes the code evidence of having been there. */}
                  {active.pickupCodeRequired ? (
                    <div className="space-y-2">
                      <label className="text-label flex items-center gap-1.5">
                        <KeyRound className="size-3.5" />
                        Ask the restaurant for the pickup code
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={4}
                        value={otp}
                        onChange={(e) =>
                          setOtp(e.target.value.replace(/\D/g, ""))
                        }
                        className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-center text-2xl tracking-[0.4em] outline-none focus:border-accent"
                        placeholder="••••"
                      />
                    </div>
                  ) : null}
                  {otpError ? <p className="text-sm text-accent">{otpError}</p> : null}
                  <Button
                    className="w-full"
                    size="lg"
                    disabled={
                      pending || (active.pickupCodeRequired && otp.length !== 4)
                    }
                    onClick={() =>
                      advance(
                        active.job.id,
                        active.pickupCodeRequired ? otp : undefined
                      )
                    }
                  >
                    {pending && busyId === active.job.id ? (
                      <><Loader2 className="size-5 animate-spin" /> Updating…</>
                    ) : (
                      <><Package className="size-5" /> Picked up — start delivery</>
                    )}
                  </Button>
                </div>
              )}
              <p className="text-center text-xs text-muted">
                Order {active.job.code}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* Coming up — the kitchen has accepted, dispatch picked this rider, and
          the food is still being cooked.

          This section could not exist before dispatch did. Orders only ever
          surfaced to riders at `ready`, which is the moment the bag is already
          sitting on the pass going cold, so every road leg started from a
          standing start wherever the rider happened to be when they noticed.
          Told at acceptance instead, with the kitchen's own prep estimate, a
          rider can already be at the counter. Nothing here is accept-able yet —
          it is a heads-up and it says so; the order moves down to the pool
          below, held for them, the moment the vendor marks it packed. */}
      {upcoming.length > 0 ? (
        <section>
          <SectionTitle right={<Pill tone="accent">Held for you</Pill>}>
            Coming up
          </SectionTitle>
          <p className="mb-3 text-xs text-muted">
            {active
              ? "Queued for after your current drop — the kitchen is still cooking it."
              : "Still cooking. Head over now and it'll be waiting for you; it moves into Available orders the moment the kitchen packs it."}
          </p>
          <div className="space-y-3">
            {upcoming.map(({ job, readyInMinutes }) => {
              // The sheet needs a pin; the Google Maps hand-off inside it can
              // still work from a written address, which is why both are
              // computed rather than one derived from the other.
              const pickupPinned = Boolean(job.pickup.point);
              return (
                <div key={job.id} className="card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                        <ChefHat className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="font-bold leading-tight">{job.restaurant}</p>
                        <p className="text-xs text-muted">
                          Order {job.code} · {job.items} items
                        </p>
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-bold text-ink">
                      <Timer className="size-3.5" />
                      {readyInMinutes === null
                        ? "Cooking"
                        : readyInMinutes === 0
                          ? "Any moment"
                          : `~${readyInMinutes} min`}
                    </span>
                  </div>

                  <div className="mt-3 space-y-2.5">
                    <JobStop
                      icon={<Store className="size-3.5" />}
                      label="Pick up"
                      stop={job.pickup}
                    />
                    <JobStop
                      icon={<MapPin className="size-3.5" />}
                      label="Drop"
                      stop={job.drop}
                    />
                  </div>

                  {pickupPinned ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 w-full"
                      onClick={() =>
                        setRouteTo({ stop: job.pickup, label: job.restaurant })
                      }
                    >
                      <Navigation className="size-4" /> Navigate to the kitchen
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Available orders */}
      <section>
        <SectionTitle
          right={<span className="text-xs text-muted">{available.length} nearby</span>}
        >
          Available orders
        </SectionTitle>

        {active ? (
          <p className="card p-4 text-sm text-muted">
            Finish your active delivery to see new requests.
          </p>
        ) : available.length === 0 ? (
          <EmptyState
            icon={<Package className="size-7" />}
            title="No requests right now"
            description="Hang tight — orders marked ready by kitchens appear here."
          />
        ) : (
          <>
            {acceptError ? (
              <p className="mb-3 rounded-xl bg-deal-soft px-3 py-2 text-sm font-medium text-deal">
                {acceptError}
              </p>
            ) : null}
            <div className="space-y-3">
            {available.map((job) => (
              <div
                key={job.id}
                className={cn(
                  "card p-4",
                  job.reservedForYou && "border-accent ring-1 ring-accent"
                )}
              >
                <p className="font-semibold">{job.restaurant}</p>
                {job.reservedForYou ? (
                  <p className="mt-1 text-xs font-bold text-accent">
                    Held for you for a few minutes — then it opens to everyone.
                  </p>
                ) : null}
                {/* Was two truncated lines that said the shop's name and the
                    word "Home". A rider deciding whether to take a job needs to
                    know where the job GOES. */}
                <div className="mt-3 space-y-2.5">
                  <JobStop
                    icon={<Store className="size-3.5" />}
                    label="Pick up"
                    stop={job.pickup}
                  />
                  <JobStop
                    icon={<MapPin className="size-3.5" />}
                    label="Drop"
                    stop={job.drop}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {job.distanceKm !== undefined ? (
                      <Pill tone="muted">{job.distanceKm} km</Pill>
                    ) : null}
                    <Pill tone="muted">{job.items} items</Pill>
                  </div>
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => accept(job.id)}
                  >
                    {pending && busyId === job.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      "Accept"
                    )}
                  </Button>
                </div>
              </div>
            ))}
            </div>
          </>
        )}
      </section>

      <p className="px-1 text-center text-xs text-muted">
        Details are shared only for orders assigned to you, and redacted once
        delivered — enforced server-side in production.
      </p>
    </div>
  );
}
