import { requireRole } from "@/lib/auth";
import Link from "next/link";
import { EyeOff, Store } from "lucide-react";
import {
  listAssignableVendors,
  listFeedTail,
  listSlotBoard,
  vendorPositionsReady,
  SLOT_COUNT,
  type FeaturedSlot,
} from "@/lib/data-access/vendor-positions";
import { listVendorRanking } from "@/lib/data-access/admin-vendor-ranking";
import {
  AdminHero,
  EmptyState,
  LiveDot,
  PreviewNotice,
} from "@/components/admin/admin-ui";
import { ConsoleOnly } from "@/components/admin/console-only";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { cn } from "@/lib/utils/cn";
import { SlotBoard } from "./slot-board";
import { SlotRanking } from "./slot-ranking";
import { FeedPreview } from "./feed-preview";

/**
 * Admin → Vendors → Featured slots.
 *
 * The ten places at the top of the customer feed, edited as one screen. The
 * vendor table's inline Slot select answers "pin this shop while I'm looking at
 * it"; this answers the other question — "what does the top of the feed look
 * like right now, and in what order" — which a paginated, filterable table
 * cannot show, because the ten shops that matter are scattered across its pages.
 *
 * Both write through setVendorPosition, so the one-shop-per-slot rule holds
 * wherever the operator is standing.
 *
 * Live, because it is not the only way in: the vendor table pins too, and a
 * second operator can be pinning while this one arranges. A stale board here
 * costs more than on most screens — every control is "put X in slot N", so
 * acting on an out-of-date occupant silently evicts whoever really holds it.
 */
export const dynamic = "force-dynamic";

/** Matches the AutoRefresh interval below; stated in the UI, not implied. */
const REFRESH_MS = 8000;

export default async function VendorSlotsPage() {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const ready = await vendorPositionsReady();
  const [slots, vendors, ranking] = await Promise.all([
    listSlotBoard(),
    listAssignableVendors(),
    listVendorRanking(),
  ]);

  // The fall-through can only be computed once we know who is pinned, so this
  // one waits on `slots` rather than joining the batch above.
  const pinnedIds = slots.flatMap((s) => s.vendors.map((v) => v.id));
  const tail = await listFeedTail(pinnedIds, 3);

  const filled = slots.filter((s) => s.vendors.length > 0).length;
  const live = isSupabaseConfigured && ready;

  return (
    <div className="space-y-4">
      {live ? <AutoRefresh interval={REFRESH_MS} /> : null}
      <AdminHero
        backHref="/admin/vendors"
        backLabel="Vendors"
        title="Featured slots"
        tag={`${filled} of ${SLOT_COUNT} filled`}
        subtitle="The pinned shops at the top of the customer feed, in order"
        live={live}
      />

      <SlotSummary slots={slots} live={live} />

      {!ready ? (
        <PreviewNotice>
          Featured ranking needs migration 0021
          (<code>restaurants.sort_position</code>). Apply it and this board goes
          live — until then nothing is pinned and the feed keeps its default
          order.
        </PreviewNotice>
      ) : null}

      {/* The editor is console-only: ten reorder rows beside a 236px feed
          sketch, with a searchable picker modal per slot. SlotSummary above
          answers the question a phone actually asks — who is pinned, and where
          — and keeps refreshing, so the screen is still worth opening. */}
      <ConsoleOnly
        tool="Editing featured slots"
        why="The running order, above, stays live on a phone — so you can always see who is pinned where, just not move them."
      >
        {/* Board left, feed preview right — the preview is a narrow fixed column
            because it is a phone-width sketch, and it stacks under the board below
            @4xl where a 260px sidecar would squeeze the rows it explains. */}
        <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_260px] @4xl:items-start">
          <div className="min-w-0 space-y-4">
            {ready && vendors.length === 0 ? (
              <EmptyState
                icon={Store}
                title="No shops to feature"
                description="Add and approve a vendor first — then pin it to a slot here."
                action={
                  <Link href="/admin/vendors" className="c-btn c-btn-dark press">
                    Go to vendors
                  </Link>
                }
              />
            ) : (
              <>
                <SlotBoard
                  slots={slots}
                  vendors={vendors}
                  metrics={ranking.byId}
                  disabled={!ready}
                />

                {/* Under the board, not above it: the board is what the operator
                    came to edit, and the ranking is the argument for editing it
                    one way rather than another. */}
                <SlotRanking
                  rows={ranking.vendors}
                  slotCount={SLOT_COUNT}
                  truncated={ranking.truncated}
                  disabled={!ready}
                />
              </>
            )}
          </div>

          <FeedPreview
            slots={slots}
            metrics={ranking.byId}
            tail={tail}
            slotCount={SLOT_COUNT}
          />
        </div>

        <p className="text-xs text-muted">
          Slot 1 shows first. Drag a row by its handle to move a shop to another
          slot — the rows in between shift by one; the arrows step one slot at a
          time and are the keyboard and touch path, since dragging is neither.
          Unpinned shops keep the feed&rsquo;s default order below the ten. A shop
          can hold one slot at a time — pinning it somewhere else moves it rather
          than duplicating it, and dropping it on an occupied slot frees that slot
          first.
        </p>
      </ConsoleOnly>
    </div>
  );
}

/**
 * Who holds the ten slots, right now, on one line.
 *
 * The board below says the same thing, but says it in ten rows of controls — an
 * operator arriving to check "is Sharma Sweets still at #2" should not have to
 * read an editor to find out. Same `slots` data, no second source of truth: this
 * is the read, the board is the write.
 */
function SlotSummary({ slots, live }: { slots: FeaturedSlot[]; live: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-3.5 py-2.5">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.07em] text-muted">
        {live ? <LiveDot /> : null}
        In the slots now
      </span>

      <span className="flex flex-wrap items-center gap-1.5">
        {slots.map((slot) => {
          const vendor = slot.vendors[0];
          return (
            <span
              key={slot.position}
              className={cn(
                "inline-flex max-w-[180px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px]",
                vendor
                  ? "border-line font-semibold"
                  : "border-dashed border-line text-muted"
              )}
              title={
                vendor
                  ? `Slot ${slot.position}: ${vendor.name}`
                  : `Slot ${slot.position} is empty`
              }
            >
              <span className="text-data shrink-0 tabular-nums text-muted">
                {slot.position}
              </span>
              <span className="truncate">{vendor ? vendor.name : "Empty"}</span>
              {/* Occupied but invisible to customers — the one case where the
                  chip alone would mislead. The preview panel explains it. */}
              {vendor && !vendor.approved ? (
                <EyeOff className="size-3 shrink-0 text-accent-ink" />
              ) : null}
            </span>
          );
        })}
      </span>

      {live ? (
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">
          Updates every {REFRESH_MS / 1000}s
        </span>
      ) : null}
    </div>
  );
}
