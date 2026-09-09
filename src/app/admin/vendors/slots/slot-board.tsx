"use client";

import { useRef, useState, useTransition } from "react";
import { StatusText, type Tone } from "@/components/admin/console";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, GripVertical, Star, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatCount, formatINR, formatRating } from "@/lib/utils/format";
import { RANKING_WINDOW_DAYS, type VendorMetric } from "@/lib/vendor-ranking";
import type {
  AssignableVendor,
  FeaturedSlot,
  SlotVendor,
} from "@/lib/data-access/vendor-positions";
import {
  assignVendorSlotAction,
  moveVendorSlotAction,
  swapVendorSlotsAction,
  setVendorPositionAction,
} from "../actions";
import { SlotVendorPicker } from "./slot-vendor-picker";

/**
 * The ten featured slots, rank order, one row each.
 *
 * A slot is a place on the customer feed, so an empty one is still a row — the
 * operator's job here is "fill #3", and a list that only showed occupied slots
 * would hide the very thing they came to do.
 *
 * Three ways to reorder, because they suit three different intents:
 *
 *   * drag a row by its handle — "this shop belongs at the top", the whole reason
 *     a ranked list wants direct manipulation. A move, not a swap: the rows
 *     between shift by one, which is what dropping a row on a list means.
 *   * the up/down arrows — one step at a time, and the keyboard and touch path,
 *     since HTML5 drag-and-drop offers neither.
 *   * the picker — "put this named shop here", when the operator knows the shop
 *     and not its current position.
 *
 * Every control is one server round-trip followed by router.refresh(): the
 * actions revalidate this page and the customer feed, so the board redraws from
 * the database rather than from optimistic local state that could disagree with
 * the eviction rule the server applies.
 */

const STATUS_TONE: Record<string, Tone> = {
  active: "green",
  pending: "amber",
  inactive: "neutral",
  suspended: "red",
};

export function SlotBoard({
  slots,
  vendors,
  metrics,
  disabled,
}: {
  slots: FeaturedSlot[];
  vendors: AssignableVendor[];
  /** Sales and rating per vendor id. Empty when the numbers are unavailable. */
  metrics: Record<string, VendorMetric>;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  /** The slot being dragged, and the slot the pointer is currently over. */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    start(async () => {
      const res = await fn();
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });
  };

  const busy = pending || Boolean(disabled);

  const endDrag = () => {
    setDragFrom(null);
    setDragOver(null);
  };

  const drop = (to: number) => {
    const from = dragFrom;
    endDrag();
    if (from == null || from === to) return;
    run(() => moveVendorSlotAction(from, to));
  };

  return (
    // No `overflow-hidden` despite the rounded corners: it would clip each
    // row's search panel. Nothing inside paints to the edge, so the corners
    // stay clean without it.
    <ul
      className={cn(
        "rounded-xl border border-line bg-surface transition-opacity",
        pending && "opacity-70"
      )}
    >
      {slots.map((slot, index) => (
        <SlotRow
          key={slot.position}
          slot={slot}
          index={index}
          total={slots.length}
          vendors={vendors}
          metrics={metrics}
          busy={busy}
          dragFrom={dragFrom}
          dragOver={dragOver}
          onDragBegin={setDragFrom}
          onDragEnter={setDragOver}
          onDragLeave={() =>
            setDragOver((current) =>
              current === slot.position ? null : current
            )
          }
          onDrop={drop}
          onDragFinish={endDrag}
          run={run}
        />
      ))}
    </ul>
  );
}

function SlotRow({
  slot,
  index,
  total,
  vendors,
  metrics,
  busy,
  dragFrom,
  dragOver,
  onDragBegin,
  onDragEnter,
  onDragLeave,
  onDrop,
  onDragFinish,
  run,
}: {
  slot: FeaturedSlot;
  index: number;
  total: number;
  vendors: AssignableVendor[];
  metrics: Record<string, VendorMetric>;
  busy: boolean;
  dragFrom: number | null;
  dragOver: number | null;
  onDragBegin: (position: number) => void;
  onDragEnter: (position: number) => void;
  onDragLeave: () => void;
  onDrop: (position: number) => void;
  onDragFinish: () => void;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const [occupant, ...extras] = slot.vendors;

  // Only an occupied row has something to drag. An empty slot is a destination,
  // not a passenger.
  const canDrag = Boolean(occupant) && !busy;
  const isSource = dragFrom === slot.position;
  const isTarget = dragOver === slot.position && dragFrom != null && !isSource;

  return (
    <li
      ref={rowRef}
      // The row is the drop target but NOT the drag source — the handle is.
      // Putting `draggable` on the row would make the browser treat a
      // click-and-drag inside the picker's search box as a row drag, so
      // selecting text in it would fling the shop to another slot.
      onDragOver={(e) => {
        if (dragFrom == null) return;
        // Without preventDefault the browser refuses the drop entirely.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragOver !== slot.position) onDragEnter(slot.position);
      }}
      onDragLeave={(e) => {
        // Moving between a row's own children fires dragleave on the row; only
        // clear when the pointer has actually left it.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        onDragLeave();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(slot.position);
      }}
      className={cn(
        "relative border-b border-[color:var(--c-divider)] transition-colors last:border-b-0",
        isSource && "opacity-40",
        isTarget && "bg-accent-soft"
      )}
    >
      {/* The insertion cue. A ring on the target row rather than a line between
          rows, because the drop means "become slot N" — the row the pointer is
          on is exactly what the shop is about to become. */}
      {isTarget ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[10px] ring-2 ring-inset ring-accent"
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span
          draggable={canDrag}
          onDragStart={(e) => {
            if (!canDrag) return;
            onDragBegin(slot.position);
            e.dataTransfer.effectAllowed = "move";
            // Some browsers refuse to start a drag with no payload, and the
            // position is the only thing worth carrying.
            e.dataTransfer.setData("text/plain", String(slot.position));
            // Ghost the whole row, not the 16px grip the pointer is actually on.
            if (rowRef.current) {
              e.dataTransfer.setDragImage(rowRef.current, 24, 24);
            }
          }}
          onDragEnd={onDragFinish}
          aria-hidden
          title={canDrag ? `Drag slot ${slot.position} to reorder` : undefined}
          className={cn(
            "-ml-1 shrink-0 text-muted transition-colors",
            canDrag
              ? "cursor-grab hover:text-ink active:cursor-grabbing"
              : "opacity-25"
          )}
        >
          <GripVertical className="size-4" />
        </span>

        <RankBadge position={slot.position} filled={Boolean(occupant)} />

        {occupant ? (
          <Occupant vendor={occupant} metric={metrics[occupant.id]} />
        ) : (
          <p className="min-w-0 flex-1 text-[13px] text-muted">
            {dragFrom != null
              ? "Drop here to move the shop into this slot."
              : "Empty — the feed falls through to its default order here."}
          </p>
        )}

        <div className="flex shrink-0 items-center gap-1.5">
          <SlotVendorPicker
            position={slot.position}
            currentId={occupant?.id ?? null}
            currentName={occupant?.name ?? null}
            vendors={vendors}
            disabled={busy}
            onPick={(vendorId) =>
              run(() => assignVendorSlotAction(slot.position, vendorId))
            }
          />

          <IconButton
            label={`Move slot ${slot.position} up`}
            disabled={busy || index === 0}
            onClick={() =>
              run(() => swapVendorSlotsAction(slot.position, slot.position - 1))
            }
          >
            <ArrowUp className="size-4" />
          </IconButton>

          <IconButton
            label={`Move slot ${slot.position} down`}
            disabled={busy || index === total - 1}
            onClick={() =>
              run(() => swapVendorSlotsAction(slot.position, slot.position + 1))
            }
          >
            <ArrowDown className="size-4" />
          </IconButton>

          <IconButton
            label={`Clear slot ${slot.position}`}
            disabled={busy || !occupant}
            onClick={() => run(() => assignVendorSlotAction(slot.position, null))}
          >
            <X className="size-4" />
          </IconButton>
        </div>
      </div>

      {/* Legacy collisions: two shops on one slot, from before pinning became
          exclusive. Shown, not hidden, with a one-click unpin. */}
      {extras.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-[color:var(--c-divider)] px-4 py-2">
          <p className="text-[11.5px] font-semibold text-accent-ink">
            Also pinned to #{slot.position}:
          </p>
          {extras.map((v) => (
            <span
              key={v.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11.5px]"
            >
              {v.name}
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => setVendorPositionAction(v.id, null))}
                className="press text-muted hover:text-ink disabled:opacity-50"
                aria-label={`Unpin ${v.name}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function RankBadge({
  position,
  filled,
}: {
  position: number;
  filled: boolean;
}) {
  return (
    <span
      className={cn(
        "text-data grid size-9 shrink-0 place-items-center rounded-xl text-[13px] font-bold tabular-nums",
        filled
          ? "bg-accent text-[var(--on-accent)]"
          : "border border-dashed border-line text-muted"
      )}
    >
      {position}
    </span>
  );
}

function Occupant({
  vendor,
  metric,
}: {
  vendor: SlotVendor;
  metric?: VendorMetric;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span
        className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-cover bg-center text-[13px] font-bold text-white"
        style={
          vendor.imageUrl
            ? { backgroundImage: `url(${vendor.imageUrl})` }
            : { background: vendor.accentTint ?? "var(--accent)" }
        }
      >
        {vendor.imageUrl ? "" : vendor.name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold">{vendor.name}</span>
          {vendor.status !== "active" ? (
            <StatusText tone={STATUS_TONE[vendor.status] ?? "neutral"}>
              <span className="capitalize">{vendor.status}</span>
            </StatusText>
          ) : null}
        </span>
        <span className="block truncate text-[11.5px] text-muted">
          {vendor.category ?? "Uncategorised"} · /{vendor.slug}
        </span>
        <Metrics metric={metric} />
      </span>
    </div>
  );
}

/**
 * What this shop earns its slot on: sales over the window, and its rating.
 *
 * The rank chips are the point — an absolute figure says a shop sold ₹40,000,
 * but only "#7 by sales" tells the operator it is sitting three slots higher
 * than its trade justifies.
 */
function Metrics({ metric }: { metric?: VendorMetric }) {
  if (!metric) return null;

  const rated = metric.ratingCount > 0 && metric.rating > 0;

  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
      {metric.orders > 0 ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-data font-bold tabular-nums">
            {formatINR(metric.sales)}
          </span>
          <span className="text-muted">
            · {formatCount(metric.orders)}{" "}
            {metric.orders === 1 ? "order" : "orders"} · {RANKING_WINDOW_DAYS}d
          </span>
          {metric.salesRank != null ? <RankChip rank={metric.salesRank} /> : null}
        </span>
      ) : (
        <span className="text-muted">
          No delivered orders in {RANKING_WINDOW_DAYS} days
        </span>
      )}

      <span className="inline-flex items-center gap-1 text-muted">
        <Star
          className={cn("size-3", rated ? "text-[var(--pop)]" : "opacity-40")}
        />
        {rated ? (
          <>
            <span className="text-data font-semibold tabular-nums text-ink">
              {formatRating(metric.rating)}
            </span>
            <span>({formatCount(metric.ratingCount)})</span>
            {metric.ratingRank != null ? (
              <RankChip rank={metric.ratingRank} />
            ) : null}
          </>
        ) : (
          <span>Unrated</span>
        )}
      </span>
    </span>
  );
}

function RankChip({ rank }: { rank: number }) {
  return (
    <span
      className="text-data shrink-0 rounded-full bg-surface-2 px-1.5 text-[10px] font-bold tabular-nums text-muted"
      title={`Ranked ${rank}`}
    >
      #{rank}
    </span>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="press grid size-9 place-items-center rounded-lg border border-line text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
