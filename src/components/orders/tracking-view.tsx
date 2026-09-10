"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Phone,
  Check,
  CircleHelp,
  Star,
  ShieldCheck,
  XCircle,
  Loader2,
  Navigation,
  Clock,
  WifiOff,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { TrackingMap, type RoadRoute } from "@/components/orders/tracking-map";
import { RefundRequest } from "@/components/orders/refund-request";
import { useLiveTracking } from "@/hooks/use-live-tracking";
import {
  trackingSteps,
  statusIndex,
  canCustomerCancel,
} from "@/lib/utils/order-status";
import { shortOrderId, isOrderPaid, type UiOrder } from "@/lib/utils/order-map";
import type { OrderEta } from "@/lib/orders/eta";
import { formatINR } from "@/lib/utils/format";
import { DEFAULT_CENTER } from "@/lib/maps/config";
// The same helper the rider's own "Call customer" control uses. This file used
// to carry a byte-identical private copy, which is how the two ends of one
// phone call end up disagreeing about what counts as a dialable number.
import { callablePhone } from "@/lib/utils/phone";
import { cn } from "@/lib/utils/cn";

/** "1 minute" / "12 minutes" — the lateness line reads as a sentence. */
function minutesLabel(n: number): string {
  return `${n} minute${n === 1 ? "" : "s"}`;
}

/**
 * What to call the total.
 *
 * This line used to be `Total {delivered ? "paid" : "(Cash)"}` — written before
 * migration 0025 existed, when cash was the only way to pay. It told a customer
 * who had already paid by card that they owed cash, and told a customer whose
 * online payment had failed that the bill was settled the moment it was marked
 * delivered.
 */
function totalLabel(order: UiOrder, delivered: boolean): string {
  if (order.paymentStatus === "refunded") return "Total refunded";
  if (isOrderPaid(order)) return "Total paid";
  // Online and not marked paid means the money has not landed, whatever the
  // delivery state claims — only a verified signature moves `payment_status`.
  if (order.paymentMethod === "online") return "Total (online, unpaid)";
  // Cash, or a database before 0025 where cash was the only option. Handed over
  // at the door, so it is owed until the order is delivered and settled after.
  return delivered ? "Total paid (Cash)" : "Total (Cash)";
}

export function TrackingView({
  order,
  deliveryOtp,
  initialEta,
}: {
  order: UiOrder;
  deliveryOtp?: string | null;
  /**
   * Computed server-side for the first paint, so the headline is not a
   * per-restaurant constant for the frame before the first poll answers.
   */
  initialEta?: OrderEta | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const justPlaced = params.get("placed") === "1";
  const [toast, setToast] = useState(justPlaced);

  /**
   * What the map's one Directions lookup measured, or null until it lands (and
   * for good, if the lookup failed or the key has no Directions API). The
   * server's estimate never waits on this — it is a refinement of a number that
   * is already on screen, not a dependency of it.
   */
  const [roadRoute, setRoadRoute] = useState<RoadRoute | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [rating, setRating] = useState(0);
  const [rateBusy, setRateBusy] = useState(false);
  const [rated, setRated] = useState(false);

  const isUuid = /^[0-9a-f-]{36}$/i.test(order.id);
  const live = useLiveTracking(order.id, {
    status: order.status,
    eta: initialEta,
    rider: order.rider ?? null,
  });

  const displayStatus = isUuid ? live.status : order.status;
  const displayRider = isUuid ? (live.rider ?? order.rider) : order.rider;

  const steps = trackingSteps({
    restaurantName: order.restaurantName,
    riderName: displayRider?.name,
  });
  const current = statusIndex(displayStatus);
  const delivered = displayStatus === "DELIVERED";
  const cancelled = displayStatus === "CANCELLED";
  // Mirrors the CANCELLABLE set in /api/orders/[id]/cancel. Offering it any
  // wider produces a 409 the customer reads as "the kitchen already started" —
  // which is what every `ready` order got, back when `ready` was displayed as
  // KITCHEN and this condition was written against the display value.
  const canCancel = canCustomerCancel(displayStatus);
  const paid = isOrderPaid(order);

  // A real countdown once the backend is live; the restaurant's advertised
  // number is all a mock order has, and it is labelled as an estimate below
  // rather than dressed up as a live one.
  const eta = isUuid ? live.eta : null;

  /**
   * The countdown, with the measured drive time allowed to push it out.
   *
   * The server models the road leg from straight-line distance
   * (`lib/orders/road-leg.ts`) because it cannot afford a routing call on a
   * 3-second poll. The map has since bought exactly one, so when Google's drive
   * time for this trip exceeds what the model assumed, the shortfall is added
   * to what is left. Longer of the two, which is the same rule the server
   * applies between the band and the model.
   *
   * It can only ever push the estimate later. A measured route that comes back
   * faster than the model is not evidence the food will arrive sooner — the
   * model's caution is deliberate — so `Math.max(0, …)` drops it.
   */
  const measuredShortfall =
    roadRoute && eta ? Math.max(0, roadRoute.minutes - eta.rideMinutes) : 0;
  const minutesRemaining =
    eta?.minutesRemaining != null
      ? eta.minutesRemaining + measuredShortfall
      : null;

  const mockRestaurant = useMemo(
    () => ({
      lat: DEFAULT_CENTER.lat + 0.012,
      lng: DEFAULT_CENTER.lng - 0.008,
    }),
    []
  );
  const mockDestination = DEFAULT_CENTER;

  const restaurant = isUuid ? live.restaurant : mockRestaurant;
  const destination = isUuid ? live.destination : mockDestination;
  // READY belongs here now that it is its own status: the courier is often
  // already assigned and on their way to the shop while the food waits on the
  // pass. It used to be included by accident, because `ready` displayed as
  // KITCHEN.
  const showRiderOnMap =
    !delivered &&
    !cancelled &&
    Boolean(displayRider) &&
    (displayStatus === "ON_THE_WAY" ||
      displayStatus === "READY" ||
      displayStatus === "KITCHEN");
  const riderOnMap = isUuid
    ? live.riderPosition
    : showRiderOnMap
      ? {
          lat: mockRestaurant.lat + (mockDestination.lat - mockRestaurant.lat) * 0.55,
          lng: mockRestaurant.lng + (mockDestination.lng - mockRestaurant.lng) * 0.55,
        }
      : null;

  // The dot is only a rider's location when a rider's device said so
  // (deliveries.driver_location_source = 'gps', migration 0026). Anything else
  // — a database without the column, a courier not sharing, a fix gone stale —
  // is a point drawn from the route and the clock, and the mock path is not
  // even that. Showing it is still useful; presenting it as live is not ours to
  // do, so the caption below says which it is.
  const riderPositionEstimated =
    Boolean(riderOnMap) && (!isUuid || live.riderPositionSource !== "gps");

  const riderTel = callablePhone(displayRider?.phone);

  useEffect(() => {
    if (!justPlaced) return;
    const t = window.setTimeout(() => setToast(false), 2600);
    return () => window.clearTimeout(t);
  }, [justPlaced]);

  async function cancelOrder() {
    setCancelBusy(true);
    setCancelMsg(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/cancel`, { method: "POST" });
      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setCancelMsg(
          data.error === "too_late"
            ? "The kitchen already started — can't cancel now."
            : "Could not cancel. Try again."
        );
      }
    } finally {
      setCancelBusy(false);
    }
  }

  async function submitRating(n: number) {
    if (!isUuid) return;
    setRating(n);
    setRateBusy(true);
    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id, rating: n }),
      });
      if (res.ok) setRated(true);
    } finally {
      setRateBusy(false);
    }
  }

  /*
   * The big number.
   *
   * `minutesRemaining` is already floored at zero in `lib/orders/eta.ts`, so a
   * blown estimate reads "Arriving now" and the lateness line below carries the
   * actual news — rather than the countdown silently going negative, or worse,
   * sticking at a number the food passed twenty minutes ago.
   */
  /**
   * Did anything actually measure this delivery?
   *
   * False means the shop has never been pinned, so `computeOrderEta` had no
   * distance and fell back to the restaurant's advertised band — a claim about
   * how fast that kitchen cooks, not about how far the food has to travel. A
   * 70 km order rendered "25 min" this way. We keep the number off the screen
   * rather than dress a kitchen's promise up as an arrival time.
   */
  const estimateUnmeasured = Boolean(eta) && eta?.distanceKnown === false;

  const headline = delivered
    ? "Delivered"
    : cancelled
      ? "Cancelled"
      : estimateUnmeasured
        ? "Not available"
        : minutesRemaining !== null
          ? minutesRemaining > 0
            ? `${minutesRemaining} min`
            : "Arriving now"
          : order.etaMinutes
            ? `~${order.etaMinutes} min`
            : "Arriving";

  const showLateness = !delivered && !cancelled && Boolean(eta?.late);

  return (
    <div className="relative">
      {toast ? (
        // Cleared below the status bar AND the sticky PageHeader beneath it
        // (top-[calc(var(--status-h)+1rem)] is the pattern used elsewhere for
        // the status bar alone) — this toast used to sit at a flat top-4 and
        // briefly cover the header's back button right after placing an order.
        <div className="animate-slide-up glass fixed left-1/2 top-[calc(var(--status-h)+3.75rem)] z-50 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2.5 shadow-[var(--shadow-md)]">
          <span className="grid size-6 place-items-center rounded-full bg-green text-[var(--on-green)]">
            <Check className="size-4" strokeWidth={3} />
          </span>
          <span className="text-sm font-bold">Order placed</span>
        </div>
      ) : null}

      <PageHeader
        title={`Order ${shortOrderId(order.id)}`}
        subtitle={order.restaurantName}
      />

      <TrackingMap
        restaurant={restaurant}
        destination={destination}
        rider={riderOnMap}
        showRider={showRiderOnMap}
        snapRiderToRoute={riderPositionEstimated}
        onRoute={setRoadRoute}
      />

      <div className="bolt-sheet relative -mt-6 space-y-4 px-4 pt-2">
        <div className="bolt-sheet-handle" />

        {/* The screen has stopped hearing from the server. Everything below is
            still the best we know, so it stays — but it is no longer live, and
            a tracking screen that looks live while frozen is worse than one
            that is visibly broken. The courier pin stops advancing at the same
            moment (see use-live-tracking). */}
        {live.health.stale ? (
          <p className="flex items-start gap-2 rounded-2xl border border-deal/30 bg-deal-soft px-3 py-2.5 text-xs font-medium leading-relaxed text-deal">
            <WifiOff className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {live.health.unauthorized ? (
                <>
                  You&apos;ve been signed out, so this has stopped updating.{" "}
                  <Link href="/login" className="underline">
                    Sign in
                  </Link>{" "}
                  to see live progress.
                </>
              ) : (
                <>
                  Not updating right now — showing the last status we received
                  {live.health.ageMs !== null
                    ? `, about ${Math.max(1, Math.round(live.health.ageMs / 60000))} min ago`
                    : ""}
                  . We&apos;ll reconnect automatically.
                </>
              )}
            </span>
          </p>
        ) : null}

        <div className="text-center">
          <p className="text-sm text-muted">
            {delivered
              ? "Your order was delivered"
              : cancelled
                ? "This order was cancelled"
                : estimateUnmeasured
                  ? "Delivery time"
                  : "Estimated time of delivery"}
          </p>
          <p
            className={cn(
              "text-[40px] font-extrabold leading-none tracking-tight",
              delivered && "text-green",
              cancelled && "text-deal"
            )}
          >
            {headline}
          </p>
          {/* The trip, in the units a customer actually asks in. It is the
              measured road distance, never the straight line the map used to
              draw — reading a distance off that line was the thing that could
              not be done, and quoting it here would have been the same error
              with more confidence. Absent until Directions answers, because
              until then we genuinely do not know it. */}
          {roadRoute && !delivered && !cancelled ? (
            <p className="text-xs font-medium text-muted">
              {roadRoute.km < 1
                ? `${Math.round(roadRoute.km * 1000)} m by road`
                : `${roadRoute.km.toFixed(1)} km by road`}
            </p>
          ) : null}

          {/* "Not available" on its own is a dead end. Say which fact is
              missing, so the answer is actionable by whoever can fix it —
              nobody can pin a shop they have not been told is unpinned. The
              shop is named as the gap because it is: the customer's own
              address is not at fault and must not be implied to be. */}
          {estimateUnmeasured && !delivered && !cancelled ? (
            <p className="mx-auto mt-1 max-w-[34ch] text-xs font-medium leading-snug text-muted">
              {order.restaurantName
                ? `${order.restaurantName} hasn't set its location yet, so we can't work out how long the trip takes.`
                : "This shop hasn't set its location yet, so we can't work out how long the trip takes."}
            </p>
          ) : null}
        </div>

        {/* No cause is offered, because we do not know one. A late order is a
            fact about the clock; guessing at traffic or a busy kitchen would be
            inventing the one part of this screen we have no evidence for. */}
        {showLateness && eta ? (
          <p className="flex items-center justify-center gap-2 rounded-2xl bg-deal-soft px-3 py-2.5 text-center text-sm font-bold text-deal">
            <Clock className="size-4 shrink-0" />
            Running about {minutesLabel(eta.lateByMinutes)} late
          </p>
        ) : null}

        {delivered ? (
          <div className="rounded-2xl bg-green-soft p-5 text-center">
            <p className="text-[15px] font-bold">
              {rated ? "Thanks for rating!" : "Hope it was delicious. How was it?"}
            </p>
            <div className="mt-3 flex justify-center gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  disabled={rateBusy || rated || !isUuid}
                  onClick={() => submitRating(n)}
                  aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`}
                  className="press grid size-11 place-items-center rounded-full bg-surface disabled:opacity-100"
                >
                  <Star
                    className={cn(
                      "size-5",
                      n <= rating ? "fill-pop text-pop" : "text-muted"
                    )}
                  />
                </button>
              ))}
            </div>
          </div>
        ) : cancelled ? null : (
          <ol className="pl-1">
            {steps.map((step, i) => {
              const done = i < current;
              const active = i === current;
              const last = i === steps.length - 1;
              return (
                <li key={step.key} className="flex gap-3.5">
                  <div className="flex flex-col items-center">
                    <span
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-full border-2",
                        done && "border-green bg-green text-[var(--on-green)]",
                        active && "border-green bg-surface",
                        !done && !active && "border-line bg-surface"
                      )}
                    >
                      {done ? (
                        <Check className="size-3.5" strokeWidth={3} />
                      ) : active ? (
                        <span className="size-2.5 rounded-full bg-green" />
                      ) : null}
                    </span>
                    {!last ? (
                      <span
                        className={cn(
                          "my-1 w-0.5 flex-1 rounded-full",
                          done ? "bg-green" : "bg-line"
                        )}
                        style={{ minHeight: 26 }}
                      />
                    ) : null}
                  </div>
                  <div className={cn("pb-5", last && "pb-0")}>
                    <p
                      className={cn(
                        "text-[15px] font-bold leading-tight",
                        !done && !active && "text-muted"
                      )}
                    >
                      {step.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">{step.sub}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {/* The map draws the same confident green dot whether or not anybody
            reported a position, so the correction has to be made in words. The
            pin still earns its place — it shows progress along the route, which
            is real — but calling it the rider's location when
            `driver_location_source` says otherwise is the claim this caption
            takes back. It disappears of its own accord the moment a rider's
            device starts reporting. */}
        {showRiderOnMap && riderPositionEstimated ? (
          <p className="flex items-start gap-2 rounded-2xl bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
            <Navigation className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The courier pin is an estimate along the route — this rider
              isn&apos;t sharing a live location.
            </span>
          </p>
        ) : null}

        {deliveryOtp && !delivered && !cancelled ? (
          <div className="flex items-center gap-3 rounded-2xl bg-accent-soft p-4">
            <span className="grid size-10 place-items-center rounded-xl bg-accent text-[var(--on-accent)]">
              <ShieldCheck className="size-5" />
            </span>
            <div className="flex-1">
              <p className="text-label !text-accent-ink">Delivery code</p>
              <p className="text-xs text-muted">Share with your rider at the door</p>
            </div>
            <span className="text-data text-2xl font-extrabold tracking-[0.3em] text-accent-ink">
              {deliveryOtp}
            </span>
          </div>
        ) : null}

        {/* The courier, as an ID card.

            It was a plain row — initial, name, "Your courier", call button —
            which is the same layout this app uses for a saved address or a
            payment method, and it read like one. The person about to knock on
            your door is not a list item. This is the identification a customer
            can hold their phone up against: the platform's name on it, the
            rider's name, their Deligro ID, and one control that does the one
            thing you would want to do with it. */}
        {displayRider && !delivered && !cancelled ? (
          <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-md)]">
            <div className="flex items-center justify-between gap-2 bg-ink px-4 py-1.5">
              <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[color:var(--surface)]">
                Deligro rider
              </span>
              <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[color:var(--surface)]/70">
                <ShieldCheck className="size-3" /> Verified
              </span>
            </div>

            <div className="flex items-center gap-3 p-3.5">
              <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-surface-2 text-xl font-extrabold text-ink">
                {displayRider.name.charAt(0).toUpperCase()}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-extrabold leading-tight">
                  {displayRider.name}
                </p>
                {/* The ID is the point of the card: it is the thing a customer
                    can quote to support about one specific courier, and the
                    thing that makes "is this my rider?" answerable at the door
                    rather than a matter of trusting whoever turned up. */}
                {displayRider.id ? (
                  <p className="text-data mt-0.5 text-[11px] font-bold tracking-[0.12em] text-muted">
                    ID {displayRider.id}
                  </p>
                ) : null}
                {/* Only shown when we actually know it. Every rider used to be
                    labelled "4.9 ★ · Bike" — a rating we have never collected. */}
                {displayRider.rating !== undefined ? (
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted">
                    <Star className="size-3 fill-pop text-pop" />
                    {displayRider.rating}
                    {displayRider.vehicle ? ` · ${displayRider.vehicle}` : ""}
                  </p>
                ) : displayRider.vehicle ? (
                  <p className="mt-1 text-xs text-muted">{displayRider.vehicle}</p>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    Bringing your order to the door
                  </p>
                )}
              </div>

              {/* A "Message rider" button used to sit beside this: permanently
                  disabled, 50% opacity, no explanation, right next to a Call
                  button that works. There is no chat backend and none is
                  planned, so it was not a control waiting on data — it was a
                  control waiting on a feature. Removed rather than left greyed
                  out; calling is how you reach your rider, and the button that
                  does it is now the only one offered. */}
              {riderTel ? (
                <a
                  href={`tel:${riderTel}`}
                  aria-label={`Call ${displayRider.name}`}
                  className="press flex shrink-0 flex-col items-center gap-1 rounded-xl bg-accent px-3.5 py-2.5 text-[var(--on-accent)] shadow-[var(--glow-accent)]"
                >
                  <Phone className="size-5" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">
                    Call
                  </span>
                </a>
              ) : (
                <button
                  type="button"
                  aria-label="Call rider"
                  disabled
                  title="No phone number recorded for this rider"
                  className="press flex shrink-0 flex-col items-center gap-1 rounded-xl bg-accent px-3.5 py-2.5 text-[var(--on-accent)] opacity-50 shadow-[var(--glow-accent)]"
                >
                  <Phone className="size-5" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">
                    Call
                  </span>
                </button>
              )}
            </div>
          </div>
        ) : null}

        <div className="card p-4">
          <h2 className="mb-3 text-[17px] font-extrabold tracking-tight">
            Order {shortOrderId(order.id)}
          </h2>
          <ul className="space-y-2 text-sm">
            {order.lines.map((l) => (
              <li key={l.itemId} className="flex justify-between">
                <span className="text-muted">
                  {l.qty}× <span className="text-ink">{l.name}</span>
                </span>
                <span className="text-data">{formatINR(l.price * l.qty)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between border-t border-line pt-3">
            <span className="font-extrabold">{totalLabel(order, delivered)}</span>
            <span className="text-data text-base font-extrabold">
              {formatINR(order.total)}
            </span>
          </div>
        </div>

        {/* Once an order is finished — delivered or cancelled — asking for money
            back is the only thing left to do with it. Mock orders are excluded
            because there is no row behind them to refund. */}
        {isUuid && (delivered || cancelled) ? (
          <RefundRequest
            orderId={order.id}
            orderTotal={order.total}
            paid={paid}
          />
        ) : null}

        {canCancel ? (
          <div className="space-y-1">
            <button
              onClick={() => setShowCancelConfirm(true)}
              disabled={cancelBusy}
              className="press flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface py-3.5 text-sm font-bold text-deal disabled:opacity-60"
            >
              {cancelBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <XCircle className="size-4" />
              )}
              Cancel order
            </button>
            {cancelMsg ? (
              <p className="rounded-xl bg-deal-soft px-3 py-2 text-center text-sm font-medium text-deal">
                {cancelMsg}
              </p>
            ) : null}
          </div>
        ) : null}

        <Link
          href={`/profile/help?order=${encodeURIComponent(order.id)}`}
          className="press flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface py-3.5 text-sm font-bold text-ink"
        >
          <CircleHelp className="size-4" /> Get help with this order
        </Link>
      </div>

      {showCancelConfirm ? (
        // `fixed` so it covers the phone screen rather than the scrolled page
        // it's rendered inside — the app shell is the containing block.
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setShowCancelConfirm(false)}
            className="animate-fade-in absolute inset-0 bg-ink/40"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-order-title"
            className="absolute left-1/2 top-1/2 w-[min(100%-2rem,20rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-surface p-5 shadow-[var(--shadow-lg)]"
          >
            <h2
              id="cancel-order-title"
              className="text-center text-[17px] font-extrabold tracking-tight"
            >
              Cancel order?
            </h2>
            <p className="mt-2 text-center text-sm leading-relaxed text-muted">
              Do you want to cancel your order? This can&apos;t be undone.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setShowCancelConfirm(false)}
                disabled={cancelBusy}
                className="press rounded-full border border-line bg-surface py-3 text-sm font-bold text-ink disabled:opacity-60"
              >
                No
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowCancelConfirm(false);
                  await cancelOrder();
                }}
                disabled={cancelBusy}
                className="press rounded-full bg-deal py-3 text-sm font-bold text-[var(--on-deal)] disabled:opacity-60"
              >
                Yes, cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
