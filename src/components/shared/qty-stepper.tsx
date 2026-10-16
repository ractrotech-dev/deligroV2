"use client";

import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

/** ADD button that expands into a −/qty/+ stepper once an item is in cart. */
export function QtyStepper({
  qty,
  onAdd,
  onInc,
  onDec,
  soldOut,
  size = "md",
  className,
}: Readonly<{
  qty: number;
  onAdd: () => void;
  onInc: () => void;
  onDec: () => void;
  soldOut?: boolean;
  size?: "sm" | "md";
  className?: string;
}>) {
  const t = useT();
  const dims = size === "sm" ? "h-9 min-w-[84px]" : "h-10 min-w-[96px]";

  if (soldOut) {
    return (
      <div
        className={cn(
          "grid place-items-center rounded-full border border-line bg-surface-2 px-4 text-label !text-muted",
          dims,
          className,
        )}
      >
        {t("Sold out", "ख़त्म हो गया")}
      </div>
    );
  }

  if (qty === 0) {
    return (
      <button
        onClick={onAdd}
        className={cn(
          "press grid place-items-center rounded-full border-[1.5px] border-accent bg-surface font-bold uppercase tracking-wide text-accent-ink shadow-[var(--shadow-sm)]",
          dims,
          className,
        )}
      >
        <span className="flex items-center gap-1">
          <Plus className="size-4" strokeWidth={2.75} /> {t("ADD", "जोड़ें")}
        </span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-full bg-accent px-1 font-semibold text-[var(--on-accent)] shadow-[var(--glow-accent)]",
        dims,
        className,
      )}
    >
      <button
        onClick={onDec}
        aria-label={t("Remove one", "एक कम करें")}
        className="tap-target press grid size-8 place-items-center rounded-full hover:bg-white/15"
      >
        <Minus className="size-4" strokeWidth={2.75} />
      </button>
      <span className="text-data font-bold tabular-nums">{qty}</span>
      <button
        onClick={onInc}
        aria-label={t("Add one", "एक और जोड़ें")}
        className="tap-target press grid size-8 place-items-center rounded-full hover:bg-white/15"
      >
        <Plus className="size-4" strokeWidth={2.5} />
      </button>
    </div>
  );
}
