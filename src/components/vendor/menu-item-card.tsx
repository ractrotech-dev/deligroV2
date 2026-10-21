"use client";

import { useState, useTransition } from "react";
import {
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  GripVertical,
  Pencil,
  Square,
  Trash2,
  UtensilsCrossed,
} from "lucide-react";
import { VegMark } from "@/components/shared/veg-mark";
import { Button } from "@/components/ui/button";
import { MenuAvailabilityToggle } from "@/components/vendor/menu-availability-toggle";
import { updateMenuItemPriceAction } from "@/app/vendor/actions";
import type { VendorMenuItem } from "@/lib/data-access/vendor-menu";
import { formatINR } from "@/lib/utils/format";
import { moderationNotice } from "@/lib/menu/moderation-notice";
import { cn } from "@/lib/utils/cn";

type MenuRow = VendorMenuItem;

function formatAddedOn(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return null;
  }
}

export function VendorMenuItemCard({
  item,
  live,
  bulkMode,
  showReorder,
  selected,
  canMoveUp,
  canMoveDown,
  deleting,
  onToggleSelect,
  onEdit,
  onDelete,
  onDuplicate,
  onPreview,
  onMove,
  onAvailability,
  onPriceSaved,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  item: MenuRow;
  live: boolean;
  bulkMode: boolean;
  showReorder: boolean;
  selected: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  deleting: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onPreview: () => void;
  onMove: (dir: "up" | "down") => void;
  onAvailability: (available: boolean) => void;
  onPriceSaved: (price: number) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}) {
  const [priceDraft, setPriceDraft] = useState(String(item.price));
  const [priceError, setPriceError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Re-seed the draft when the item's price changes (server refresh, or a save
  // elsewhere). Done during render, not in an effect — the effect form trips
  // react-hooks/set-state-in-effect and paints one stale frame first.
  const [lastPrice, setLastPrice] = useState(item.price);
  if (item.price !== lastPrice) {
    setLastPrice(item.price);
    setPriceDraft(String(item.price));
  }

  function savePrice() {
    const next = Math.round(Number(priceDraft));
    if (!Number.isFinite(next) || next < 0) {
      setPriceError("Invalid");
      setPriceDraft(String(item.price));
      return;
    }
    if (next === item.price) {
      setPriceError(null);
      return;
    }
    setPriceError(null);
    startTransition(async () => {
      try {
        await updateMenuItemPriceAction(item.dbId, next);
        onPriceSaved(next);
      } catch {
        setPriceError("Failed");
        setPriceDraft(String(item.price));
      }
    });
  }

  return (
    <div
      className={cn(
        "vendor-menu-item overflow-hidden",
        item.soldOut && "opacity-90",
        selected && "ring-2 ring-accent/40"
      )}
      draggable={live && !bulkMode && showReorder}
      onDragStart={(e) => {
        if (!live || bulkMode || !showReorder) return;
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <div className="flex gap-3 p-3 sm:p-4">
        {bulkMode ? (
          <button
            type="button"
            className="mt-1 shrink-0 text-accent"
            onClick={onToggleSelect}
            aria-label={selected ? "Deselect item" : "Select item"}
          >
            {selected ? (
              <CheckSquare className="size-5" />
            ) : (
              <Square className="size-5 text-muted" />
            )}
          </button>
        ) : live && showReorder ? (
          <div className="mt-1 flex shrink-0 flex-col items-center gap-0.5 text-muted">
            <span
              className="cursor-grab active:cursor-grabbing"
              title="Drag to reorder"
              aria-hidden
            >
              <GripVertical className="size-4" />
            </span>
            <button
              type="button"
              className="press rounded p-0.5 hover:bg-surface-2 disabled:opacity-30"
              disabled={!canMoveUp || pending}
              onClick={() => onMove("up")}
              aria-label="Move up"
            >
              <ChevronUp className="size-4" />
            </button>
            <button
              type="button"
              className="press rounded p-0.5 hover:bg-surface-2 disabled:opacity-30"
              disabled={!canMoveDown || pending}
              onClick={() => onMove("down")}
              aria-label="Move down"
            >
              <ChevronDown className="size-4" />
            </button>
          </div>
        ) : null}

        <div className="relative shrink-0">
          {item.image ? (
            <img
              src={item.image}
              alt=""
              className={cn(
                "size-16 rounded-xl object-cover sm:size-[4.5rem]",
                item.soldOut && "grayscale"
              )}
            />
          ) : (
            <span
              className={cn(
                "grid size-16 place-items-center rounded-xl bg-surface-2 text-muted sm:size-[4.5rem]",
                item.soldOut && "grayscale opacity-70"
              )}
            >
              <UtensilsCrossed className="size-6" />
            </span>
          )}
          <span className="absolute -bottom-1 -right-1 rounded-full bg-surface p-0.5 shadow-sm">
            <VegMark veg={item.veg} />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <p
                  className={cn(
                    "font-semibold leading-snug",
                    item.soldOut && "text-muted"
                  )}
                >
                  {item.name}
                </p>
                {item.popular ? (
                  <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-bold uppercase text-accent">
                    Popular
                  </span>
                ) : null}
                {item.bestseller ? (
                  <span className="rounded-full bg-green-soft px-2 py-0.5 text-[11px] font-bold uppercase text-green">
                    Bestseller
                  </span>
                ) : null}
                {item.soldOut ? (
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-bold uppercase text-muted">
                    Sold out
                  </span>
                ) : null}
                {!item.image ? (
                  <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-bold uppercase text-accent">
                    No photo
                  </span>
                ) : null}
              </div>

              {live && !bulkMode ? (
                <label className="mt-1.5 inline-flex items-center gap-1">
                  <span className="text-xs font-semibold text-muted">₹</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={priceDraft}
                    disabled={pending}
                    onChange={(e) => setPriceDraft(e.target.value)}
                    onBlur={savePrice}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      }
                    }}
                    className={cn(
                      "text-data w-20 rounded-lg border border-line bg-surface px-2 py-1 text-sm font-bold outline-none focus:border-accent",
                      priceError && "border-red-500"
                    )}
                    aria-label={`Price for ${item.name}`}
                  />
                  {pending ? (
                    <span className="text-[11px] text-muted">Saving…</span>
                  ) : null}
                </label>
              ) : (
                <p className="text-data mt-1 text-base font-bold">
                  {formatINR(item.price)}
                </p>
              )}

              <p className="mt-1 text-[11px] text-muted">
                {item.soldCount > 0 ? (
                  <>
                    Sold{" "}
                    <span className="text-data font-semibold text-ink">
                      {item.soldCount}
                    </span>
                    {" · "}
                    <span className="text-data font-semibold text-ink">
                      {formatINR(item.soldRevenue)}
                    </span>
                  </>
                ) : (
                  "No sales yet"
                )}
                {formatAddedOn(item.createdAt) ? (
                  <> · Added {formatAddedOn(item.createdAt)}</>
                ) : null}
              </p>
            </div>

            {live && !bulkMode ? (
              <div className="flex max-w-full shrink-0 items-center justify-end gap-1 overflow-x-auto no-scrollbar">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="size-9 shrink-0 p-0"
                  onClick={onPreview}
                  aria-label={`Preview ${item.name}`}
                >
                  <Eye className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="size-9 shrink-0 p-0"
                  onClick={onDuplicate}
                  aria-label={`Duplicate ${item.name}`}
                >
                  <Copy className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="size-9 shrink-0 p-0"
                  onClick={onEdit}
                  aria-label={`Edit ${item.name}`}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="size-9 shrink-0 p-0"
                  disabled={deleting}
                  onClick={onDelete}
                  aria-label={`Delete ${item.name}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ) : null}
          </div>

          {item.description ? (
            <p className="mt-1.5 line-clamp-2 text-xs text-muted">
              {item.description}
            </p>
          ) : null}

          <ModerationLine item={item} />
        </div>
      </div>

      {live && !bulkMode ? (
        <div className="border-t border-line bg-surface-2/50 px-3 py-2.5 sm:px-4">
          <MenuAvailabilityToggle
            menuItemId={item.dbId}
            initialAvailable={!item.soldOut}
            itemName={item.name}
            layout="row"
            onChange={onAvailability}
          />
        </div>
      ) : !live ? (
        <div className="border-t border-line px-3 py-2 text-xs font-semibold text-muted sm:px-4">
          {item.soldOut ? "Sold out" : "In stock"}
        </div>
      ) : null}
    </div>
  );
}

/** Deligro's moderation of this dish (0146): why it is not on sale, or what is waiting. */
function ModerationLine({ item }: Readonly<{ item: MenuRow }>) {
  const notice = moderationNotice(item);
  if (!notice) return null;
  return (
    <p
      role="status"
      className={cn(
        "mt-1.5 rounded-lg px-2 py-1 text-xs",
        notice.tone === "critical" && "bg-red-500/10 text-red-600",
        notice.tone === "pending" && "bg-accent/10 text-ink",
        notice.tone === "neutral" && "bg-surface-2 text-muted"
      )}
    >
      <span className="font-bold">{notice.label}.</span> {notice.detail}
    </p>
  );
}
