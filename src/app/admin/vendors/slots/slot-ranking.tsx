"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Star, TrendingUp, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatCount, formatINR, formatRating } from "@/lib/utils/format";
import {
  ineligibleReason,
  MIN_RATINGS_TO_RANK,
  qualifiesFor,
  RANKING_WINDOW_DAYS,
  rankOn,
  type RankBasis,
  type VendorRankRow,
} from "@/lib/vendor-ranking";
import { autoFillVendorSlotsAction } from "../actions";

/**
 * The league table behind the board: who is actually selling, who is actually
 * rated, and one button to make the slots agree with it.
 *
 * The slots board answers "what is pinned"; this answers "what should be". They
 * are deliberately separate panels — an operator arranging the feed by hand
 * should be able to see the ranking they are overriding, and see that they are
 * overriding it.
 *
 * Auto-fill is destructive (it clears the board first, collisions included), so
 * it confirms, and it reports how many slots it actually filled — a quiet month
 * yields fewer than ten and saying "done" would imply otherwise.
 */

/** How many rows the table shows. Deep enough to see who just missed the cut. */
const VISIBLE_ROWS = 12;

const BASIS_COPY: Record<
  RankBasis,
  { label: string; short: string; icon: typeof TrendingUp; caption: string }
> = {
  sales: {
    label: "By sales",
    short: "sales",
    icon: TrendingUp,
    caption: `Gross value of delivered orders in the last ${RANKING_WINDOW_DAYS} days. Cancelled orders don't count.`,
  },
  rating: {
    label: "By rating",
    short: "rating",
    icon: Star,
    caption: `The rating on the customer's card. Shops with fewer than ${MIN_RATINGS_TO_RANK} ratings aren't ranked — too thin to be an opinion.`,
  },
};

export function SlotRanking({
  rows,
  slotCount,
  truncated,
  disabled,
}: {
  rows: VendorRankRow[];
  slotCount: number;
  /** The order scan hit its cap, so the sums are partial. */
  truncated: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [basis, setBasis] = useState<RankBasis>("sales");

  const copy = BASIS_COPY[basis];

  /**
   * Ranked shops first, in rank order; then the ones that don't qualify, so the
   * table shows the cut-off rather than pretending nothing sits below it.
   */
  const ordered = useMemo(() => {
    const qualified = rows
      .filter((r) => qualifiesFor(r, basis))
      .sort((a, b) => rankOn(a, basis) - rankOn(b, basis));
    const rest = rows
      .filter((r) => !qualifiesFor(r, basis))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...qualified, ...rest];
  }, [rows, basis]);

  /**
   * Exactly what an auto-fill would pin, mirroring `pickSlotOrder` on the server
   * — which is why the qualify/rank rules live in the shared module rather than
   * being re-expressed here.
   *
   * Membership, not a row index, decides the cut marker: a shop can rank second
   * by sales and still be unfillable (unapproved, suspended), so counting rows
   * from the top would draw the line in the wrong place.
   */
  const picked = useMemo(() => {
    const list = rows
      .filter((r) => r.eligible && qualifiesFor(r, basis))
      .sort((a, b) => rankOn(a, basis) - rankOn(b, basis))
      .slice(0, slotCount);
    return {
      ids: new Set(list.map((r) => r.id)),
      lastId: list.at(-1)?.id ?? null,
      count: list.length,
    };
  }, [rows, basis, slotCount]);

  const willFill = picked.count;
  const busy = pending || Boolean(disabled);

  const autoFill = () => {
    const confirmed = window.confirm(
      `Replace all ${slotCount} featured slots with the top ${willFill} ${copy.short === "sales" ? "sellers" : "rated shops"}?\n\n` +
        "Everything currently pinned is cleared first, so any hand-made arrangement is lost."
    );
    if (!confirmed) return;

    start(async () => {
      const res = await autoFillVendorSlotsAction(basis);
      if (!res.ok) {
        window.alert(res.error ?? "That didn't go through. Try again.");
      } else {
        const filled = res.filled ?? 0;
        const slots = res.slots ?? slotCount;
        if (filled < slots) {
          window.alert(
            `Filled ${filled} of ${slots} slots — only ${filled} shop${filled === 1 ? "" : "s"} qualified by ${copy.short}. The rest are empty and the feed falls through to its default order there.`
          );
        }
      }
      router.refresh();
    });
  };

  return (
    <section
      className={cn("vendor-panel transition-opacity", pending && "opacity-70")}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold">Who earns a slot</h2>
          <p className="mt-0.5 text-xs text-muted">{copy.caption}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <div
            role="tablist"
            aria-label="Rank shops by"
            className="flex rounded-lg border border-line p-0.5"
          >
            {(Object.keys(BASIS_COPY) as RankBasis[]).map((key) => {
              const Icon = BASIS_COPY[key].icon;
              const on = key === basis;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  disabled={pending}
                  onClick={() => setBasis(key)}
                  className={cn(
                    "press inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors disabled:opacity-50",
                    on
                      ? "bg-accent text-[var(--on-accent)]"
                      : "text-muted hover:text-ink"
                  )}
                >
                  <Icon className="size-3.5" />
                  {BASIS_COPY[key].label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={autoFill}
            disabled={busy || willFill === 0}
            title={
              willFill === 0
                ? `No shop qualifies by ${copy.short} yet`
                : `Pin the top ${willFill} by ${copy.short} to slots 1–${willFill}`
            }
            className="c-btn c-btn-dark press inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Wand2 className="size-3.5" />
            Fill slots by {copy.short}
          </button>
        </div>
      </div>

      {truncated ? (
        <p className="mb-2.5 rounded-lg bg-accent-soft px-2.5 py-1.5 text-[11.5px] text-accent-ink">
          Sales are summed over the most recent orders only — the window holds
          more than this screen reads, so treat the totals as a floor.
        </p>
      ) : null}

      {ordered.length === 0 ? (
        <p className="px-1 py-6 text-center text-[12.5px] text-muted">
          No shops in the catalogue yet.
        </p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-[0.07em] text-muted">
                <th className="px-1 pb-2 font-bold">#</th>
                <th className="px-1 pb-2 font-bold">Shop</th>
                <th className="px-1 pb-2 text-right font-bold">
                  Sales · {RANKING_WINDOW_DAYS}d
                </th>
                <th className="px-1 pb-2 text-right font-bold">Orders</th>
                <th className="px-1 pb-2 text-right font-bold">Rating</th>
                <th className="px-1 pb-2 text-right font-bold">Slot</th>
              </tr>
            </thead>
            <tbody>
              {ordered.slice(0, VISIBLE_ROWS).map((row, index) => (
                <RankingRow
                  key={row.id}
                  row={row}
                  basis={basis}
                  wouldPin={picked.ids.has(row.id)}
                  // The line the auto-fill would cut at — drawn under the last
                  // shop it would actually pin, unless that shop is the last
                  // visible row anyway, where a rule reads as a table border.
                  cutHere={
                    row.id === picked.lastId &&
                    index < Math.min(VISIBLE_ROWS, ordered.length) - 1
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ordered.length > VISIBLE_ROWS ? (
        <p className="mt-2.5 text-[11px] text-muted">
          Showing the top {VISIBLE_ROWS} of {ordered.length} shops.
        </p>
      ) : null}
    </section>
  );
}

function RankingRow({
  row,
  basis,
  wouldPin,
  cutHere,
}: {
  row: VendorRankRow;
  basis: RankBasis;
  /** An auto-fill on this basis would pin this shop. */
  wouldPin: boolean;
  cutHere: boolean;
}) {
  const blocked = ineligibleReason(row);
  const rank = basis === "sales" ? row.salesRank : row.ratingRank;
  const rated = row.ratingCount > 0 && row.rating > 0;

  return (
    <tr
      className={cn(
        "border-t border-[color:var(--c-divider)]",
        // The auto-fill boundary, drawn where it actually falls. Ten rows of
        // numbers do not tell an operator which of them would be pinned.
        cutHere && "border-b-2 border-b-accent",
        blocked && "opacity-55"
      )}
    >
      <td className="px-1 py-2 align-top">
        <span
          className={cn(
            "text-data grid size-6 place-items-center rounded-md text-[11px] font-bold tabular-nums",
            wouldPin
              ? "bg-accent text-[var(--on-accent)]"
              : "bg-surface-2 text-muted"
          )}
        >
          {rank ?? "—"}
        </span>
      </td>

      <td className="px-1 py-2 align-top">
        <span className="block truncate font-semibold">{row.name}</span>
        <span className="block truncate text-[11px] text-muted">
          {row.category ?? "Uncategorised"} · /{row.slug}
        </span>
        {blocked ? (
          <span className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-semibold text-accent-ink">
            <Ban className="size-3" />
            {blocked}
          </span>
        ) : null}
      </td>

      <td className="text-data px-1 py-2 text-right align-top tabular-nums">
        {row.orders > 0 ? (
          <span className="font-bold">{formatINR(row.sales)}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>

      <td className="text-data px-1 py-2 text-right align-top tabular-nums text-muted">
        {row.orders > 0 ? formatCount(row.orders) : "—"}
      </td>

      <td className="px-1 py-2 text-right align-top">
        {rated ? (
          <span className="inline-flex items-center justify-end gap-1">
            <Star className="size-3 text-[var(--pop)]" />
            <span className="text-data font-semibold tabular-nums">
              {formatRating(row.rating)}
            </span>
            <span className="text-[10.5px] text-muted">
              ({formatCount(row.ratingCount)})
            </span>
          </span>
        ) : (
          <span className="text-[11px] text-muted">Unrated</span>
        )}
      </td>

      <td className="px-1 py-2 text-right align-top">
        {row.position != null ? (
          <span className="text-data rounded-full bg-accent-soft px-1.5 text-[10.5px] font-bold tabular-nums text-accent-ink">
            #{row.position}
          </span>
        ) : (
          <span className="text-[11px] text-muted">—</span>
        )}
      </td>
    </tr>
  );
}
