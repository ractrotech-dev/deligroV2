"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Loader2 } from "lucide-react";
import type { Order } from "@/types";
import { useCart } from "@/stores/cart-store";
import { useUI } from "@/stores/ui-store";
import { useReorderReview } from "@/stores/reorder-review-store";
import { STATUS_META } from "@/lib/utils/order-status";
import {
  cancellationNote,
  formatOrderPlacedAt,
  isOrderPaid,
  type UiOrder,
} from "@/lib/utils/order-map";
import {
  orderLinesToCartLines,
  reconcileReorder,
  type CurrentMenuItem,
} from "@/lib/utils/cart";
import { PhotoTile } from "@/components/shared/photo-tile";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { pick, translator, type Lang } from "@/lib/i18n/lang";
import { useLang } from "@/components/providers/lang-provider";

/**
 * What was in the order, in the space of one line.
 *
 * The rows carried a restaurant, a price and a status and nothing else, which
 * for somebody who orders from the same kitchen every week is seven identical
 * lines. The items were already on the row — fetched, in memory, and never
 * shown — and they are the only thing that tells two orders apart.
 */
function orderItemsSummary(order: Order, lang: Lang = "en"): string {
  const t = translator(lang);
  const [first, ...rest] = order.lines;
  if (!first) return "";
  const head = first.qty > 1 ? `${first.qty}× ${first.name}` : first.name;
  return rest.length
    ? t(`${head} +${rest.length} more`, `${head} +${rest.length} और`)
    : head;
}

/** One finished order: what it was, when, what it cost, and how to repeat it. */
export function OrderCard({ order }: { order: UiOrder }) {
  const router = useRouter();
  const { lang, t } = useLang();
  const reorder = useCart((s) => s.reorder);
  const openCart = useUI((s) => s.openCart);
  const showReorderReview = useReorderReview((s) => s.show);
  const [reordering, setReordering] = useState(false);

  const meta = STATUS_META[order.status];
  const cancelled = order.status === "CANCELLED";
  const items = orderItemsSummary(order, lang);
  const placedAt = order.createdAt
    ? formatOrderPlacedAt(order.createdAt, lang)
    : order.placedAt;

  /**
   * Cancelled, and the money is still ours to give back.
   *
   * `payment_status` moves to `refunded` when it has actually gone back, so
   * "paid" on a cancelled order is a fact about the ledger and not a guess:
   * we are holding it. Worded as the state rather than as a promise, because a
   * request may already be in flight and "refund available" would then be
   * telling the customer to do something they have done.
   */
  const owesRefund = cancelled && isOrderPaid(order);

  /**
   * Null for a cancellation we cannot attribute — a row from before migration
   * 0051, or a database without it. Nothing is rendered in that case, because
   * the guess anybody would reach for ("the restaurant cancelled it") is an
   * accusation.
   */
  const why = cancelled ? cancellationNote(order, lang) : null;

  const handleReorder = async () => {
    const restaurant = {
      slug: order.restaurantSlug,
      name: order.restaurantName,
    };
    const lines = orderLinesToCartLines(order);
    setReordering(true);
    try {
      const res = await fetch(
        `/api/restaurants/${encodeURIComponent(restaurant.slug)}/menu-prices`,
      );
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        items?: CurrentMenuItem[];
      } | null;

      // A failed price check must not silently ship stale prices — fall back
      // to the plain reorder rather than pretend nothing could have changed.
      if (!data?.ok || !data.items) {
        reorder(restaurant, lines);
        openCart();
        return;
      }

      const diff = reconcileReorder(lines, data.items);
      if (diff.removed.length === 0 && diff.repriced.length === 0) {
        reorder(restaurant, diff.lines);
        openCart();
      } else {
        showReorderReview({ restaurant, ...diff });
      }
    } finally {
      setReordering(false);
    }
  };

  return (
    <div className="flex items-center gap-3 py-3">
      <button
        onClick={() => router.push(`/orders/${order.id}`)}
        className="press flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <PhotoTile
          tint={
            order.restaurantAccent ?? "linear-gradient(135deg,#34e39a,#17b26a)"
          }
          src={order.restaurantImage}
          alt={order.restaurantName}
          className="size-12 shrink-0 rounded-xl"
          sizes="48px"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="line-clamp-2 text-[15px] font-extrabold leading-snug tracking-tight">
              {order.restaurantName}
            </h3>
            <span className="text-data shrink-0 font-bold">
              {formatINR(order.total)}
            </span>
          </div>
          {items ? (
            <p className="mt-0.5 line-clamp-2 text-[13px] text-ink/75">
              {items}
            </p>
          ) : null}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 truncate text-[12px] text-muted">
            <span
              className={cn(
                "font-semibold",
                cancelled ? "text-deal" : "text-green",
              )}
            >
              {pick(lang, meta)}
            </span>
            <span aria-hidden>·</span>
            <span>{placedAt}</span>
            {owesRefund ? (
              <>
                <span aria-hidden>·</span>
                <span className="font-semibold text-pop">
                  {t("Refund not issued", "रिफ़ंड अभी नहीं हुआ")}
                </span>
              </>
            ) : null}
          </p>
          {why ? (
            <p className="mt-1 truncate text-[12px] leading-snug text-muted">
              {why.reason ? `“${why.reason}”` : why.who}
            </p>
          ) : null}
        </div>
      </button>

      {/* Labelled, not a bare glyph. "Order it again" is the single most
          repeated thing anyone does on this screen and it was an unnamed circle
          that also happens to replace whatever is in the basket. */}
      <button
        onClick={handleReorder}
        disabled={reordering}
        className="press flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] font-bold text-ink disabled:opacity-60"
      >
        {reordering ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <RotateCcw className="size-4" />
        )}
        {t("Again", "फिर से")}
      </button>
    </div>
  );
}
