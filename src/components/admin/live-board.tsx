import Link from "next/link";
import type { LiveBoardRow } from "@/lib/data-access/admin-dispatch";
import { ORDER_STATUS, STATUS_TONE } from "@/components/admin/order-status";
import { Empty, StatusDot } from "@/components/admin/console";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * The dashboard's live order feed: what is moving right now, worst-late first.
 *
 * Its own table rather than `DataTable` — this is seven fixed columns at
 * console density with no sorting, no card fallback and no pagination, and
 * bending the general list primitive into that shape would cost more than the
 * fifty lines it saves. It scrolls sideways below its minimum instead of
 * collapsing: a rider's name truncated to "R…" is not a smaller version of the
 * information, it is the absence of it.
 *
 * ## How lateness is shown
 *
 * A left rule and a red figure in the "Late" column, not a red row. One tinted
 * row among eight is a signal; eight tinted rows on a bad evening are a wall,
 * and a wall tells an operator nothing about which order to ring about first.
 * The rows are already sorted worst-late-first, so the ordering carries the
 * triage and the colour only has to confirm it.
 *
 * ## Placed at
 *
 * The clock time, not "8 minutes ago". An operator reading this has a customer
 * on the phone saying "I ordered at about quarter to eight", and matching that
 * against a relative age is arithmetic they should not have to do. Lateness —
 * where elapsed time is the whole point — is the column that states a duration.
 */
export function LiveBoard({ rows }: { rows: LiveBoardRow[] }) {
  if (!rows.length) {
    return (
      <Empty>
        Nothing in flight. Every order placed has been delivered or closed.
      </Empty>
    );
  }

  return (
    <div className="-mx-[var(--c-pad-x)] overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <caption className="sr-only">Orders currently in flight</caption>
        <thead>
          <tr className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">
            <Th className="w-[88px] pl-[var(--c-pad-x)]">Order</Th>
            <Th>Vendor</Th>
            <Th className="w-[132px]">Customer</Th>
            <Th className="w-[112px]">Stage</Th>
            <Th className="w-[104px]">Rider</Th>
            <Th className="w-[80px] text-right">Value</Th>
            <Th className="w-[68px] text-right">Placed</Th>
            <Th className="w-[64px] pr-[var(--c-pad-x)] text-right">Late</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const late = (o.lateByMinutes ?? 0) > 0;
            const stage = ORDER_STATUS[o.status];
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
                      href={`/admin/orders/${o.id}`}
                      className="text-data press text-[11.5px] text-ink hover:text-accent-ink"
                    >
                      {o.code}
                    </Link>
                  ) : (
                    <span className="text-data text-[11.5px] text-ink">
                      {o.code}
                    </span>
                  )}
                </td>

                <td className="min-w-0 py-[var(--c-row-y)] pr-2 align-middle">
                  <span className="block truncate text-[12.5px] font-medium text-ink">
                    {o.restaurant}
                  </span>
                </td>

                <td className="min-w-0 py-[var(--c-row-y)] pr-2 align-middle">
                  <span className="block truncate text-[12px] text-muted">
                    {o.customer}
                  </span>
                </td>

                <td className="py-[var(--c-row-y)] pr-2 align-middle">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={STATUS_TONE[o.status]} />
                    <span className="text-[12px] text-ink">{stage.short}</span>
                  </span>
                </td>

                <td className="py-[var(--c-row-y)] pr-2 align-middle">
                  <span
                    className={cn(
                      "block truncate text-[12px]",
                      o.rider ? "text-ink" : "text-[color:var(--c-ink-amber)]"
                    )}
                  >
                    {o.rider ?? "Unassigned"}
                  </span>
                </td>

                <td className="text-data py-[var(--c-row-y)] pr-2 text-right align-middle text-[12.5px] font-medium tabular-nums text-ink">
                  {formatINR(o.total)}
                </td>

                <td className="text-data py-[var(--c-row-y)] pr-2 text-right align-middle text-[11.5px] tabular-nums text-muted">
                  {clockTime(o.placedAt)}
                </td>

                <td
                  className={cn(
                    "text-data py-[var(--c-row-y)] pr-[var(--c-pad-x)] text-right align-middle text-[12.5px] font-semibold tabular-nums",
                    late ? "text-deal" : "text-[color:var(--c-faint)]"
                  )}
                >
                  {late ? `${o.lateByMinutes}m` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The time out of "24 Jul, 8:24 PM".
 *
 * `placedAt` is already localised for display and explicitly documented as not
 * parseable (see `AdminOrderRow`), so this takes the part after the comma
 * rather than trying to reconstruct a Date from it. Anything that does not look
 * like that shape is passed through untouched — a wrong time is worse than a
 * long one.
 */
function clockTime(placedAt: string): string {
  const comma = placedAt.indexOf(",");
  return comma === -1 ? placedAt : placedAt.slice(comma + 1).trim();
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th scope="col" className={cn("whitespace-nowrap px-2 pb-1.5", className)}>
      {children}
    </th>
  );
}
