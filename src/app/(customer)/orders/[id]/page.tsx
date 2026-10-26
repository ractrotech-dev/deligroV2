import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ACTIVE_ORDER, PAST_ORDERS } from "@/lib/data";
import { getOrderForTracking } from "@/lib/orders-ui";
import { getOrderEta } from "@/lib/data-access/order-tracking";
import { TrackingView } from "@/components/orders/tracking-view";
import { isSupabaseConfigured } from "@/lib/supabase/config";

const MOCK_ORDERS = [ACTIVE_ORDER, ...PAST_ORDERS];

export function generateStaticParams() {
  if (isSupabaseConfigured) return [];
  return MOCK_ORDERS.map((o) => ({ id: o.id }));
}

export default async function OrderTrackingPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;

  // Fetched alongside the order rather than after it, so the honest ETA costs
  // no extra round trip. `getOrderEta` is RLS-scoped and returns null for an
  // order this caller may not see, which is the same answer it gives for one
  // that doesn't exist — but the order read below is what actually decides
  // whether this page is a 404.
  // `getOrderForTracking` now throws `OrderReadFailed` rather than returning
  // null when the read itself fails. That distinction is the whole point: null
  // means RLS says there is no such order for you, which IS a 404, while a
  // backend fault used to 404 a real order the customer was waiting on. Letting
  // it throw hands the case to the route's error boundary — an "something went
  // wrong, retry" screen — instead of asserting the order does not exist.
  const [order, initialEta] = await Promise.all([
    getOrderForTracking(id),
    isSupabaseConfigured
      ? getOrderEta(id).catch(() => null)
      : Promise.resolve(null),
  ]);
  if (!order) notFound();

  return (
    <Suspense>
      <TrackingView
        order={order}
        initialEta={initialEta}
      />
    </Suspense>
  );
}
