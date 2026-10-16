"use client";

import { useEffect } from "react";
import { AlertTriangle, ChevronLeft, Loader2, MapPin } from "lucide-react";
import { MapPicker, type PickedLocation } from "@/components/location/map-picker";
import { useLang } from "@/components/providers/lang-provider";
import {
  blocksOrder,
  outOfRangeMessage,
  type ServiceArea,
} from "@/lib/geo/service-area";

/**
 * The pin screen: the map on its own, opened from the "Delivering to … Change"
 * strip above the order button. Checkout itself no longer carries a map, so it
 * stays short and the map only loads when someone needs to move the pin.
 *
 * It owns no state. The pin, the saved-pin button and the area answer all live
 * in CheckoutView, which is also what places the order — this screen only shows
 * and edits them.
 */
export function DeliveryMapScreen({
  open,
  mapKey,
  coords,
  label,
  line,
  pinLine,
  pinMoved,
  pinBusy,
  pinSaved,
  area,
  unpinned,
  onPick,
  onSavePin,
  onSwitch,
  onClose,
}: Readonly<{
  open: boolean;
  /** Remounts the map when the address changes, so it re-centres on the new pin. */
  mapKey: string;
  coords: { lat: number; lng: number } | null;
  label: string;
  /** The saved address line. */
  line: string;
  /** What the map reverse-geocoded the moved pin to, when it differs. */
  pinLine: string | null;
  pinMoved: boolean;
  pinBusy: boolean;
  pinSaved: boolean;
  area: ServiceArea | null;
  unpinned: boolean;
  onPick: (loc: PickedLocation) => void;
  onSavePin: () => void;
  onSwitch: () => void;
  onClose: () => void;
}>) {
  const { lang, t } = useLang();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const outOfArea = area ? blocksOrder(area) : false;
  const km = area?.distanceKm != null ? area.distanceKm.toFixed(1) : null;

  let areaNote: React.ReactNode = null;
  if (outOfArea && area) {
    areaNote = (
      <p className="flex items-start gap-2 text-sm font-medium text-deal">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        {outOfRangeMessage(area, lang)}
      </p>
    );
  } else if (unpinned) {
    areaNote = (
      <p className="text-sm font-medium text-deal">
        {t(
          "Drop the pin on the map so we can check we deliver here.",
          "नक्शे पर पिन लगाएं ताकि हम देख सकें कि यहां डिलीवरी होती है।",
        )}
      </p>
    );
  } else if (km) {
    areaNote = (
      <p className="text-sm font-semibold text-green">
        {t(
          `✓ ${km} km away, inside our delivery area`,
          `✓ ${km} किमी दूर, हमारे डिलीवरी क्षेत्र में`,
        )}
      </p>
    );
  }

  const pinSaveLabel = pinSaved
    ? t("Pin saved to address", "पिन पते में सेव हो गया")
    : t("Save pin to this address", "इस पते में पिन सेव करें");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("Confirm delivery location", "डिलीवरी की जगह पक्की करें")}
      className="fixed inset-0 z-50 flex flex-col bg-surface"
    >
      <header className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Go back", "वापस जाएं")}
          className="press grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink"
        >
          <ChevronLeft className="size-5" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-center text-[17px] font-extrabold tracking-tight">
          {t("Confirm delivery location", "डिलीवरी की जगह पक्की करें")}
        </h2>
        <span className="size-10 shrink-0" aria-hidden />
      </header>

      <div className="min-h-0 flex-1">
        <MapPicker
          key={mapKey}
          variant="full"
          initial={coords}
          onPick={onPick}
        />
      </div>

      <div className="space-y-3 border-t border-line bg-surface px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4">
        <p className="text-xs font-semibold text-muted">
          {t(
            "Move the pin to your exact spot. Your order is delivered there.",
            "पिन को अपनी सही जगह पर रखें। ऑर्डर वहीं पहुंचेगा।",
          )}
        </p>

        <div className="flex items-start gap-3">
          <MapPin
            className="mt-0.5 size-5 shrink-0 text-accent"
            strokeWidth={2.25}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-bold">{label}</p>
            <p className="text-sm leading-snug text-muted">
              {pinMoved && pinLine ? pinLine : line}
            </p>
          </div>
          <button
            type="button"
            onClick={onSwitch}
            className="press shrink-0 px-1 py-1 text-sm font-bold text-accent-ink"
          >
            {t("Switch address", "पता बदलें")}
          </button>
        </div>

        {areaNote}

        {pinMoved ? (
          <button
            type="button"
            onClick={onSavePin}
            disabled={pinBusy}
            className="press w-full rounded-xl border border-accent bg-accent-soft py-2.5 text-sm font-bold text-accent-ink disabled:opacity-60"
          >
            {pinBusy ? (
              <Loader2 className="mx-auto size-4 animate-spin" />
            ) : (
              pinSaveLabel
            )}
          </button>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          className="press flex h-12 w-full items-center justify-center rounded-full bg-accent text-[16px] font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)]"
        >
          {t("Confirm location", "जगह पक्की करें")}
        </button>
      </div>
    </div>
  );
}
