import { requireRole } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ReceiptText } from "lucide-react";
import { AdminHero, Panel, EmptyState } from "@/components/admin/admin-ui";
import { Figure, FigureRow } from "@/components/admin/console";
import { ORDER_STATUS } from "@/components/admin/order-status";
import { formatINR } from "@/lib/utils/format";
import { getCustomerDetail } from "@/lib/data-access/admin-customers";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { AccountActions } from "./account-actions";

export const metadata: Metadata = { title: "Customer · Admin · Deligro" };

export default async function AdminCustomerDetailPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const { id } = await params;

  // Same reasoning as the order detail screen: there is no honest demo version
  // of one real person's order history.
  if (!isSupabaseConfigured) notFound();

  const customer = await getCustomerDetail(id);
  if (!customer) notFound();

  return (
    <div className="admin-measure space-y-4">
      <AdminHero
        title={customer.name}
        tag={`${customer.orderCount} order${customer.orderCount === 1 ? "" : "s"}`}
        subtitle={`Joined ${customer.joinedAt}`}
        backHref="/admin/customers"
        backLabel="Customers"
        action={
          customer.phone ? (
            <a
              href={`tel:${customer.phone}`}
              className="text-data text-sm font-semibold text-ink hover:underline"
            >
              {customer.phone}
            </a>
          ) : undefined
        }
      />

      <Panel>
        <p className="text-sm text-ink">
          Account: <span className="font-semibold">{customer.accountStatus}</span>
          {customer.statusReason && customer.accountStatus !== "active" ? (
            <span className="text-muted"> — {customer.statusReason}</span>
          ) : null}
        </p>
        <div className="mt-2">
          <AccountActions id={customer.id} status={customer.accountStatus} />
        </div>
      </Panel>

      <FigureRow>
        <Figure
          label="Orders"
          value={customer.orderCount}
          note="Placed on this account"
        />
        <Figure
          label="Delivered"
          value={customer.deliveredCount}
          note={`${customer.orderCount - customer.deliveredCount} did not complete`}
        />
        <Figure
          label="Lifetime spend"
          value={formatINR(customer.lifetimeSpend)}
          note="Delivered orders only"
        />
        <Figure
          label="Saved addresses"
          // Null is "could not read", which is not zero — see getCustomerDetail.
          value={customer.savedAddresses ?? "—"}
          note={
            customer.savedAddresses === null
              ? "Could not be read"
              : "On file for delivery"
          }
        />
      </FigureRow>

      <Panel
        title="Order history"
        subtitle={
          customer.orderCount > customer.orders.length
            ? `Showing the ${customer.orders.length} most recent of ${customer.orderCount}`
            : undefined
        }
      >
        {customer.orders.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title="No orders yet"
            description="This customer has an account but has never checked out."
          />
        ) : (
          <ul>
            {customer.orders.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/admin/orders/${o.id}`}
                  className="press flex items-center gap-3 border-b border-[color:var(--c-divider)] py-2.5 transition-colors last:border-b-0 hover:bg-[var(--c-hover)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-data block text-xs text-ink">
                      {o.code}
                    </span>
                    <span className="block truncate text-[12.5px] text-ink">
                      {o.restaurant}
                    </span>
                    <span className="block truncate text-[11.5px] text-muted">
                      {o.placedAt}
                    </span>
                  </span>
                  <span className={`pill shrink-0 ${ORDER_STATUS[o.status].cls}`}>
                    {ORDER_STATUS[o.status].short}
                  </span>
                  <span className="text-data w-[80px] shrink-0 text-right text-[13px] font-semibold tabular-nums">
                    {formatINR(o.total)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
