import { requireRole } from "@/lib/auth";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PageHeader, StatusBadge } from "@/components/admin/console";
import { OrderSummary } from "@/components/admin/order-summary";
import { ORDER_STATUS, STATUS_TONE } from "@/components/admin/order-status";
import { formatINR, formatLateness } from "@/lib/utils/format";
import { getAdminOrderDetail } from "@/lib/data-access/admin-orders";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Order · Admin · Deligro" };

/**
 * Admin → one order, on its own page: for deep links out of alerts, the
 * dashboard and a customer's history. The body is `OrderSummary`, the same
 * component the Orders side panel shows, so the two cannot drift.
 */
export default async function AdminOrderDetailPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const { id } = await params;

  // No demo fallback: this screen is the record of what actually happened.
  if (!isSupabaseConfigured) notFound();

  const order = await getAdminOrderDetail(id);
  if (!order) notFound();

  return (
    <>
      <PageHeader
        title={`Order ${order.code}`}
        description={`Placed ${order.placedAt}`}
        back={{ href: "/admin/orders", label: "Orders" }}
        status={
          <>
            <StatusBadge tone={STATUS_TONE[order.status]}>
              {ORDER_STATUS[order.status].label}
            </StatusBadge>
            {order.lateByMinutes !== null ? (
              <StatusBadge tone="red">{formatLateness(order.lateByMinutes)}</StatusBadge>
            ) : null}
          </>
        }
        actions={
          <p className="text-data text-[24px] font-bold tracking-[-0.025em] tabular-nums">
            {formatINR(order.total)}
          </p>
        }
      />
      <div className="mt-4">
        <OrderSummary order={order} />
      </div>
    </>
  );
}
