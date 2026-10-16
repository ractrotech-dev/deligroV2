"use client";

import { useEffect } from "react";
import { Check, MapPin, Plus, X } from "lucide-react";
import type { SavedAddress } from "@/hooks/use-saved-addresses";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

export function AddressPickerSheet({
  open,
  addresses,
  selectedId,
  onSelect,
  onClose,
  onAddNew,
}: Readonly<{
  open: boolean;
  addresses: SavedAddress[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onAddNew: () => void;
}>) {
  const t = useT();
  // Escape closes it, like every other sheet a keyboard can reach.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // `fixed`, not `absolute`: this renders inside the scrolling content, so an
    // absolute overlay would be anchored to the scrolled page and slide away
    // with it. The app shell is the containing block for fixed, so this covers
    // the phone screen and stays put.
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={t("Close", "बंद करें")}
        onClick={onClose}
        className="animate-fade-in absolute inset-0 bg-ink/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Choose delivery address", "डिलीवरी का पता चुनें")}
        className="bolt-sheet animate-sheet-in absolute inset-x-0 bottom-0 max-h-[78%] overflow-hidden"
      >
        <div className="bolt-sheet-handle" />
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <h2 className="text-heading">
            {t("Delivery address", "डिलीवरी का पता")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close", "बंद करें")}
            className="press grid size-9 place-items-center rounded-full bg-surface-2 text-muted"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="no-scrollbar max-h-[50vh] overflow-y-auto px-5">
          <ul className="divide-y divide-line">
            {addresses.map((a) => {
              const on = a.id === selectedId;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(a.id);
                      onClose();
                    }}
                    className="press flex w-full items-start gap-3 py-3.5 text-left"
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg",
                        on
                          ? "bg-accent text-[var(--on-accent)]"
                          : "bg-surface-2 text-muted",
                      )}
                    >
                      <MapPin className="size-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[15px] font-bold">
                        {a.label}
                        {a.isDefault ? (
                          <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                            {t("Default", "डिफ़ॉल्ट")}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-sm leading-snug text-muted">
                        {a.line}
                      </span>
                    </span>
                    {on ? (
                      <Check className="mt-2 size-5 shrink-0 text-accent" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-t border-line p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => {
              onClose();
              onAddNew();
            }}
            className="press flex w-full items-center justify-center gap-2 rounded-full border border-dashed border-line bg-surface py-3.5 text-sm font-bold text-accent-ink"
          >
            <Plus className="size-4" />{" "}
            {t("Add a new address", "नया पता जोड़ें")}
          </button>
        </div>
      </div>
    </div>
  );
}
