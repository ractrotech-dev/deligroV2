"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, MapPin, Search, X } from "lucide-react";
import { isMapsConfigured } from "@/lib/maps/config";
import { loadGoogleMaps } from "@/lib/maps/loader";
import { shopPlaceFrom, type ShopPlace } from "@/lib/maps/shop-place";

/**
 * Find a shop that is already on Google Maps and copy its address, pin and
 * pincode into the form. Nothing is saved here: the operator confirms the match,
 * and the values go through the form's own validation when it is saved.
 *
 * Searches businesses rather than streets, which is what separates it from the
 * search box on MapPicker. Renders nothing when the Maps key is unset, because
 * both forms already explain that and offer typing instead.
 */
export function GoogleShopSearch({
  shopName,
  onUse,
  popover = false,
}: Readonly<{
  /** Starts the search with the name already entered on the form. */
  shopName?: string;
  onUse: (place: ShopPlace) => void;
  /** A button alone that opens the search over the page, for a tight desktop form. */
  popover?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<ShopPlace | null>(null);
  const [used, setUsed] = useState<string | null>(null);
  const inputEl = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let listener: google.maps.MapsEventListener | null = null;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !inputEl.current) return;
        const autocomplete = new google.maps.places.Autocomplete(inputEl.current, {
          fields: ["name", "formatted_address", "geometry", "address_components"],
          componentRestrictions: { country: "in" },
          types: ["establishment"],
        });
        listener = autocomplete.addListener("place_changed", () => {
          const place = shopPlaceFrom(autocomplete.getPlace());
          setFound(place);
          setError(place ? null : "Choose the shop from Google's list.");
        });
        setLoading(false);
        inputEl.current.focus();
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        setError("Google Maps didn't load. Type the address and pin instead.");
      });
    return () => {
      cancelled = true;
      listener?.remove();
    };
  }, [open]);

  if (!isMapsConfigured) return null;

  const close = () => {
    setOpen(false);
    setLoading(true);
    setFound(null);
    setError(null);
  };

  if (!open && popover) {
    return (
      <div className="space-y-1.5">
        <button type="button" onClick={() => { setUsed(null); setOpen(true); }} className="c-btn c-btn-outline">
          <MapPin className="size-3.5" /> Find on Google Maps
        </button>
        {used ? (
          <p className="flex items-center gap-1 text-[12px] text-muted">
            <Check className="size-3.5 shrink-0 text-green" /> Filled from {used}. Save to keep it.
          </p>
        ) : null}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setUsed(null);
            setOpen(true);
          }}
          className="c-btn c-btn-outline"
        >
          <MapPin className="size-3.5" /> Find on Google Maps
        </button>
        {used ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-muted">
            <Check className="size-3.5 text-green" /> Address and pin filled from {used}. Save to keep them.
          </span>
        ) : (
          <span className="text-[12px] text-muted">
            If the shop is on Google Maps, this fills in its address and pin.
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={
        popover
          ? "absolute z-30 w-[440px] space-y-2.5 rounded-[var(--c-r)] border border-line bg-surface p-3 shadow-[var(--shadow-md)]"
          : "space-y-2.5 rounded-[var(--c-r)] border border-line bg-surface p-3"
      }
    >
      <div className="flex items-center gap-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--c-r)] border border-line bg-surface px-2.5 focus-within:border-[var(--c-border-hover)]">
          {loading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" />
          ) : (
            <Search className="size-3.5 shrink-0 text-muted" />
          )}
          {/* Not a form field: Enter chooses from Google's list, and must not
              submit the form around it. */}
          <input
            ref={inputEl}
            type="text"
            defaultValue={shopName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
            placeholder="Shop name and area, e.g. Sharma Sweets Ambikapur"
            aria-label="Search for the shop on Google Maps"
            style={{ outline: "none" }}
            className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
          />
        </div>
        <button type="button" onClick={close} className="text-muted hover:text-ink" aria-label="Close search">
          <X className="size-4" />
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-[12px] font-medium text-deal">
          {error}
        </p>
      ) : null}

      {found ? (
        <div className="flex items-center gap-3 border-t border-[color:var(--c-divider)] pt-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-ink">{found.name}</p>
            <p className="text-[12px] text-muted">{found.address}</p>
            <p className="text-data text-[11px] text-muted">
              {found.lat.toFixed(5)}, {found.lng.toFixed(5)}
              {found.pincode ? ` · ${found.pincode}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              onUse(found);
              setUsed(found.name || "Google Maps");
              close();
            }}
            className="c-btn c-btn-dark shrink-0"
          >
            Use this shop
          </button>
        </div>
      ) : null}
    </div>
  );
}
