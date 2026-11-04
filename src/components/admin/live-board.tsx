import Link from "next/link";
import type { LiveBoardRow } from "@/lib/data-access/admin-dispatch";
import { ORDER_STATUS, STATUS_TONE } from "@/components/admin/order-status";
import { Empty, StatusDot } from "@/components/admin/console";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * The dashboard's live order feed: what is moving right now, worst-late first.
 * Which order, whose, what was ordered, where it is going, its value and stage.
 *
 * Its own table rather than `DataTable`: fixed columns at console density with no
 * sorting and no pagination. It scrolls sideways below its minimum instead of
 * collapsing.
 *
 * A late order is marked with a left rule and a tint. The rows are already sorted
 * worst-late-first, so the ordering carries the triage and the colour only has to
 * confirm it.
 */
export function LiveBoard({ rows }: Readonly<{ rows: LiveBoardRow[] }>) {
  if (!rows.length) {
    return (
      <Empty>
        Nothing in flight. Every order placed has been delivered or closed.
      </Empty>
    );
  }

  return (
    <div className="-mx-[var(--c-pad-x)] overflow-x-auto">
      <table className="w-full min-w-[960px] table-fixed border-collapse text-left">
        <caption className="sr-only">Orders currently in flight</caption>
        <thead>
          <tr className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">
            <Th className="w-[92px] pl-[var(--c-pad-x)]">Order</Th>
            <Th className="w-[15%]">Vendor</Th>
            <Th className="w-[13%]">Customer</Th>
            <Th>What they ordered</Th>
            <Th>Address</Th>
            <Th className="w-[84px] text-right">Value</Th>
            <Th className="w-[124px] pr-[var(--c-pad-x)]">Stage</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const late = (o.lateByMinutes ?? 0) > 0;
            const ordered = (o.items ?? []).map((i) => `${i.qty}× ${i.name}`).join(", ");
            return (
              <tr
                key={o.id ?? o.code}
                className={cn(
                  "c-rowin border-t border-[color:var(--c-divider-2)] transition-colors hover:bg-[var(--c-hover)]",
                  // `box-shadow` rather than a left border: a border would
                  // widen the first cell and knock the column out of line with
                  // its own header.
                  late && "bg-deal/[0.06] shadow-[inset_2px_0_0_0_var(--deal)]"
                )}
              >
                <td className="py-[var(--c-row-y)] pl-[var(--c-pad-x)] pr-2 align-middle">
                  {o.id ? (
                    <Link
                      href={`/admin/orders?open=${o.id}`}
                      prefetch={false}
                      className="text-data text-[11.5px] text-ink hover:text-accent-ink"
                    >
                      {o.code}
                    </Link>
                  ) : (
                    <span className="text-data text-[11.5px] text-ink">{o.code}</span>
                  )}
                </td>

                <td className="py-[var(--c-row-y)] px-2 align-middle">
                  <span className="block truncate text-[12.5px] font-medium text-ink" title={o.restaurant}>
                    {o.restaurant}
                  </span>
                </td>

                <td className="py-[var(--c-row-y)] px-2 align-middle">
                  <span className="block truncate text-[12.5px] text-ink" title={o.customer}>
                    {o.customer}
                  </span>
                </td>

                <td className="py-[var(--c-row-y)] px-2 align-middle">
                  {ordered ? (
                    <span className="line-clamp-2 text-[12px] leading-snug text-ink" title={ordered}>
                      {ordered}
                    </span>
                  ) : (
                    <span className="text-[12px] text-[color:var(--c-faint)]">—</span>
                  )}
                </td>

                <td className="py-[var(--c-row-y)] px-2 align-middle">
                  {o.address ? (
                    <span className="line-clamp-2 text-[12px] leading-snug text-muted" title={o.address}>
                      {o.address}
                    </span>
                  ) : (
                    <span className="text-[12px] text-[color:var(--c-faint)]">—</span>
                  )}
                </td>

                <td className="text-data py-[var(--c-row-y)] px-2 text-right align-middle text-[12.5px] font-medium tabular-nums text-ink">
                  {formatINR(o.total)}
                </td>

                <td className="py-[var(--c-row-y)] pl-2 pr-[var(--c-pad-x)] align-middle">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={STATUS_TONE[o.status]} />
                    <span className="text-[12px] text-ink">{ORDER_STATUS[o.status].short}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  className,
}: Readonly<{
  children: React.ReactNode;
  className?: string;
}>) {
  return (
    <th scope="col" className={cn("whitespace-nowrap px-2 pb-1.5", className)}>
      {children}
    </th>
  );
}
