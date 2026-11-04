import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { StatusText, type Tone } from "@/components/admin/console";
import type {
  SettlementListItem,
  SettlementStatus,
  VendorSettlementQueueRow,
} from "@/lib/data-access/admin-settlements";
import { formatINR } from "@/lib/utils/format";

const STATUS_TONE: Record<SettlementStatus, Tone> = {
  draft: "amber",
  paid: "green",
  void: "neutral",
};

export const STATUS_LABEL: Record<SettlementStatus, string> = {
  draft: "Not finished",
  paid: "Paid",
  void: "Cancelled",
};

/** "3 orders, waiting 7 days", the only detail a shop's line needs. */
function shopDetail(r: VendorSettlementQueueRow): string {
  if (r.orderCount === 0) return "No new orders";
  const orders = `${r.orderCount} order${r.orderCount === 1 ? "" : "s"}`;
  if (r.waitingDays <= 0) return `${orders}, from today`;
  return `${orders}, waiting ${r.waitingDays} day${r.waitingDays === 1 ? "" : "s"}`;
}

/** The one thing to chase on a shop's line, if there is one. */
function shopFlag(r: VendorSettlementQueueRow): { tone: Tone; text: string } | null {
  if (r.netPayable > 0 && !r.hasPayoutDetails) {
    return { tone: "red", text: "No bank details" };
  }
  if (r.openDrafts > 0) return { tone: "amber", text: "Payment not finished" };
  if (r.overdue && r.netPayable > 0) return { tone: "red", text: "Late" };
  return null;
}

/** One shop on the Settlements page: its name, and the amount to send it. */
export function ShopRow({ row: r }: Readonly<{ row: VendorSettlementQueueRow }>) {
  const flag = shopFlag(r);
  const owes = r.netPayable < 0;
  return (
    <li>
      <Link
        href={`/admin/settlements/orders?vendor=${r.restaurantId}&state=unpaid`}
        className="press flex min-h-16 items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-semibold text-ink">
            {r.restaurantName}
          </span>
          <span className="block truncate text-[12.5px] text-muted">
            {shopDetail(r)}
          </span>
          {flag ? (
            <span className="mt-0.5 block">
              <StatusText tone={flag.tone}>{flag.text}</StatusText>
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-right">
          <span
            className={`text-data block text-[17px] font-bold tabular-nums ${
              owes ? "text-deal" : "text-ink"
            }`}
          >
            {formatINR(Math.abs(r.netPayable))}
          </span>
          {owes ? (
            <span className="block text-[12px] font-medium text-deal">
              Owes you
            </span>
          ) : null}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted" />
      </Link>
    </li>
  );
}

/** One payment already built: who, which dates, how much, and how it ended. */
export function PaymentRow({ row: r }: Readonly<{ row: SettlementListItem }>) {
  return (
    <li>
      <Link
        href={`/admin/settlements/${r.id}`}
        className="press flex min-h-14 items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-ink">
            {r.restaurantName}
          </span>
          <span className="text-data block truncate text-[12px] text-muted">
            {r.periodLabel}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="text-data block text-[14.5px] font-bold tabular-nums text-ink">
            {formatINR(Math.abs(r.netPayable))}
          </span>
          <StatusText tone={STATUS_TONE[r.status]}>
            {STATUS_LABEL[r.status]}
          </StatusText>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted" />
      </Link>
    </li>
  );
}
