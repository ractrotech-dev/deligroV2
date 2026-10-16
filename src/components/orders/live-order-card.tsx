import Link from "next/link";
import { ChevronRight, Clock } from "lucide-react";
import type { UiOrder } from "@/lib/utils/order-map";
import type { OrderEta } from "@/lib/orders/eta";
import { shortOrderId } from "@/lib/utils/order-map";
import { statusIndex, trackingSteps } from "@/lib/utils/order-status";
import { PhotoTile } from "@/components/shared/photo-tile";
import {
  CUSTOMER_LATE_CAP_MINUTES,
  formatCustomerLateness,
  formatINR,
} from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { translator, type Lang } from "@/lib/i18n/lang";

/**
 * The order that is actually happening, as the anchor of the screen.
 *
 * It used to be the same row as the seven finished ones under it, separated
 * only by an orange chevron, and the one line it was given said when the order
 * was *placed* — "Tue, 10:39 pm · Preparing". The question a customer opens
 * this tab to ask is when the food arrives, and the answer was one tap away on
 * a screen that had room to simply say it.
 *
 * The numbers come from the same `OrderEta` the tracking screen headlines, so
 * the two never disagree; `page.tsx` refreshes it every ten seconds while
 * something is in flight.
 */
export function LiveOrderCard({
  order,
  eta,
  lang,
}: Readonly<{
  order: UiOrder;
  eta?: OrderEta | null;
  /** Rendered by the server page, which reads the customer's language. */
  lang: Lang;
}>) {
  const t = translator(lang);
  const steps = trackingSteps(
    {
      restaurantName: order.restaurantName,
      riderName: order.rider?.name,
    },
    lang,
  );
  const current = statusIndex(order.status);
  const step = steps[Math.min(current, steps.length - 1)];

  /**
   * The same rule the tracking headline follows, and for the same reason: an
   * order whose shop has never been pinned has no measured distance behind its
   * estimate, only the kitchen's advertised band, and a 70 km delivery reading
   * "25 min" is worse than one that admits it doesn't know.
   */
  const unmeasured = Boolean(eta) && eta?.distanceKnown === false;
  const minutes = eta?.minutesRemaining ?? null;
  // Far past its promise, any countdown is fiction: "115 min" sat next to
  // "Delayed" on an order that had been open for 27 days. Say what we know.
  const stuck =
    Boolean(eta?.late) &&
    (eta?.lateByMinutes ?? 0) >= CUSTOMER_LATE_CAP_MINUTES;
  const headline = stuck
    ? t("Delayed", "देरी हो रही है")
    : unmeasured
      ? t("On its way", "रास्ते में है")
      : minutes !== null
        ? minutes > 0
          ? t(`${minutes} min`, `${minutes} मिनट`)
          : t("Arriving now", "बस पहुँच रहा है")
        : order.etaMinutes
          ? t(`~${order.etaMinutes} min`, `~${order.etaMinutes} मिनट`)
          : t("On its way", "रास्ते में है");
  const caption = stuck
    ? t("We're looking into this order", "हम इस ऑर्डर को देख रहे हैं")
    : unmeasured
      ? t("We can't estimate this one", "इसका समय अभी नहीं बता सकते")
      : minutes !== null || order.etaMinutes
        ? t("Estimated arrival", "पहुँचने का अनुमानित समय")
        : t("Tracking live", "लाइव ट्रैक हो रहा है");

  return (
    <Link
      href={`/orders/${order.id}`}
      className="press block overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-md)]"
    >
      <div className="flex items-center gap-3 px-4 pt-4">
        <PhotoTile
          tint={
            order.restaurantAccent ?? "linear-gradient(135deg,#34e39a,#17b26a)"
          }
          src={order.restaurantImage}
          alt={order.restaurantName}
          className="size-11 shrink-0 rounded-xl"
          sizes="44px"
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-extrabold tracking-tight">
            {order.restaurantName}
          </h3>
          {/* The code support will ask for, on the screen they will be looking
              at when they ring. */}
          <p className="text-data mt-0.5 truncate text-[11px] font-bold tracking-[0.1em] text-muted">
            {shortOrderId(order.id)} · {formatINR(order.total)}
          </p>
        </div>
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-[var(--on-accent)] shadow-[var(--glow-accent)]">
          <ChevronRight className="size-5" />
        </span>
      </div>

      <div className="flex items-end justify-between gap-3 px-4 pb-3 pt-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">{caption}</p>
          <p className="text-[30px] font-extrabold leading-none tracking-tight">
            {headline}
          </p>
        </div>
        {eta?.late && !stuck ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-deal-soft px-2.5 py-1 text-[11px] font-bold text-deal">
            <Clock className="size-3" />
            {formatCustomerLateness(eta.lateByMinutes, lang)}
          </span>
        ) : null}
      </div>

      {/* One notch per stage, the ones behind it filled. A progress bar says
          "how far along" without asking anyone to read five step titles on a
          screen they are only glancing at. */}
      <div className="px-4">
        <div className="flex gap-1">
          {steps.slice(0, -1).map((s, i) => (
            <span
              key={s.key}
              className={cn(
                "h-1 flex-1 rounded-full",
                i <= current ? "bg-green" : "bg-line",
              )}
            />
          ))}
        </div>
        <p className="flex items-center gap-1.5 py-2.5 text-[13px] font-semibold">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-green" />
          <span className="truncate">{step.title}</span>
          <span className="truncate font-normal text-muted">— {step.sub}</span>
        </p>
      </div>
    </Link>
  );
}
