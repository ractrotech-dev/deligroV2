import type { OrderStatus } from "@/types";
import { HINDI_ENABLED, translator, type Bi, type Lang } from "@/lib/i18n/lang";

/**
 * Short labels for the order-list row and the home "ongoing order" strip.
 *
 * `PLACED` used to read "Order placed", which is true and useless: it is the one
 * stage where the customer's actual question — has anyone at the restaurant
 * looked at this yet? — has an answer, and the answer is no. `READY` is new; the
 * stage existed in the database from the start and had no label anywhere,
 * because it was folded into `KITCHEN` on the way to the screen.
 */
const STATUS_TEXT: Record<OrderStatus, Bi> = {
  PLACED: { en: "Sent to restaurant", hi: "रेस्टोरेंट को भेजा गया" },
  KITCHEN: { en: "Preparing", hi: "बन रहा है" },
  READY: { en: "Waiting for rider", hi: "राइडर का इंतज़ार" },
  ON_THE_WAY: { en: "On the way", hi: "रास्ते में" },
  DELIVERED: { en: "Delivered", hi: "डिलीवर हो गया" },
  CANCELLED: { en: "Cancelled", hi: "रद्द" },
};

const STATUS_TONE: Record<OrderStatus, "accent" | "green" | "muted"> = {
  PLACED: "accent",
  KITCHEN: "accent",
  READY: "accent",
  ON_THE_WAY: "accent",
  DELIVERED: "green",
  CANCELLED: "muted",
};

/**
 * `en`/`hi` are for the customer app, which shows one language (pick them with
 * `pick(lang, meta)`); `label` keeps the combined "English · हिंदी" form the
 * operator screens use.
 */
export const STATUS_META = Object.fromEntries(
  (Object.keys(STATUS_TEXT) as OrderStatus[]).map((s) => [
    s,
    { ...STATUS_TEXT[s], label: HINDI_ENABLED ? `${STATUS_TEXT[s].en} · ${STATUS_TEXT[s].hi}` : STATUS_TEXT[s].en, tone: STATUS_TONE[s] },
  ])
) as Record<OrderStatus, Bi & { label: string; tone: "accent" | "green" | "muted" }>;

/**
 * The stages of an order, worded to be true at the moment each one lights up.
 *
 * This list used to run a step ahead of the database. Step one said "Order
 * confirmed — {restaurant} accepted" while the order was still `placed`, which
 * in the `order_status` enum means the exact opposite: sent, and waiting for the
 * kitchen to accept it. So the tracker congratulated the customer on an
 * acceptance that had not happened, and then — when the vendor really did accept
 * — advanced to "Prepared & packed · Handed to rider", at the precise moment
 * cooking began. Every order was described as one stage further along than it
 * was, in both directions.
 *
 * The wording deliberately matches the push notifications in
 * `notifications/order-events.ts`, so the phone and the screen tell the same
 * story, in the customer's chosen language.
 */
export function trackingSteps(
  {
    restaurantName,
    riderName,
    riderArrived = false,
  }: {
    restaurantName?: string;
    riderName?: string;
    /**
     * The rider tapped "Arrived" at the door. Changes the on-the-way line to
     * the same words as the push the customer just received.
     */
    riderArrived?: boolean;
  },
  lang: Lang = "en"
) {
  const t = translator(lang);
  return [
    {
      key: "PLACED" as const,
      title: t("Order sent", "ऑर्डर भेजा गया"),
      sub: restaurantName
        ? t(`Waiting for ${restaurantName} to accept`, `${restaurantName} के स्वीकार करने का इंतज़ार`)
        : t("Waiting for the restaurant to accept", "रेस्टोरेंट के स्वीकार करने का इंतज़ार"),
    },
    {
      key: "KITCHEN" as const,
      title: t("Accepted", "स्वीकार हुआ"),
      sub: restaurantName
        ? t(`${restaurantName} started cooking`, `${restaurantName} ने खाना बनाना शुरू किया`)
        : t("The kitchen started cooking", "किचन ने खाना बनाना शुरू किया"),
    },
    {
      key: "READY" as const,
      title: t("Packed", "पैक हो गया"),
      sub: t("Waiting for a rider to collect it", "राइडर के लेने का इंतज़ार"),
    },
    {
      key: "ON_THE_WAY" as const,
      title: t("On the way", "रास्ते में"),
      sub: riderArrived
        ? riderArrivedLine(t)
        : riderName
          ? t(`${riderName} is heading to you`, `${riderName} आपकी ओर आ रहे हैं`)
          : t("Heading to you", "आपकी ओर आ रहा है"),
    },
    {
      key: "DELIVERED" as const,
      title: t("Delivered", "डिलीवर हो गया"),
      sub: t("Handed to you at the door", "आपको दरवाज़े पर दिया गया"),
    },
  ];
}

/**
 * "Your rider has arrived" — the tracker's line once the rider taps Arrived at
 * the door, worded as the `notifyRiderArrived` push is.
 */
function riderArrivedLine(t: ReturnType<typeof translator>): string {
  return t("Your rider has arrived", "आपका राइडर पहुँच गया है");
}

/**
 * The linear flow, in database order: placed → kitchen → ready → on_the_way →
 * delivered. `READY` sits between cooking and the road, which is where the
 * enum has always put it.
 */
const ORDER: OrderStatus[] = [
  "PLACED",
  "KITCHEN",
  "READY",
  "ON_THE_WAY",
  "DELIVERED",
];

/**
 * Index of the current status within the linear tracking flow.
 *
 * `CANCELLED` is not on the line at all and lands on 0; callers must not render
 * the stepper for a cancelled order, and none do.
 */
export function statusIndex(status: OrderStatus): number {
  return Math.max(0, ORDER.indexOf(status));
}

/** Still happening: worth a live dot and a Track button rather than Reorder. */
export function isOrderInFlight(status: OrderStatus): boolean {
  return (
    status === "PLACED" ||
    status === "KITCHEN" ||
    status === "READY" ||
    status === "ON_THE_WAY"
  );
}

/**
 * Mirrors `CANCELLABLE` in `src/app/api/orders/[id]/cancel/route.ts`. Keep the
 * two in step: offering the button outside this set earns a 409 that the UI
 * reports as "the kitchen already started" — which is exactly what happened to
 * every `ready` order for as long as `ready` was displayed as `KITCHEN`. The
 * route is the authority; this only decides whether to show the button.
 */
export function canCustomerCancel(status: OrderStatus): boolean {
  return status === "PLACED" || status === "KITCHEN";
}
