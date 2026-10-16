import { Clock, EyeOff, Star, TrendingUp } from "lucide-react";
import { PhotoTile } from "@/components/shared/photo-tile";
import { formatCount, formatEta, formatRating } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { RANKING_WINDOW_DAYS, type VendorMetric } from "@/lib/vendor-ranking";
import type { FeaturedSlot, SlotVendor } from "@/lib/data-access/vendor-positions";

/**
 * A phone-width sketch of the top of the customer feed, beside the board.
 *
 * Deliberately a sketch and not the real `RestaurantCard`: that card is a Link
 * into the storefront, measures a distance from the viewer's own location and
 * quotes a delivery fee, none of which mean anything inside the console. What it
 * borrows is the part the operator is actually judging — the same PhotoTile, the
 * same order, the same name/cuisine/ETA lines — at about a third of the size.
 *
 * Two things it now shows that it used to only assert:
 *
 *   * **the fall-through.** The strip used to end at the last pinned shop under
 *     the words "everything below keeps the feed's usual order" — the one claim
 *     on the panel an operator could not check. The next few unpinned shops are
 *     drawn now, so the boundary is visible and the commonest mistake becomes
 *     obvious: spending a slot on a shop that was already going to be there.
 *   * **what each pin costs.** A slot is zero-sum, so the sales and rating of the
 *     shop occupying one belong next to it. A weak shop at #1 above a strong one
 *     at #6 is the thing this screen exists to catch, and neither name nor photo
 *     reveals it.
 */
const FALLBACK_TINT = "linear-gradient(135deg,#f6c453,#e8552d)";

export function FeedPreview({
  slots,
  metrics,
  tail,
  slotCount,
}: {
  slots: FeaturedSlot[];
  /** Sales and rating per vendor id. Empty when the numbers are unavailable. */
  metrics: Record<string, VendorMetric>;
  /** The first few unpinned shops the feed falls through to. */
  tail: SlotVendor[];
  slotCount: number;
}) {
  // One shop per slot, in rank order — exactly what applyVendorOrder floats to
  // the top of the catalogue. Collision extras stay on the board; showing two
  // shops in one position would misrepresent a feed that can only show one.
  const pinned = slots
    .map((slot) => ({ position: slot.position, vendor: slot.vendors[0] }))
    .filter((row): row is { position: number; vendor: SlotVendor } =>
      Boolean(row.vendor)
    );

  const hidden = pinned.filter((row) => !row.vendor.approved).length;

  // A pin that changes nothing: the shop sits in a slot, but it would have been
  // in the visible top of the feed anyway. Worth naming, because it is the one
  // mistake the panel can prove rather than imply.
  const wasted = pinned.filter(
    (row) => row.vendor.approved && tail.some((t) => t.id === row.vendor.id)
  ).length;

  return (
    <aside className="@4xl:sticky @4xl:top-4 @4xl:self-start">
      <div className="rounded-xl border border-line bg-surface-2 p-3">
        <div className="mb-2.5 flex items-baseline justify-between gap-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted">
            Customer feed
          </p>
          <p className="text-data text-[10.5px] tabular-nums text-muted">
            {pinned.length}/{slotCount} pinned
          </p>
        </div>

        {pinned.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center">
            <p className="text-[12px] font-semibold">Nothing pinned</p>
            <p className="mt-1 text-[11px] text-muted">
              Fill a slot and it appears here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {pinned.map(({ position, vendor }) => (
              <PreviewCard
                key={vendor.id}
                position={position}
                vendor={vendor}
                metric={metrics[vendor.id]}
              />
            ))}
          </div>
        )}

        {/* Where pinning stops mattering. Drawn as compact rows, not cards, so
            the eye reads them as a different kind of thing — the feed's own
            order, not somebody's decision. */}
        {tail.length > 0 ? (
          <div className="mt-3 border-t border-dashed border-line pt-2.5">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.07em] text-muted">
              Then, by default order
            </p>
            <div className="space-y-1.5">
              {tail.map((vendor) => (
                <TailRow
                  key={vendor.id}
                  vendor={vendor}
                  metric={metrics[vendor.id]}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-3 space-y-1.5 border-t border-[color:var(--c-divider)] pt-2.5">
          {hidden > 0 ? (
            <p className="text-[10.5px] font-semibold leading-snug text-accent-ink">
              {hidden} pinned shop{hidden === 1 ? " is" : "s are"} not approved —{" "}
              {hidden === 1
                ? "it holds a slot but never appears"
                : "they hold slots but never appear"}{" "}
              on the feed.
            </p>
          ) : null}

          {wasted > 0 ? (
            <p className="text-[10.5px] leading-snug text-muted">
              {wasted} pinned shop{wasted === 1 ? "" : "s"} would rank near the
              top anyway — {wasted === 1 ? "that slot buys" : "those slots buy"}{" "}
              little.
            </p>
          ) : null}

          {hidden === 0 && wasted === 0 ? (
            <p className="text-[10.5px] leading-snug text-muted">
              Everything below these keeps the feed&rsquo;s usual order.
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function PreviewCard({
  position,
  vendor,
  metric,
}: {
  position: number;
  vendor: SlotVendor;
  metric?: VendorMetric;
}) {
  // Two ways a pinned shop shows the customer nothing, and they are different
  // problems: unapproved means it is absent from the feed entirely; closed means
  // it is there, dimmed, wearing "Opens soon" — which is the storefront working.
  const invisible = !vendor.approved;
  const subtitle = vendor.cuisines.length
    ? vendor.cuisines.join(" · ")
    : (vendor.category ?? "Uncategorised");

  return (
    <div className={cn("relative", invisible && "opacity-45")}>
      <div className="relative overflow-hidden rounded-xl">
        <PhotoTile
          tint={vendor.accentTint ?? FALLBACK_TINT}
          src={vendor.imageUrl ?? undefined}
          alt={vendor.name}
          className="h-[74px] w-full"
        />
        <span className="text-data absolute left-1.5 top-1.5 grid size-5 place-items-center rounded-md bg-ink/85 text-[10px] font-bold tabular-nums text-white">
          {position}
        </span>
        {!vendor.isOpen && !invisible ? (
          <span className="absolute bottom-1.5 right-1.5 rounded-full bg-ink px-1.5 py-0.5 text-[9px] font-semibold text-white">
            Opens soon
          </span>
        ) : null}
      </div>

      <div className="px-0.5 pt-1.5">
        <p className="truncate text-[12px] font-extrabold leading-tight tracking-tight">
          {vendor.name}
        </p>
        <p className="truncate text-[10.5px] leading-tight text-muted">
          {subtitle}
        </p>
        <p className="mt-1 inline-flex items-center gap-1 text-[10.5px] font-medium text-muted">
          <Clock className="size-3" />
          {formatEta(vendor.etaMin, vendor.etaMax)}
        </p>
        <MetricLine metric={metric} />
      </div>

      {invisible ? (
        <p className="mt-1 inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-accent-ink">
          <EyeOff className="size-3" />
          Not approved — hidden
        </p>
      ) : null}
    </div>
  );
}

/** Compact row for a shop the feed reaches on its own, without a pin. */
function TailRow({
  vendor,
  metric,
}: {
  vendor: SlotVendor;
  metric?: VendorMetric;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-1.5 py-1.5">
      <PhotoTile
        tint={vendor.accentTint ?? FALLBACK_TINT}
        src={vendor.imageUrl ?? undefined}
        alt={vendor.name}
        className="size-7 shrink-0 rounded-md"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold leading-tight">
          {vendor.name}
        </span>
        <span className="block truncate text-[9.5px] leading-tight text-muted">
          {metric?.salesRank != null
            ? `#${metric.salesRank} by sales`
            : (vendor.category ?? "Uncategorised")}
        </span>
      </span>
    </div>
  );
}

/**
 * Sales and rating, small enough to sit under a preview card.
 *
 * Rank rather than raw figure where there is room for only one: "#2 by sales"
 * settles whether this shop deserves the slot above the next one, which is the
 * question being asked here. The raw money is on the board.
 */
function MetricLine({ metric }: { metric?: VendorMetric }) {
  if (!metric) return null;
  const rated = metric.ratingCount > 0 && metric.rating > 0;
  if (metric.orders === 0 && !rated) {
    return (
      <p className="mt-0.5 text-[9.5px] leading-tight text-muted">
        No sales or ratings yet
      </p>
    );
  }

  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9.5px] leading-tight text-muted">
      {metric.orders > 0 ? (
        <span className="inline-flex items-center gap-0.5">
          <TrendingUp className="size-2.5" />
          <span className="text-data font-bold tabular-nums text-ink">
            ₹{formatCount(metric.sales)}
          </span>
          <span>· {RANKING_WINDOW_DAYS}d</span>
          {metric.salesRank != null ? (
            <span className="text-data font-bold tabular-nums">
              · #{metric.salesRank}
            </span>
          ) : null}
        </span>
      ) : null}

      {rated ? (
        <span className="inline-flex items-center gap-0.5">
          <Star className="size-2.5 text-[var(--pop)]" />
          <span className="text-data font-semibold tabular-nums text-ink">
            {formatRating(metric.rating)}
          </span>
          <span>({formatCount(metric.ratingCount)})</span>
        </span>
      ) : null}
    </p>
  );
}
