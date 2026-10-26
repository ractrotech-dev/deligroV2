"use client";

import { useEffect, useState, useTransition } from "react";
import { useFeatures } from "@/components/features/features-provider";
import { useRouter } from "next/navigation";
import {
  ChefHat,
  MapPin,
  Package,
  Navigation,
  Phone,
  CheckCircle2,
  Loader2,
  LocateFixed,
  LocateOff,
  Store,
  Timer,
} from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { SectionTitle, Pill } from "@/components/roles/role-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { formatINR } from "@/lib/utils/format";
import { callablePhone, stopDirectionsUrl } from "@/lib/utils/phone";
import type {
  DriverBoardData,
  DriverPayment,
} from "@/lib/data-access/driver-orders";
import type { DeliveryStop } from "@/lib/roles-data";
import type { TrackPoint } from "@/lib/tracking/rider-position";
import { cn } from "@/lib/utils/cn";
import { acceptDeliveryAction, advanceDeliveryAction } from "@/app/driver/actions";
import { AvailabilitySwitch } from "@/components/driver/availability-switch";
import { RiderAlert } from "@/components/driver/rider-alert";
import {
  CashNotice,
  RoutePanel,
  SharingChip,
  StepTrack,
} from "@/components/driver/driver-job-ui";
import { RingSetup } from "@/components/notifications/ring-setup";
import { Modal } from "@/components/ui/confirm-dialog";

/**
 * One position posted per this many milliseconds, however fast the device
 * produces fixes. A phone on a moving bike emits a reading roughly every second;
 * the customer's map is not more truthful for being told sixty times a minute,
 * and the rider's data plan and battery are real costs.
 */
const LOCATION_REPORT_INTERVAL_MS = 10_000;

/**
 * The same, for an online rider with no delivery in flight. Nobody is watching a
 * map; the report only keeps the rider "present" for dispatch, which treats a
 * fix older than five minutes (RIDER_PRESENCE_MS) as a dead phone. Thirty
 * seconds leaves nine missed reports of slack for a tunnel or a lost signal.
 */
const LOCATION_IDLE_INTERVAL_MS = 30_000;

/**
 * The longest a rider on an active delivery goes without a report while
 * standing still — well inside the 45 s window after which the customer's map
 * treats a fix as stale (GPS_FIX_MAX_AGE_MS in order-tracking.ts).
 */
const LOCATION_HEARTBEAT_MS = 20_000;

/** How often the heartbeat checks whether a still rider is due a report. */
const LOCATION_HEARTBEAT_TICK_MS = 10_000;

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
 * Report this device's position while the rider is online or a delivery is in
 * flight.
 *
 * Online: POST /api/rider/location, every 30 s while idle and every 10 s once a
 * delivery is in flight. That one endpoint keeps the rider "present" for
 * dispatch and moves the customer's map. Offline with no delivery: nothing is
 * watched, nothing is sent.
 *
 * Not online but carrying a delivery (a database without migration 0081, where
 * nobody can go online): the original behaviour, POST /api/driver/location every
 * 10 s. And if /api/rider/location answers 503 `migration_pending` without
 * having written the delivery position, the same fallback keeps the customer's
 * live tracking going — it must never depend on 0081.
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
function useLocationReporting(
  online: boolean,
  activeOrderId: string | null
): {
  state: ReportingState;
  /**
   * The most recent fix this watch saw, for anything on screen that needs to
   * know where the rider is. Nothing on the board reads it today (the in-app
   * route sheet that did was removed — Navigate hands off to Google Maps,
   * which finds the rider itself); it is kept because it costs nothing on top
   * of the watch that reporting already needs.
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
  // What the current watch is for. Changing it (going online, taking a job,
  // finishing one) restarts the watch, which also sends a fix at once.
  const watchKey = activeOrderId ?? (online ? "online" : null);

  const [tracked, setTracked] = useState<{
    key: string;
    state: ReportingState;
  } | null>(null);
  const [position, setPosition] = useState<TrackPoint | null>(null);

  let state: ReportingState = "off";
  if (watchKey) {
    state = tracked?.key === watchKey ? tracked.state : "starting";
  }

  useEffect(() => {
    if (!watchKey) return;

    // Presence endpoint whenever online; the delivery-only one otherwise.
    const endpoint = online ? "/api/rider/location" : "/api/driver/location";
    // Delivery in flight: the customer is watching. Idle: only dispatch is.
    const reportEveryMs = activeOrderId
      ? LOCATION_REPORT_INTERVAL_MS
      : LOCATION_IDLE_INTERVAL_MS;
    const heartbeatEveryMs = activeOrderId
      ? LOCATION_HEARTBEAT_MS
      : LOCATION_IDLE_INTERVAL_MS;

    let watchId: number | null = null;
    let lastSentAt = 0;
    let inFlight = false;
    let heartbeat: number | null = null;
    let cancelled = false; // the effect was torn down
    let done = false; // we have stopped watching on purpose

    const clearWatch = () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    };

    const settle = (next: ReportingState) => {
      if (!cancelled) setTracked({ key: watchKey, state: next });
    };

    /** Stop watching for good, and say why. */
    const finish = (next: ReportingState) => {
      if (done) return;
      done = true;
      clearWatch();
      if (heartbeat !== null) {
        window.clearInterval(heartbeat);
        heartbeat = null;
      }
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
        now - lastSentAt < reportEveryMs
      ) {
        return;
      }
      inFlight = true;
      lastSentAt = now;

      try {
        const post = (url: string) =>
          fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              lat: position.coords.latitude,
              lng: position.coords.longitude,
            }),
          });
        let response = await post(endpoint);
        if (cancelled || done) return;

        type Answer = { active?: boolean } | null;
        let body = null as Answer;
        if (response.status === 503 && online && activeOrderId) {
          // No rider_status table (0081 not applied). The server writes the
          // delivery position before it looks at presence and says so in `active`;
          // when it did not (an older server, a proxy in between), post to the
          // delivery-only endpoint so the customer's map keeps moving.
          body = (await response.json().catch(() => null)) as Answer;
          if (cancelled || done) return;
          if (body?.active !== true) {
            response = await post("/api/driver/location");
            if (cancelled || done) return;
            body = null;
          }
        }

        if (response.status === 401 || response.status === 403) {
          // The session ended, or the role changed under us. Neither is fixed by
          // trying again, so stop rather than hammer.
          finish("off");
          return;
        }

        if (response.ok || body) {
          body ??= (await response.json().catch(() => null)) as Answer;
          if (cancelled || done) return;
          if (body?.active === false && !online) {
            // Delivery closed somewhere else — completed on another device, or
            // reassigned by an operator. Nothing left to report. (An online
            // rider's watch is not tied to the delivery: "no delivery in
            // flight" is just the idle state, and the board's refresh will move
            // the watch over to the idle cadence.)
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

      // Heartbeat. `watchPosition` only fires when the device thinks it has
      // moved, so a rider standing at the counter or at a gate reports nothing
      // at all — one position in ~30 s in the 28 Sept live test — and after
      // 45 s the customer's map stops trusting the fix and shows "estimated".
      // Asking for a position on a timer keeps a stationary rider live. The
      // cached-fix allowance is bounded, so this never re-sends a position the
      // device itself no longer stands behind.
      heartbeat = window.setInterval(() => {
        if (cancelled || done) return;
        if (Date.now() - lastSentAt < heartbeatEveryMs) return;
        navigator.geolocation.getCurrentPosition(
          (position) => void send(position),
          () => {
            // Same weather as the watch's error path; try again next beat.
          },
          { enableHighAccuracy: true, maximumAge: 15_000, timeout: 15_000 }
        );
      }, LOCATION_HEARTBEAT_TICK_MS);
    };

    void start();

    return () => {
      cancelled = true;
      clearWatch();
      if (heartbeat !== null) window.clearInterval(heartbeat);
    };
  }, [watchKey, online, activeOrderId]);

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
function StopLines({ stop }: Readonly<{ stop: DeliveryStop }>) {
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
      {stop.opsNote ? (
        <p className="mt-1 rounded-lg bg-pop/15 px-2 py-1 text-sm font-medium leading-snug text-ink">
          Note from Deligro: {stop.opsNote}
        </p>
      ) : null}
    </>
  );
}

/** One line of address on a compact job card. */
function JobStop({
  icon,
  label,
  stop,
}: Readonly<{
  icon: React.ReactNode;
  label: string;
  stop: DeliveryStop;
}>) {
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

function acceptErrorMessage(code: string | undefined): string {
  if (code === "already_taken") return "Another rider just grabbed this order.";
  if (code === "reserved") {
    return "That one is held for another rider for a few more minutes.";
  }
  if (code === "offer_expired") {
    return "Your time to accept that one ran out, and it has gone to another rider.";
  }
  if (code === "rejected") {
    return "You declined that order.";
  }
  if (code === "not_online") {
    return "Go online to accept orders.";
  }
  if (code === "rate_limited") {
    return "Too many attempts — wait a minute and try again.";
  }
  if (code === "documents_expired") {
    return "One of your documents has expired. Upload the new one — you can take orders again once Deligro has checked it.";
  }
  return "Couldn't accept the order. Try again.";
}

function advanceErrorMessage(code: string | undefined): string {
  if (code === "rate_limited") {
    return "Too many attempts — wait a minute and try again.";
  }
  if (code === "order_not_active") {
    return "This order is no longer active — it may have been cancelled. Refreshing your board.";
  }
  if (code === "photo_required") {
    // The platform's proof-photo rule asks for one, and this portal has no
    // camera step: the Deligro Rider app does.
    return "This delivery needs a photo at the door — complete it in the Deligro Rider app.";
  }
  return "Couldn't update. Try again.";
}

/** The money line on an offer: what to take at the door, if anything. */
function paymentNote(payment: DriverPayment): string {
  if (payment.instruction === "collect") {
    return ` · Collect ${formatINR(payment.collectAmount)}`;
  }
  if (payment.instruction === "prepaid") return " · Prepaid";
  return "";
}

function readyLabel(readyInMinutes: number | null): string {
  if (readyInMinutes === null) return "Cooking";
  if (readyInMinutes === 0) return "Any moment";
  return `~${readyInMinutes} min`;
}

/** The advance button's face: a spinner while it works, else the leg's verb. */
function AdvanceLabel({
  busy,
  pickup,
}: Readonly<{ busy: boolean; pickup: boolean }>) {
  if (busy) {
    return (
      <>
        <Loader2 className="size-5 animate-spin" />{" "}
        {pickup ? "Updating…" : "Verifying…"}
      </>
    );
  }
  if (pickup) {
    return (
      <>
        <Package className="size-5" /> Picked up, start delivery
      </>
    );
  }
  return (
    <>
      <CheckCircle2 className="size-5" /> Confirm delivery
    </>
  );
}

type ActiveJob = NonNullable<DriverBoardData["active"]>;
type OfferJob = DriverBoardData["available"][number];

/** The delivery just completed, for the "Delivery complete" popup. */
interface DeliveredJob {
  code: string;
  customer: string;
  /** Cash the rider should now be holding; null for a prepaid order. */
  cashCollected: number | null;
  distanceKm: number | undefined;
}

export function DriverBoard({
  initial,
  live,
  alertSoundPreset = "chime",
  alertSoundUrl = null,
}: Readonly<{
  initial: DriverBoardData;
  live: boolean;
  /** From platform_settings (0044) — same sound for every rider. */
  alertSoundPreset?: string;
  alertSoundUrl?: string | null;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { available, upcoming, active, today, availability } = initial;
  // Admin → Feature access. Calling also can't happen with it off: the page
  // doesn't send the customer's number (driver/page.tsx).
  const features = useFeatures();
  const canNavigate = features["driver.navigation"];
  const canCall = features["driver.call_customer"];
  const customerTel = callablePhone(active?.customerPhone);
  const [stepError, setStepError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  // Where this leg ends. Derived from the leg rather than carried as a separate
  // `navigateTo` pin on the active delivery, so the address printed on the card
  // and the place the Navigate button opens are the same fact and cannot drift.
  let destination: DeliveryStop | null = null;
  if (active) {
    destination = active.leg === "TO_PICKUP" ? active.job.pickup : active.job.drop;
  }
  const navigationUrl =
    canNavigate && destination ? stopDirectionsUrl(destination) : null;

  // Shared while the rider is online (so dispatch knows they are there) and for
  // as long as they are carrying someone's dinner (so the customer can see it).
  // Offline with nothing in flight: nothing is shared at all.
  const { state: reporting, position } = useLocationReporting(
    live && availability.isOnline,
    live && active ? active.job.id : null
  );

  /**
   * The delivery that was just completed, for the "Order delivered" popup.
   *
   * Captured from `active` BEFORE the refresh, because the refresh is what
   * takes the job off the board — by the time the new props land there is no
   * active delivery left to read the order code or the cash amount from. The
   * old success path was only that refresh: the card simply vanished, and a
   * rider who had just typed a code at a door could not tell "delivered" from
   * "the app lost my job".
   */
  const [delivered, setDelivered] = useState<DeliveredJob | null>(null);

  function accept(orderId: string) {
    setBusyId(orderId);
    setAcceptError(null);
    startTransition(async () => {
      try {
        const result = await acceptDeliveryAction(orderId);
        if (result && !result.ok) {
          setAcceptError(acceptErrorMessage(result.error));
        }
        // Refresh either way: on success the job becomes active; on a lost race
        // it leaves the available pool.
        router.refresh();
      } finally {
        setBusyId(null);
      }
    });
  }

  function advance(orderId: string) {
    setBusyId(orderId);
    setStepError(null);
    // Snapshot what the success popup needs while the job is still on screen.
    const completing =
      active?.job.id === orderId && active.leg === "TO_CUSTOMER"
        ? {
            code: active.job.code,
            customer: active.job.customer,
            distanceKm: active.job.distanceKm,
            cashCollected:
              active.payment.instruction === "collect"
                ? active.payment.collectAmount
                : null,
          }
        : null;
    startTransition(async () => {
      try {
        let result: Awaited<ReturnType<typeof advanceDeliveryAction>>;
        try {
          result = await advanceDeliveryAction(orderId);
        } catch {
          // No signal at the door, or the server threw. Uncaught, this escaped
          // the transition to the route's error boundary and replaced the
          // whole board — cash amount and all — with an error page.
          setStepError(
            "Couldn't reach Deligro — check your internet and try again."
          );
          return;
        }
        if (result && !result.ok) {
          setStepError(advanceErrorMessage(result.error));
          // A cancelled/reassigned order won't become active again by
          // retrying — refresh now so the stale job clears from the board
          // instead of leaving the rider stuck retapping a dead delivery.
          if (result.error === "order_not_active") router.refresh();
          return;
        }
        if (completing) setDelivered(completing);
        router.refresh();
      } finally {
        setBusyId(null);
      }
    });
  }

  // The first offer gets the full treatment; the rest are compact rows. A rider
  // deciding whether to take a job needs to see one clearly, not five equally.
  const [featured, ...others] = available;

  return (
    <div className="space-y-5">
      {/* `whenHidden`, as on the kitchen board: RiderAlert can only raise a
          system notification when a poll brings a new job in, so pausing here
          silenced the alert in exactly the case it exists for — the phone in a
          pocket. Server push (onesignal-init) covers a fully closed app. */}
      {live ? <AutoRefresh interval={4000} whenHidden /> : null}

      {/* The switch is the first thing on the board: whether anything below it
          will ever ring depends on it. Not on the demo board, which has no
          server to ask. */}
      {live ? (
        <AvailabilitySwitch
          availability={availability}
          location={reporting}
          delivering={active !== null}
        />
      ) : null}

      <RiderAlert
        incomingIds={active ? [] : available.map((j) => j.id)}
        soundPreset={alertSoundPreset}
        soundUrl={alertSoundUrl}
      />

      {/* Delivered. A real confirmation rather than the card silently
          disappearing on refresh — and, on a cash order, the amount the rider
          should now be holding, said once more while the customer is still at
          the door. Modal portals into `.app-shell` as `fixed`, so it covers
          the whole phone frame, tab bar included. */}
      <Modal
        open={delivered !== null}
        onClose={() => setDelivered(null)}
        title="Delivery complete"
      >
        {delivered ? (
          <DeliveredSummary
            delivered={delivered}
            features={features}
            today={today}
            setDelivered={setDelivered}
          />
        ) : null}
      </Modal>

      {active ? (
        /* ---------------------------------------------------------------
           An active delivery owns the screen: nothing else competes with it.
           A route panel on top, one sheet below, one main button. */
        <ActiveDelivery
          active={active}
          reporting={reporting}
          position={position}
          destination={destination}
          canNavigate={canNavigate}
          navigationUrl={navigationUrl}
          canCall={canCall}
          customerTel={customerTel}
          stepError={stepError}
          pending={pending}
          busyId={busyId}
          advance={advance}
        />
      ) : (
        <JobOffers
          live={live}
          available={available}
          acceptError={acceptError}
          featured={featured}
          others={others}
          upcoming={upcoming}
          canNavigate={canNavigate}
          pending={pending}
          busyId={busyId}
          accept={accept}
        />
      )}

      <p className="px-1 text-center text-xs text-muted">
        Details are shared only for orders assigned to you, and redacted once
        delivered — enforced server-side in production.
      </p>
    </div>
  );
}

const REPORTING_LABEL: Record<ReportingState, string> = {
  reporting: "Sharing your location",
  starting: "Finding your position…",
  denied: "Location off, customer sees an estimate",
  unavailable: "Can't share location",
  off: "Not sharing location",
};

/** The sharing state as plain text, for when there is no route panel to carry it. */
function ReportingNote({ state }: Readonly<{ state: ReportingState }>) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs font-semibold",
        state === "reporting" ? "text-green" : "text-muted"
      )}
    >
      {state === "reporting" ? (
        <LocateFixed className="size-3.5" />
      ) : (
        <LocateOff className="size-3.5" />
      )}
      {REPORTING_LABEL[state]}
    </span>
  );
}

/** "Delivery complete", with the cash the rider should now be holding. */
function DeliveredSummary({
  delivered,
  features,
  today,
  setDelivered,
}: Readonly<{
  delivered: DeliveredJob;
  features: ReturnType<typeof useFeatures>;
  today: DriverBoardData["today"];
  setDelivered: (value: null) => void;
}>) {
  return (
    <div className="space-y-4" role="status">
      <span className="mx-auto grid size-16 place-items-center rounded-full bg-green text-white">
        <CheckCircle2 className="size-9" />
      </span>
      <div className="text-center">
        <p className="text-xl font-extrabold leading-tight">
          Delivery complete
        </p>
        <p className="mt-1 text-sm text-muted">
          Order {delivered.code} · {delivered.customer}
        </p>
      </div>
      {delivered.cashCollected !== null ? (
        <div className="rounded-2xl border-2 border-deal bg-deal-soft px-4 py-3.5 text-center">
          <p className="text-xs font-bold text-deal">
            Cash collected
          </p>
          <p className="text-data mt-1.5 text-[32px] font-extrabold leading-none text-deal">
            {formatINR(delivered.cashCollected)}
          </p>
        </div>
      ) : (
        <p className="rounded-2xl bg-green-soft px-4 py-3 text-center text-sm font-bold text-green">
          Prepaid, no cash to collect
        </p>
      )}
      <dl className="divide-y divide-line text-sm">
        {delivered.distanceKm !== undefined ? (
          <div className="flex justify-between py-2.5">
            <dt className="text-muted">Trip distance</dt>
            <dd className="font-bold">{delivered.distanceKm} km</dd>
          </div>
        ) : null}
        {features["driver.earnings"] ? (
          <div className="flex justify-between py-2.5">
            <dt className="text-muted">Trips today</dt>
            <dd className="text-data font-bold">{today.trips}</dd>
          </div>
        ) : null}
      </dl>
      <Button
        size="lg"
        className="w-full"
        onClick={() => setDelivered(null)}
      >
        Back to jobs
      </Button>
    </div>
  );
}

/** The top of the job: a route panel when both ends are known, else a chip. */
function ActiveHeader({
  active,
  reporting,
  hasPanel,
  panelFrom,
  panelTo,
  panelFromKind,
  legIsPickup,
}: Readonly<{
  active: ActiveJob;
  reporting: ReportingState;
  hasPanel: boolean;
  panelFrom: TrackPoint | null | undefined;
  panelTo: TrackPoint | null | undefined;
  panelFromKind: "rider" | "shop";
  legIsPickup: boolean;
}>) {
  return hasPanel ? (
    <RoutePanel
      from={panelFrom}
      to={panelTo}
      fromKind={panelFromKind}
      toKind={legIsPickup ? "shop" : "home"}
      height={176}
    >
      <SharingChip state={reporting} />
      <span className="ml-auto rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-xs font-bold text-white/80">
        {active.job.code}
      </span>
    </RoutePanel>
  ) : (
    <div className="mb-3 flex items-center gap-2">
      <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-bold text-muted">
        Order {active.job.code}
      </span>
      <span className="ml-auto">
        <ReportingNote state={reporting} />
      </span>
    </div>
  );
}

/** Where this leg ends, written out in full. */
function LegStop({
  active,
  legIsPickup,
  stopName,
  destination,
}: Readonly<{
  active: ActiveJob;
  legIsPickup: boolean;
  stopName: string | undefined;
  destination: DeliveryStop | null;
}>) {
  return (
    <div>
      <p className="text-label">
        {legIsPickup ? "Go to the shop" : "Deliver to"}
        {!legIsPickup && active.job.distanceKm !== undefined
          ? ` · ${active.job.distanceKm} km`
          : ""}
      </p>
      <p className="mt-1 text-[22px] font-extrabold leading-tight tracking-tight">
        {stopName}
      </p>
      {destination?.area && destination.area !== stopName ? (
        <p className="mt-0.5 text-xs font-semibold text-muted">
          {destination.area}
        </p>
      ) : null}
      <div className="mt-1.5 space-y-0.5">
        {destination ? <StopLines stop={destination} /> : null}
      </div>
    </div>
  );
}

/** Navigate and Call. Switched on but with nothing to open, each greys out rather than hides. */
function LegActions({
  canNavigate,
  navigationUrl,
  legIsPickup,
  canCall,
  customerTel,
}: Readonly<{
  canNavigate: boolean;
  navigationUrl: string | null;
  legIsPickup: boolean;
  canCall: boolean;
  customerTel: string | null;
}>) {
  return (
    <div className="flex gap-2">
      {canNavigate && (navigationUrl ? (
        <a
          href={navigationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClasses({
            size: "lg",
            className: "min-w-0 flex-1",
          })}
        >
          <Navigation className="size-5" /> Navigate
        </a>
      ) : (
        <Button
          size="lg"
          className="min-w-0 flex-1"
          disabled
          title={
            legIsPickup
              ? "This shop has no map pin and no address on file"
              : "This address has no map pin and no street line"
          }
        >
          <Navigation className="size-5" /> No address
        </Button>
      ))}
      {canCall && (customerTel ? (
        <a
          href={`tel:${customerTel}`}
          aria-label="Call customer"
          className={buttonClasses({
            variant: "outline",
            size: "lg",
            className: "w-16 shrink-0 px-0",
          })}
        >
          <Phone className="size-5" />
        </a>
      ) : (
        <Button
          variant="outline"
          size="lg"
          className="w-16 shrink-0 px-0"
          disabled
          aria-label="No phone number recorded for this customer"
          title="No phone number recorded for this customer"
        >
          <Phone className="size-5" />
        </Button>
      ))}
    </div>
  );
}

/** An active delivery: one route, one sheet, one main button. */
function ActiveDelivery({
  active,
  reporting,
  position,
  destination,
  canNavigate,
  navigationUrl,
  canCall,
  customerTel,
  stepError,
  pending,
  busyId,
  advance,
}: Readonly<{
  active: ActiveJob;
  reporting: ReportingState;
  position: TrackPoint | null;
  destination: DeliveryStop | null;
  canNavigate: boolean;
  navigationUrl: string | null;
  canCall: boolean;
  customerTel: string | null;
  stepError: string | null;
  pending: boolean;
  busyId: string | null;
  advance: (orderId: string, code?: string) => void;
}>) {
  // The route panel's two ends. Rider to stop when we know where the rider is;
  // otherwise shop to customer on the second leg, and nothing on the first (a
  // panel with no start would only be a pin on a grid).
  const legIsPickup = active?.leg === "TO_PICKUP";
  const stopName = legIsPickup ? active?.job.restaurant : active?.job.customer;
  const panelFrom = position ?? (active && !legIsPickup ? active.job.pickup.point : null);
  const panelFromKind = position ? "rider" : "shop";
  const panelTo = destination?.point ?? null;
  const hasPanel = Boolean(active && panelFrom && panelTo);

  return (
    <section aria-label="Active delivery">
      <ActiveHeader
        active={active}
        reporting={reporting}
        hasPanel={hasPanel}
        panelFrom={panelFrom}
        panelTo={panelTo}
        panelFromKind={panelFromKind}
        legIsPickup={legIsPickup}
      />

      <div
        className={cn(
          "relative space-y-4 rounded-3xl border border-line bg-surface p-4 shadow-[var(--shadow-md)]",
          hasPanel && "-mt-6"
        )}
      >
        <StepTrack leg={active.leg} />

        {/* Money first on the way to the customer — a rider glances at this
            once, at the door, with a bag in one hand. */}
        {!legIsPickup ? <CashNotice payment={active.payment} /> : null}

        {/* The address, in full and not truncated. An address cut off at the
            width of a phone is not an address — it wraps. */}
        <LegStop
          active={active}
          legIsPickup={legIsPickup}
          stopName={stopName}
          destination={destination}
        />

        {/* Navigate is the one control that has to be unmissable. It opens
            Google Maps with turn-by-turn; it falls back to the written
            address when the end has no pin, and greys out only when there
            is neither. The board keeps its state while the rider is in
            Maps, so switching back lands on the same card, code and all. */}
        <LegActions
          canNavigate={canNavigate}
          navigationUrl={navigationUrl}
          legIsPickup={legIsPickup}
          canCall={canCall}
          customerTel={customerTel}
        />

        {legIsPickup ? <CashNotice payment={active.payment} compact /> : null}

        {stepError ? (
          <p
            role="alert"
            className="rounded-xl bg-deal-soft px-3 py-2 text-sm font-semibold text-deal"
          >
            {stepError}
          </p>
        ) : null}

        <Button
          className="w-full"
          size="lg"
          disabled={pending}
          onClick={() => advance(active.job.id)}
        >
          <AdvanceLabel
            busy={pending && busyId === active.job.id}
            pickup={legIsPickup}
          />
        </Button>
      </div>
    </section>
  );
}

/** The first offer, in full: where it goes, then the one decision. */
function FeaturedOffer({
  featured,
  pending,
  busyId,
  accept,
}: Readonly<{
  featured: OfferJob;
  pending: boolean;
  busyId: string | null;
  accept: (orderId: string) => void;
}>) {
  return (
    <div>
      <RoutePanel
        from={featured.pickup.point}
        to={featured.drop.point}
        fromKind="shop"
        toKind="home"
        height={150}
      >
        {featured.reservedForYou ? (
          <span className="rounded-full bg-accent px-2.5 py-1 text-xs font-bold text-[var(--on-accent)]">
            Held for you
          </span>
        ) : null}
        <span className="ml-auto rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-xs font-bold text-white/80">
          {featured.code}
        </span>
      </RoutePanel>

      <div
        className={cn(
          "relative space-y-4 rounded-3xl border bg-surface p-4 shadow-[var(--shadow-md)]",
          featured.reservedForYou ? "border-accent" : "border-line",
          featured.pickup.point && featured.drop.point && "-mt-6"
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[22px] font-extrabold leading-tight tracking-tight">
              {featured.restaurant}
            </p>
            <p className="mt-1 text-sm text-muted">
              {featured.items} {featured.items === 1 ? "item" : "items"}
            </p>
          </div>
          {featured.distanceKm !== undefined ? (
            <div className="shrink-0 text-right">
              <p className="text-data text-[28px] font-extrabold leading-none">
                {featured.distanceKm}
                <span className="ml-0.5 text-sm font-bold text-muted">
                  km
                </span>
              </p>
              <p className="mt-1 text-xs text-muted">
                shop to customer
              </p>
            </div>
          ) : null}
        </div>

        {featured.reservedForYou ? (
          <p className="text-xs font-bold text-accent">
            Held for you for a few minutes, then it opens to everyone.
          </p>
        ) : null}

        <div className="space-y-3">
          <JobStop
            icon={<Store className="size-3.5" />}
            label="Pick up"
            stop={featured.pickup}
          />
          <JobStop
            icon={<MapPin className="size-3.5" />}
            label="Drop"
            stop={featured.drop}
          />
        </div>

        <CashNotice payment={featured.payment} compact />

        <Button
          size="lg"
          className="w-full"
          disabled={pending}
          onClick={() => accept(featured.id)}
        >
          {pending && busyId === featured.id ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            "Accept order"
          )}
        </Button>
      </div>
    </div>
  );
}

/** Orders still cooking that dispatch has already picked this rider for. */
function UpcomingJobs({
  upcoming,
  canNavigate,
}: Readonly<{
  upcoming: DriverBoardData["upcoming"];
  canNavigate: boolean;
}>) {
  return (
    <section>
      <SectionTitle right={<Pill tone="accent">Held for you</Pill>}>
        Coming up
      </SectionTitle>
      <p className="mb-3 text-xs text-muted">
        Still cooking. Head over now and it&apos;ll be waiting for you;
        it moves into your offers the moment the kitchen packs it.
      </p>
      <div className="space-y-3">
        {upcoming.map(({ job, readyInMinutes }) => {
          // Pin if there is one, the written address if not — Google's
          // geocoder on a street line beats no directions at all.
          const kitchenUrl = stopDirectionsUrl(job.pickup);
          return (
            <div key={job.id} className="card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                    <ChefHat className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-bold leading-tight">
                      {job.restaurant}
                    </p>
                    <p className="text-xs text-muted">
                      Order {job.code} · {job.items} items
                    </p>
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-bold text-ink">
                  <Timer className="size-3.5" />
                  {readyLabel(readyInMinutes)}
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

              {canNavigate && kitchenUrl ? (
                <a
                  href={kitchenUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses({
                    variant: "outline",
                    size: "sm",
                    className: "mt-3 w-full",
                  })}
                >
                  <Navigation className="size-4" /> Navigate to the
                  kitchen
                </a>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** No active delivery: the offers to take, and what is coming up. */
function JobOffers({
  live,
  available,
  acceptError,
  featured,
  others,
  upcoming,
  canNavigate,
  pending,
  busyId,
  accept,
}: Readonly<{
  live: boolean;
  available: OfferJob[];
  acceptError: string | null;
  featured: OfferJob | undefined;
  others: OfferJob[];
  upcoming: DriverBoardData["upcoming"];
  canNavigate: boolean;
  pending: boolean;
  busyId: string | null;
  accept: (orderId: string) => void;
}>) {
  return (
    <>
      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h1 className="text-[22px] font-extrabold tracking-tight">Jobs</h1>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-bold text-muted">
            {live
              ? `${available.length} nearby`
              : "Demo data"}
          </span>
        </div>

        <RingSetup />

        {acceptError ? (
          <p className="mb-3 rounded-xl bg-deal-soft px-3 py-2 text-sm font-medium text-deal">
            {acceptError}
          </p>
        ) : null}

        {!featured ? (
          <EmptyState
            icon={<Package className="size-7" />}
            title="No requests right now"
            description="Hang tight. Orders marked ready by kitchens appear here, and your phone will ring."
          />
        ) : (
          <div className="space-y-4">
            {/* The offer. Where it goes first, then the one decision. */}
            <FeaturedOffer
              featured={featured}
              pending={pending}
              busyId={busyId}
              accept={accept}
            />

            {others.map((job) => (
              <div
                key={job.id}
                className={cn(
                  "card p-4",
                  job.reservedForYou && "border-accent ring-1 ring-accent"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold leading-tight">{job.restaurant}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {job.items} {job.items === 1 ? "item" : "items"}
                      {job.distanceKm !== undefined
                        ? ` · ${job.distanceKm} km`
                        : ""}
                      {paymentNote(job.payment)}
                      {job.reservedForYou ? " · Held for you" : ""}
                    </p>
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
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Coming up — the kitchen has accepted, dispatch picked this rider,
          and the food is still being cooked.

          Orders only ever surfaced to riders at `ready`, which is the moment
          the bag is already sitting on the pass going cold. Told at
          acceptance instead, with the kitchen's own prep estimate, a rider
          can already be at the counter. Nothing here is accept-able yet — it
          is a heads-up and it says so; the order moves into the offers above,
          held for them, the moment the vendor marks it packed. */}
      {upcoming.length > 0 ? (
        <UpcomingJobs upcoming={upcoming} canNavigate={canNavigate} />
      ) : null}
    </>
  );
}
