"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  ReceiptText,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { TrackingMap, type RoadRoute } from "@/components/orders/tracking-map";
import {
  TrackingSheet,
  SHEET_SNAPS,
  SHEET_COLLAPSED_SNAP,
  SHEET_DEFAULT_SNAP,
} from "@/components/orders/tracking-sheet";
import { RefundRequest } from "@/components/orders/refund-request";
import { ProofOfDelivery } from "@/components/orders/proof-of-delivery";
import { RiderRatingCard } from "@/components/orders/rider-rating-card";
import { useLiveTracking, type TrackingHealth } from "@/hooks/use-live-tracking";
import {
  trackingSteps,
  statusIndex,
  canCustomerCancel,
} from "@/lib/utils/order-status";
import {
  shortOrderId,
  isOrderPaid,
  cancellationNote,
  type UiOrder,
} from "@/lib/utils/order-map";
import type { OrderEta } from "@/lib/orders/eta";
import type { OrderStatus, Rider } from "@/types";
import { CUSTOMER_LATE_CAP_MINUTES, formatINR } from "@/lib/utils/format";
import { DEFAULT_CENTER } from "@/lib/maps/config";
// The same helper the rider's own "Call customer" control uses. This file used
// to carry a byte-identical private copy, which is how the two ends of one
// phone call end up disagreeing about what counts as a dialable number.
import { callablePhone } from "@/lib/utils/phone";
import { cn } from "@/lib/utils/cn";
import type { T } from "@/lib/i18n/lang";
import { useLang } from "@/components/providers/lang-provider";

/** "1 minute" / "12 minutes" — the lateness line reads as a sentence. */
function minutesLabel(n: number, t: T): string {
  return t(`${n} minute${n === 1 ? "" : "s"}`, `${n} मिनट`);
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
function totalLabel(order: UiOrder, delivered: boolean, t: T): string {
  if (order.paymentStatus === "refunded")
    return t("Total refunded", "कुल रकम वापस की गई");
  if (isOrderPaid(order)) return t("Total paid", "कुल भुगतान हो गया");
  // Online and not marked paid means the money has not landed, whatever the
  // delivery state claims — only a verified signature moves `payment_status`.
  if (order.paymentMethod === "online")
    return t("Total (online, unpaid)", "कुल (ऑनलाइन, भुगतान बाकी)");
  // Cash, or a database before 0025 where cash was the only option. Handed over
  // at the door, so it is owed until the order is delivered and settled after.
  return delivered
    ? t("Total paid (Cash)", "कुल भुगतान हो गया (नकद)")
    : t("Total (Cash)", "कुल (नकद)");
}

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
function remainingMinutes(
  eta: OrderEta | null,
  roadRoute: RoadRoute | null,
): number | null {
  const measuredShortfall =
    roadRoute && eta ? Math.max(0, roadRoute.minutes - eta.rideMinutes) : 0;
  return eta?.minutesRemaining != null
    ? eta.minutesRemaining + measuredShortfall
    : null;
}

/** Whether the courier's pin belongs on the map at this status. */
function riderShownOnMap(status: OrderStatus, hasRider: boolean): boolean {
  // READY belongs here now that it is its own status: the courier is often
  // already assigned and on their way to the shop while the food waits on the
  // pass. It used to be included by accident, because `ready` displayed as
  // KITCHEN.
  return (
    status !== "DELIVERED" &&
    status !== "CANCELLED" &&
    hasRider &&
    (status === "ON_THE_WAY" || status === "READY" || status === "KITCHEN")
  );
}

/** A mock order's courier: drawn a little past halfway along the trip. */
function mockRiderPosition(
  show: boolean,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): { lat: number; lng: number } | null {
  return show
    ? {
        lat: from.lat + (to.lat - from.lat) * 0.55,
        lng: from.lng + (to.lng - from.lng) * 0.55,
      }
    : null;
}

/** The caption and the big number at the top of the sheet. */
function trackingHeadline(
  {
    delivered,
    cancelled,
    riderArrived,
    estimateUnmeasured,
    minutesRemaining,
    etaMinutes,
  }: {
    delivered: boolean;
    cancelled: boolean;
    /** The rider tapped "Arrived" at the door: no countdown is left to show. */
    riderArrived: boolean;
    estimateUnmeasured: boolean;
    minutesRemaining: number | null;
    etaMinutes?: number;
  },
  t: T,
): { headlineCaption: string; headline: string } {
  let headlineCaption: string;
  let headline: string;
  if (delivered) {
    headlineCaption = t("Your order was delivered", "आपका ऑर्डर डिलीवर हो गया");
    headline = t("Delivered", "डिलीवर हो गया");
  } else if (cancelled) {
    headlineCaption = t("This order was cancelled", "यह ऑर्डर कैंसिल हो गया");
    headline = t("Cancelled", "कैंसिल हो गया");
  } else if (riderArrived) {
    headlineCaption = t("Have your delivery code ready", "अपना डिलीवरी कोड तैयार रखें");
    headline = t("Your rider has arrived", "आपका राइडर पहुँच गया है");
  } else if (estimateUnmeasured) {
    headlineCaption = t("Delivery time", "डिलीवरी का समय");
    headline = t("Not available", "पता नहीं");
  } else {
    headlineCaption = t(
      "Estimated time of delivery",
      "डिलीवरी का अनुमानित समय",
    );
    if (minutesRemaining !== null) {
      headline =
        minutesRemaining > 0
          ? t(`${minutesRemaining} min`, `${minutesRemaining} मिनट`)
          : t("Arriving now", "बस पहुँच रहा है");
    } else if (etaMinutes) {
      headline = t(`~${etaMinutes} min`, `~${etaMinutes} मिनट`);
    } else {
      headline = t("Arriving", "आ रहा है");
    }
  }
  return { headlineCaption, headline };
}

export function TrackingView({
  order,
  deliveryOtp,
  initialEta,
}: Readonly<{
  order: UiOrder;
  deliveryOtp?: string | null;
  /**
   * Computed server-side for the first paint, so the headline is not a
   * per-restaurant constant for the frame before the first poll answers.
   */
  initialEta?: OrderEta | null;
}>) {
  const router = useRouter();
  const { lang, t } = useLang();
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

  // Only while the order is still on the way: the flag outlives the status
  // by up to one poll, and "arrived" over a delivered order would be stale.
  const riderArrived = isUuid && live.riderArrived && displayStatus === "ON_THE_WAY";
  const steps = trackingSteps(
    {
      restaurantName: order.restaurantName,
      riderName: displayRider?.name,
      riderArrived,
    },
    lang,
  );
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

  const minutesRemaining = remainingMinutes(eta, roadRoute);

  const mockRestaurant = useMemo(
    () => ({
      lat: DEFAULT_CENTER.lat + 0.012,
      lng: DEFAULT_CENTER.lng - 0.008,
    }),
    [],
  );
  const mockDestination = DEFAULT_CENTER;

  const restaurant = isUuid ? live.restaurant : mockRestaurant;
  const destination = isUuid ? live.destination : mockDestination;
  const showRiderOnMap = riderShownOnMap(displayStatus, Boolean(displayRider));
  const mockRiderOnMap = mockRiderPosition(
    showRiderOnMap,
    mockRestaurant,
    mockDestination,
  );
  const riderOnMap = isUuid ? live.riderPosition : mockRiderOnMap;

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
    const timer = window.setTimeout(() => setToast(false), 2600);
    return () => window.clearTimeout(timer);
  }, [justPlaced]);

  async function cancelOrder() {
    setCancelBusy(true);
    setCancelMsg(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/cancel`, {
        method: "POST",
      });
      if (res.ok) {
        await live.refresh();
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setCancelMsg(
          data.error === "too_late"
            ? t(
                "The kitchen already started — can't cancel now.",
                "किचन में खाना बनना शुरू हो गया है — अब कैंसिल नहीं हो सकता।",
              )
            : t(
                "Could not cancel. Try again.",
                "कैंसिल नहीं हो पाया। फिर कोशिश करें।",
              ),
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
      if (res.ok) {
        setRated(true);
        router.refresh();
      }
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

  /*
   * The sheet is dragged inside the stage — everything under the header — and
   * the map is sized to the sheet's lowest stop, so both need that height in
   * pixels. Measured rather than assumed: what is left under the header differs
   * between a phone with a notch, a phone without one and the desktop frame,
   * and all three are the same code path.
   */
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageHeight, setStageHeight] = useState(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Where the sheet is resting, and so how much of the map it is sitting on. */
  const [sheetTop, setSheetTop] = useState(0);
  const mapHeight = Math.round(stageHeight * SHEET_SNAPS[SHEET_COLLAPSED_SNAP]);
  const mapInset = stageHeight ? Math.max(0, mapHeight - sheetTop) : 0;

  // A finished order has nothing left to watch on a map — open on the details.
  // Read once, when the sheet mounts, so a status arriving mid-read never yanks
  // the sheet out from under the customer.
  const initialSnap = delivered || cancelled ? 0 : SHEET_DEFAULT_SNAP;

  const { headlineCaption, headline } = trackingHeadline(
    { delivered, cancelled, riderArrived, estimateUnmeasured, minutesRemaining, etaMinutes: order.etaMinutes },
    t,
  );

  return (
    /*
     * Two shells, not one scrolling page.
     *
     * `owns-bottom` gives back the 80px the app shell reserves for the tab bar
     * (see globals.css): this screen fills the frame exactly and scrolls
     * nothing at the page level, so the sheet runs to the bottom edge and the
     * bar floats over it. That reserved strip was the grey band under "Get help
     * with this order" — the sheet ended with the content and the shell's
     * background, plus the sheet's own drop shadow, showed through beneath it.
     */
    <div className="owns-bottom flex h-full flex-col">
      {toast ? (
        // Cleared below the status bar AND the sticky PageHeader beneath it
        // (top-[calc(var(--status-h)+1rem)] is the pattern used elsewhere for
        // the status bar alone) — this toast used to sit at a flat top-4 and
        // briefly cover the header's back button right after placing an order.
        <div className="animate-slide-up glass fixed left-1/2 top-[calc(var(--status-h)+3.75rem)] z-50 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2.5 shadow-[var(--shadow-md)]">
          <span className="grid size-6 place-items-center rounded-full bg-green text-[var(--on-green)]">
            <Check className="size-4" strokeWidth={3} />
          </span>
          <span className="text-sm font-bold">
            {t("Order placed", "ऑर्डर हो गया")}
          </span>
        </div>
      ) : null}

      <PageHeader
        title={t(
          `Order ${shortOrderId(order.id)}`,
          `ऑर्डर ${shortOrderId(order.id)}`,
        )}
        subtitle={order.restaurantName}
        className="shrink-0"
      />

      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden">
        {/* Exactly as tall as the sheet's lowest stop, so dragging down runs
            out of travel at the bottom of the map and never past it. The
            percentage is the same height before the stage has been measured —
            on the server, where there is nothing to measure. */}
        <div
          className="absolute inset-x-0 top-0 overflow-hidden"
          style={{
            height: stageHeight
              ? mapHeight
              : `${SHEET_SNAPS[SHEET_COLLAPSED_SNAP] * 100}%`,
          }}
        >
          <TrackingMap
            restaurant={restaurant}
            destination={destination}
            rider={riderOnMap}
            showRider={showRiderOnMap}
            snapRiderToRoute={riderPositionEstimated}
            onRoute={setRoadRoute}
            className="h-full"
            bottomInset={mapInset}
          />
        </div>

        <TrackingSheet
          stageHeight={stageHeight}
          initialSnap={initialSnap}
          onRestTop={setSheetTop}
          header={
            /*
             * The one thing on this screen that is read out loud, to a stranger,
             * at the door — so it lives in the sheet's header rather than in the
             * scroll, and is on screen at every stop including the one where the
             * sheet is pushed down to show the map. It used to be a tinted card
             * four blocks into a scrolling page: present, but something you had
             * to go and find while somebody waited.
             *
             * A hairline and two words, no fill and no box. The digits carry it.
             */
            deliveryOtp && !delivered && !cancelled ? (
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 pb-2.5 pt-0.5">
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-muted">
                  <ShieldCheck className="size-3.5 shrink-0" />
                  {t("Delivery code", "डिलीवरी कोड")}
                </span>
                <span className="text-data shrink-0 text-[22px] font-extrabold leading-none tracking-[0.22em] text-ink">
                  {deliveryOtp}
                </span>
              </div>
            ) : null
          }
        >
          <div className="space-y-4 px-4 pt-1">
            {/* The screen has stopped hearing from the server. Everything below is
            still the best we know, so it stays — but it is no longer live, and
            a tracking screen that looks live while frozen is worse than one
            that is visibly broken. The courier pin stops advancing at the same
            moment (see use-live-tracking). */}
            <StaleNotice health={live.health} />

            <EtaHeadline
              headlineCaption={headlineCaption}
              headline={headline}
              delivered={delivered}
              cancelled={cancelled}
              roadRoute={roadRoute}
              estimateUnmeasured={estimateUnmeasured}
              order={order}
            />

            {/* No cause is offered, because we do not know one. A late order is a
            fact about the clock; guessing at traffic or a busy kitchen would be
            inventing the one part of this screen we have no evidence for. */}
            <LateNotice eta={eta} delivered={delivered} cancelled={cancelled} />

            <OrderOutcome
              delivered={delivered}
              cancelled={cancelled}
              order={order}
              isUuid={isUuid}
              rating={rating}
              rateBusy={rateBusy}
              rated={rated}
              riderName={displayRider?.name}
              submitRating={submitRating}
              steps={steps}
              current={current}
            />

            <CourierInfo
              showRiderOnMap={showRiderOnMap}
              riderPositionEstimated={riderPositionEstimated}
              displayRider={displayRider}
              riderTel={riderTel}
              delivered={delivered}
              cancelled={cancelled}
            />

            <OrderFollowUp
              order={order}
              delivered={delivered}
              cancelled={cancelled}
              paid={paid}
              isUuid={isUuid}
              canCancel={canCancel}
              cancelBusy={cancelBusy}
              cancelMsg={cancelMsg}
              setShowCancelConfirm={setShowCancelConfirm}
            />
          </div>
        </TrackingSheet>
      </div>

      {showCancelConfirm ? (
        <CancelConfirm
          cancelBusy={cancelBusy}
          setShowCancelConfirm={setShowCancelConfirm}
          cancelOrder={cancelOrder}
        />
      ) : null}
    </div>
  );
}

function StaleNotice({ health }: Readonly<{ health: TrackingHealth }>) {
  const { t } = useLang();
  return health.stale ? (
    <p className="flex items-start gap-2 rounded-2xl border border-deal/30 bg-deal-soft px-3 py-2.5 text-xs font-medium leading-relaxed text-deal">
      <WifiOff className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {health.unauthorized ? (
          <>
            {t(
              "You've been signed out, so this has stopped updating.",
              "आप लॉग आउट हो गए हैं, इसलिए अपडेट रुक गए हैं।",
            )}{" "}
            <Link href="/login" className="underline">
              {t("Sign in", "लॉग इन करें")}
            </Link>{" "}
            {t("to see live progress.", "ताकि लाइव जानकारी दिखे।")}
          </>
        ) : (
          <>
            {health.ageMs !== null
              ? t(
                  `Not updating right now — showing the last status we received, about ${Math.max(1, Math.round(health.ageMs / 60000))} min ago. We'll reconnect automatically.`,
                  `अभी अपडेट नहीं हो रहा — लगभग ${Math.max(1, Math.round(health.ageMs / 60000))} मिनट पहले मिली आखिरी जानकारी दिखा रहे हैं। हम अपने आप फिर से जुड़ जाएँगे।`,
                )
              : t(
                  "Not updating right now — showing the last status we received. We'll reconnect automatically.",
                  "अभी अपडेट नहीं हो रहा — आखिरी मिली जानकारी दिखा रहे हैं। हम अपने आप फिर से जुड़ जाएँगे।",
                )}
          </>
        )}
      </span>
    </p>
  ) : null;
}

/** The countdown (or the outcome), and what it is measured from. */
function EtaHeadline({
  headlineCaption,
  headline,
  delivered,
  cancelled,
  roadRoute,
  estimateUnmeasured,
  order,
}: Readonly<{
  headlineCaption: string;
  headline: string;
  delivered: boolean;
  cancelled: boolean;
  roadRoute: RoadRoute | null;
  estimateUnmeasured: boolean;
  order: UiOrder;
}>) {
  const { t } = useLang();
  return (
    <div className="text-center">
      <p className="text-sm text-muted">{headlineCaption}</p>
      <p
        className={cn(
          "text-[40px] font-extrabold leading-none tracking-tight",
          delivered && "text-green",
          cancelled && "text-deal",
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
            ? t(
                `${Math.round(roadRoute.km * 1000)} m by road`,
                `सड़क से ${Math.round(roadRoute.km * 1000)} मीटर`,
              )
            : t(
                `${roadRoute.km.toFixed(1)} km by road`,
                `सड़क से ${roadRoute.km.toFixed(1)} किमी`,
              )}
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
            ? t(
                `${order.restaurantName} hasn't set its location yet, so we can't work out how long the trip takes.`,
                `${order.restaurantName} ने अभी अपनी लोकेशन नहीं डाली है, इसलिए हम नहीं बता सकते कि पहुँचने में कितना समय लगेगा।`,
              )
            : t(
                "This shop hasn't set its location yet, so we can't work out how long the trip takes.",
                "इस दुकान ने अभी अपनी लोकेशन नहीं डाली है, इसलिए हम नहीं बता सकते कि पहुँचने में कितना समय लगेगा।",
              )}
        </p>
      ) : null}
    </div>
  );
}

function LateNotice({
  eta,
  delivered,
  cancelled,
}: Readonly<{
  eta: OrderEta | null;
  delivered: boolean;
  cancelled: boolean;
}>) {
  const { t } = useLang();
  const showLateness = !delivered && !cancelled && Boolean(eta?.late);
  return showLateness && eta ? (
    <p className="flex items-center justify-center gap-2 rounded-2xl bg-deal-soft px-3 py-2.5 text-center text-sm font-bold text-deal">
      <Clock className="size-4 shrink-0" />
      {eta.lateByMinutes >= CUSTOMER_LATE_CAP_MINUTES
        ? t(
            "This order is delayed. Our team is on it — contact support if you need help.",
            "ऑर्डर में देरी है, हमारी टीम देख रही है — मदद चाहिए तो सपोर्ट से बात करें।",
          )
        : t(
            `Running about ${minutesLabel(eta.lateByMinutes, t)} late`,
            `लगभग ${minutesLabel(eta.lateByMinutes, t)} की देरी`,
          )}
    </p>
  ) : null;
}

/** How it ended — a rating, or who cancelled — or the stages still to come. */
function OrderOutcome({
  delivered,
  cancelled,
  order,
  isUuid,
  rating,
  rateBusy,
  rated,
  riderName,
  submitRating,
  steps,
  current,
}: Readonly<{
  delivered: boolean;
  cancelled: boolean;
  order: UiOrder;
  isUuid: boolean;
  rating: number;
  rateBusy: boolean;
  rated: boolean;
  /** The courier on the order, for "Rate <name>"; undefined when none is recorded. */
  riderName?: string;
  submitRating: (n: number) => Promise<void>;
  steps: ReturnType<typeof trackingSteps>;
  current: number;
}>) {
  const { lang, t } = useLang();
  const cancelNote = cancelled ? cancellationNote(order, lang) : null;
  return (
    <>
      {delivered ? (
        <div className="rounded-2xl bg-green-soft p-5 text-center">
          <p className="text-[15px] font-bold">
            {rated
              ? t("Thanks for rating!", "रेटिंग देने के लिए धन्यवाद!")
              : t(
                  "Hope it was delicious. How was it?",
                  "उम्मीद है खाना अच्छा लगा। कैसा था?",
                )}
          </p>
          <div className="mt-3 flex justify-center gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                disabled={rateBusy || rated || !isUuid}
                onClick={() => submitRating(n)}
                aria-label={t(
                  `Rate ${n} star${n > 1 ? "s" : ""}`,
                  `${n} स्टार दें`,
                )}
                className="press grid size-11 place-items-center rounded-full bg-surface disabled:opacity-100"
              >
                <Star
                  className={cn(
                    "size-5",
                    n <= rating ? "fill-pop text-pop" : "text-muted",
                  )}
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* The courier, rated apart from the food: one rating per order, and
      the rider never learns who gave it (migration 0084). */}
      {delivered && isUuid && riderName ? (
        <RiderRatingCard orderId={order.id} riderName={riderName} />
      ) : null}

      {/* The photo the rider took at the door, if they were asked for one. */}
      {delivered && isUuid ? <ProofOfDelivery orderId={order.id} /> : null}

      {/* The stages are meaningless for an order that stopped, so this is
      what takes their place: who ended it and, when they said, why.
      `cancellationNote` returns null for a row we cannot attribute —
      cancelled before migration 0051, or a database without it — and
      nothing is drawn rather than a guess about whose fault it was. */}
      {cancelled && cancelNote ? (
        <div className="rounded-2xl bg-surface-2 p-4">
          <p className="text-[15px] font-bold">{cancelNote.who}</p>
          {cancelNote.reason ? (
            <p className="mt-1 text-sm leading-relaxed text-muted">
              &ldquo;{cancelNote.reason}&rdquo;
            </p>
          ) : null}
        </div>
      ) : null}

      {!delivered && !cancelled ? (
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
                      done &&
                        "border-green bg-green text-[var(--on-green)]",
                      active && "border-green bg-surface",
                      !done && !active && "border-line bg-surface",
                    )}
                  >
                    {done ? (
                      <Check className="size-3.5" strokeWidth={3} />
                    ) : null}
                    {active ? (
                      <span className="size-2.5 rounded-full bg-green" />
                    ) : null}
                  </span>
                  {!last ? (
                    <span
                      className={cn(
                        "my-1 w-0.5 flex-1 rounded-full",
                        done ? "bg-green" : "bg-line",
                      )}
                      style={{ minHeight: 26 }}
                    />
                  ) : null}
                </div>
                <div className={cn("pb-5", last && "pb-0")}>
                  <p
                    className={cn(
                      "text-[15px] font-bold leading-tight",
                      !done && !active && "text-muted",
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
      ) : null}
    </>
  );
}

/** Who is bringing it, and how much the pin on the map can be trusted. */
function CourierInfo({
  showRiderOnMap,
  riderPositionEstimated,
  displayRider,
  riderTel,
  delivered,
  cancelled,
}: Readonly<{
  showRiderOnMap: boolean;
  riderPositionEstimated: boolean;
  displayRider: Rider | null | undefined;
  riderTel: string | null;
  delivered: boolean;
  cancelled: boolean;
}>) {
  const { t } = useLang();
  return (
    <>
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
            {t(
              "The courier pin is an estimate along the route — this rider isn't sharing a live location.",
              "राइडर का निशान रास्ते के हिसाब से अंदाज़ा है — यह राइडर अपनी लाइव लोकेशन शेयर नहीं कर रहा।",
            )}
          </span>
        </p>
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
            <span className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-[color:var(--surface)]">
              {t("Deligro rider", "Deligro राइडर")}
            </span>
            <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--surface)]/70">
              <ShieldCheck className="size-3" />{" "}
              {t("Verified", "सत्यापित")}
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
                  {t("ID", "आईडी")} {displayRider.id}
                </p>
              ) : null}
              {/* Only shown when we actually know it. Every rider used to be
              labelled "4.9 ★ · Bike" — a rating we have never collected. */}
              {displayRider.rating !== undefined ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-muted">
                  <Star className="size-3 fill-pop text-pop" />
                  {displayRider.rating}
                  {displayRider.vehicle
                    ? ` · ${displayRider.vehicle}`
                    : ""}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted">
                  {displayRider.vehicle ||
                    t(
                      "Bringing your order to the door",
                      "आपका ऑर्डर घर तक ला रहे हैं",
                    )}
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
                aria-label={t(
                  `Call ${displayRider.name}`,
                  `${displayRider.name} को कॉल करें`,
                )}
                className="press flex shrink-0 flex-col items-center gap-1 rounded-xl bg-accent px-3.5 py-2.5 text-[var(--on-accent)] shadow-[var(--glow-accent)]"
              >
                <Phone className="size-5" />
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  {t("Call", "कॉल")}
                </span>
              </a>
            ) : (
              <button
                type="button"
                aria-label={t("Call rider", "राइडर को कॉल करें")}
                disabled
                title={t(
                  "No phone number recorded for this rider",
                  "इस राइडर का फ़ोन नंबर नहीं है",
                )}
                className="press flex shrink-0 flex-col items-center gap-1 rounded-xl bg-accent px-3.5 py-2.5 text-[var(--on-accent)] opacity-50 shadow-[var(--glow-accent)]"
              >
                <Phone className="size-5" />
                <span className="text-[11px] font-bold uppercase tracking-wider">
                  {t("Call", "कॉल")}
                </span>
              </button>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The bill, and everything left to do with the order from here. */
function OrderFollowUp({
  order,
  delivered,
  cancelled,
  paid,
  isUuid,
  canCancel,
  cancelBusy,
  cancelMsg,
  setShowCancelConfirm,
}: Readonly<{
  order: UiOrder;
  delivered: boolean;
  cancelled: boolean;
  paid: boolean;
  isUuid: boolean;
  canCancel: boolean;
  cancelBusy: boolean;
  cancelMsg: string | null;
  setShowCancelConfirm: (open: boolean) => void;
}>) {
  const { t } = useLang();
  return (
    <>
      <div className="card p-4">
        <h2 className="mb-3 text-[17px] font-extrabold tracking-tight">
          {t("Order", "ऑर्डर")} {shortOrderId(order.id)}
        </h2>
        <ul className="space-y-2 text-sm">
          {order.lines.map((l) => (
            <li key={l.itemId} className="flex justify-between">
              <span className="text-muted">
                {l.qty}× <span className="text-ink">{l.name}</span>
              </span>
              <span className="text-data">
                {formatINR(l.price * l.qty)}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-between border-t border-line pt-3">
          <span className="font-extrabold">
            {totalLabel(order, delivered, t)}
          </span>
          <span className="text-data text-base font-extrabold">
            {formatINR(order.total)}
          </span>
        </div>
      </div>

      {/* Once an order is finished — delivered or cancelled — asking for money
      back is the only thing left to do with it. Mock orders are excluded
      because there is no row behind them to refund. A cancelled order that
      was never paid (cash on delivery) has nothing to give back, so it is
      not offered there. */}
      {isUuid && (delivered || (cancelled && paid)) ? (
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
            {t("Cancel order", "ऑर्डर कैंसिल करें")}
          </button>
          {cancelMsg ? (
            <p className="rounded-xl bg-deal-soft px-3 py-2 text-center text-sm font-medium text-deal">
              {cancelMsg}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* A delivered order is a completed sale, and until now the app
          produced no record of one. The receipt is its own page so it has
          a URL to come back to and can be printed without the phone frame
          around it. */}
      {delivered ? (
        <Link
          href={`/orders/${order.id}/receipt`}
          className="press flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface py-3.5 text-sm font-bold text-ink"
        >
          <ReceiptText className="size-4" />{" "}
          {t("View receipt", "रसीद देखें")}
        </Link>
      ) : null}

      <Link
        href={`/profile/help?order=${encodeURIComponent(order.id)}`}
        className="press flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface py-3.5 text-sm font-bold text-ink"
      >
        <CircleHelp className="size-4" />{" "}
        {t("Get help with this order", "इस ऑर्डर के लिए मदद लें")}
      </Link>
    </>
  );
}

function CancelConfirm({
  cancelBusy,
  setShowCancelConfirm,
  cancelOrder,
}: Readonly<{
  cancelBusy: boolean;
  setShowCancelConfirm: (open: boolean) => void;
  cancelOrder: () => Promise<void>;
}>) {
  const { t } = useLang();
  return (
    // `fixed` so it covers the phone screen rather than the scrolled page
    // it's rendered inside — the app shell is the containing block.
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={t("Dismiss", "बंद करें")}
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
          {t("Cancel order?", "ऑर्डर कैंसिल करें?")}
        </h2>
        <p className="mt-2 text-center text-sm leading-relaxed text-muted">
          {t(
            "Do you want to cancel your order? This can't be undone.",
            "क्या आप अपना ऑर्डर कैंसिल करना चाहते हैं? यह वापस नहीं होगा।",
          )}
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setShowCancelConfirm(false)}
            disabled={cancelBusy}
            className="press rounded-full border border-line bg-surface py-3 text-sm font-bold text-ink disabled:opacity-60"
          >
            {t("No", "नहीं")}
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
            {t("Yes, cancel", "हाँ, कैंसिल करें")}
          </button>
        </div>
      </div>
    </div>
  );
}
