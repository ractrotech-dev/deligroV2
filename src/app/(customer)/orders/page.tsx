import Link from "next/link";
import { ReceiptText, TriangleAlert } from "lucide-react";
import { LiveOrderCard } from "@/components/orders/live-order-card";
import { OrderHistory } from "@/components/orders/order-history";
import { EmptyState } from "@/components/shared/empty-state";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { PullToRefresh } from "@/components/shared/pull-to-refresh";
import { Button } from "@/components/ui/button";
import { getOrdersPageData } from "@/lib/orders-ui";
import { getOrderEta } from "@/lib/data-access/order-tracking";
import { requireUser } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getLang } from "@/lib/i18n/server";
import { translator } from "@/lib/i18n/lang";

/**
 * Slower than the 3s poll on /orders/[id]. That screen is someone watching their
 * food arrive; this is a list they glance at. Ten seconds is enough that the
 * status here never visibly disagrees with the tracking screen, which was the
 * actual complaint — the same order showing two different states on two screens
 * reads as a bug, not as a design choice.
 */
const REFRESH_MS = 10_000;

export default async function OrdersPage() {
  // Order history is per-account — guests are bounced to /login by the proxy;
  // this backstops it server-side.
  await requireUser();
  const lang = await getLang();
  const t = translator(lang);
  const { active, past, ok, hasMore } = await getOrdersPageData();
  const hasOrders = Boolean(active) || past.length > 0;

  /**
   * The live card headlines an arrival time, so it needs the same estimate the
   * tracking screen does. One extra read, only when something is in flight, on
   * the screen whose entire reason to exist at that moment is that order — and
   * never fatal: a failed ETA drops the number, not the card.
   */
  const eta =
    active && isSupabaseConfigured
      ? await getOrderEta(active.id).catch(() => null)
      : null;

  return (
    <>
      {/* The timer only runs while something is actually in flight: a page of
          delivered orders has nothing to poll for and polling it would be pure
          cost. Interval 0 keeps the catch-up on focus, which is what makes
          coming back to the tab show current data either way — and the pull
          gesture is how somebody asks in between. */}
      {isSupabaseConfigured ? (
        <AutoRefresh interval={active ? REFRESH_MS : 0} />
      ) : null}
      <PullToRefresh />

      <div className="glass sticky top-0 z-20 px-4 pb-3 pt-5">
        <h1 className="text-[23px] font-extrabold tracking-tight">
          {t("Orders", "ऑर्डर")}
        </h1>
      </div>

      {hasOrders && (
        <div className="space-y-5 px-4 pt-2">
          {active ? (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-bold uppercase tracking-[0.06em] text-muted">
                <span className="size-1.5 animate-pulse rounded-full bg-green" />
                {t("Happening now", "अभी चल रहा है")}
              </h2>
              <LiveOrderCard order={active} eta={eta} lang={lang} />
            </section>
          ) : null}

          {past.length > 0 ? (
            <OrderHistory orders={past} hasMore={hasMore} />
          ) : null}
        </div>
      )}
      {!hasOrders && !ok && (
        /* The read failed. Telling someone with food on its way that they have
           never ordered is the worst thing this screen can say, and it is
           exactly what an empty state asserts. */
        <EmptyState
          className="mt-12"
          icon={<TriangleAlert className="size-7" />}
          tone="violet"
          title={t("Couldn't load your orders", "आपके ऑर्डर लोड नहीं हो पाए")}
          description={t(
            "This is a problem on our side, not a sign that anything is missing. Your orders are safe — try again in a moment.",
            "यह हमारी तरफ़ की दिक्कत है, कुछ भी गायब नहीं हुआ है। आपके ऑर्डर सुरक्षित हैं — थोड़ी देर में फिर कोशिश करें।",
          )}
          action={
            <Link href="/orders">
              <Button>{t("Try again", "फिर कोशिश करें")}</Button>
            </Link>
          }
        />
      )}
      {!hasOrders && ok && (
        <EmptyState
          className="mt-12"
          icon={<ReceiptText className="size-7" />}
          tone="violet"
          title={t("No orders yet", "अभी तक कोई ऑर्डर नहीं")}
          description={t(
            "Your orders will appear here — track live and reorder in a tap.",
            "आपके ऑर्डर यहाँ दिखेंगे — लाइव ट्रैक करें और एक टैप में दोबारा मँगाएँ।",
          )}
          action={
            <Link href="/">
              <Button>
                {t("Find something to eat", "कुछ खाने को ढूँढें")}
              </Button>
            </Link>
          }
        />
      )}
    </>
  );
}
