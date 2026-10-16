"use client";

import { useEffect } from "react";
import Link from "next/link";
import {
  Bell,
  ChevronDown,
  LoaderCircle,
  MapPin,
  Navigation,
  Search,
  User,
  X,
} from "lucide-react";
import { useLocation } from "@/stores/location-store";
import { useScrollCollapse } from "@/hooks/use-scroll-collapse";
import { cn } from "@/lib/utils/cn";
import { addressLocality } from "@/lib/utils/address-locality";
import { useT } from "@/components/providers/lang-provider";

/** The user's saved default address, resolved server-side and passed in. */
export interface SavedAddress {
  label: string;
  line: string;
  /** The saved pin, so card distances are measured from the saved address. */
  lat?: number | null;
  lng?: number | null;
}

/**
 * Sticky header for the feed screens: where we deliver, and what you're looking
 * for.
 *
 * Scrolling into the feed collapses the whole top row — address, notifications
 * and profile — leaving just the search field. The row is the only thing that
 * moves; see use-scroll-collapse for the hysteresis that stops the height it
 * gives back from bouncing the header (an earlier version of this flickered
 * exactly that way).
 */
export function HomeHeader({
  savedAddress,
  query = "",
  onQueryChange,
}: Readonly<{
  savedAddress?: SavedAddress | null;
  query?: string;
  onQueryChange?: (value: string) => void;
}>) {
  const status = useLocation((s) => s.status);
  const label = useLocation((s) => s.label);
  const sublabel = useLocation((s) => s.sublabel);
  const adoptSaved = useLocation((s) => s.adoptSaved);
  const releaseSaved = useLocation((s) => s.releaseSaved);

  // The saved address is the delivery location, so the rest of the app (card
  // distances, a GPS fix that arrives later) has to know it is. Keyed on the
  // values, not the object, which is new on every server render.
  const savedLabel = savedAddress?.label;
  const savedLine = savedAddress?.line;
  const savedLat = savedAddress?.lat ?? null;
  const savedLng = savedAddress?.lng ?? null;
  useEffect(() => {
    if (savedLabel === undefined || savedLine === undefined) {
      releaseSaved();
      return;
    }
    adoptSaved({
      label: savedLabel,
      sublabel: addressLocality(savedLine) ?? "",
      coords:
        savedLat !== null && savedLng !== null
          ? { lat: savedLat, lng: savedLng }
          : null,
    });
  }, [savedLabel, savedLine, savedLat, savedLng, adoptSaved, releaseSaved]);

  const collapsed = useScrollCollapse();
  const t = useT();

  // A saved address is shown whatever the device is doing, so a silent
  // re-detect on launch must not flash "Locating…" over it.
  const detecting = status === "loading" && !savedAddress;
  const detected = status === "granted" && !!label;
  // A fix restored from cache, past its TTL. Still shown — the last known area
  // is usually right, and a blank header helps nobody — but not presented as
  // where the customer is now. Before the cache carried a timestamp this state
  // did not exist: a fix from another city weeks ago was restored as "granted"
  // and named in the header with nothing to say how old it was.
  const stale = status === "stale" && !!label;

  // The store always holds a location — it starts at Bemetara, the city we
  // deliver in, and a detected fix or a saved address replaces it. So the
  // header shows a real place from the first paint instead of "Set your
  // location", and it always names the same place the distances are measured
  // from. A saved address still wins over the city default.
  const place = detected ? { label, sublabel } : null;
  const saved = savedAddress
    ? {
        label: savedAddress.label,
        // The locality, not "Chhattisgarh 490020, India" — see addressLocality.
        sublabel: addressLocality(savedAddress.line) ?? "",
      }
    : null;
  const fallback = label ? { label, sublabel } : null;

  // The saved delivery address comes first: it is where checkout will deliver.
  // A device place (GPS fix, searched area) only stands in when there is none,
  // and otherwise waits on the Delivery location screen to be confirmed.
  const shown = saved ?? place ?? fallback;
  const primary = shown?.label ?? t("Set your location", "अपनी जगह चुनें");
  // The subtitle is where the age goes: it is the line nobody depends on for
  // the place name, and "Last known area" is the whole disclosure a customer
  // needs before they read a distance off a card.
  const secondary =
    stale && !saved
      ? t("Last known area · tap to update", "पिछली जगह · बदलने के लिए दबाएं")
      : (shown?.sublabel ?? t("Tap to detect", "जगह पता करने के लिए दबाएं"));

  return (
    <div className="app-header sticky top-0 z-20 px-4 pb-3 pt-2.5">
      {/* `inert` as well as the CSS pointer-events: a collapsed row is gone as
          far as tapping and the tab order are concerned, not just invisible. */}
      <div
        className={cn("collapsible", collapsed && "is-collapsed")}
        inert={collapsed}
      >
        {/* The clipping child carries no padding of its own — padding lives on
            the row inside it. A grid item's padding is added outside the height
            the 0fr row gives it, so any here would survive the collapse as a
            stubborn sliver of empty space. */}
        <div>
          <div className="flex items-center gap-2 pb-3">
            {/* Goes to the picker, not the permission sheet — re-asking for a
                permission the device has already answered does nothing. */}
            <Link
              href="/location"
              className="press flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
              aria-label={t("Change delivery location", "डिलीवरी की जगह बदलें")}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue/12 text-blue">
                {detecting ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : detected ? (
                  <Navigation className="size-4" />
                ) : (
                  <MapPin className="size-4" />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
                  {detecting
                    ? t("Locating…", "जगह खोज रहे हैं…")
                    : t("Deliver to", "यहां पहुंचाएं")}
                </span>
                <span className="flex min-w-0 items-center gap-1 text-[15px] font-extrabold leading-tight tracking-tight">
                  {/* The label keeps its width ("Home" is short); only the
                      locality after it gives way. Both used to truncate, and
                      "Home" lost first — "H…" at 360px. */}
                  <span className="max-w-[60%] shrink-0 truncate">
                    {primary}
                  </span>
                  {secondary ? (
                    <span className="truncate font-semibold text-muted">
                      · {secondary}
                    </span>
                  ) : null}
                  <ChevronDown className="size-4 shrink-0 text-muted" />
                </span>
              </span>
            </Link>

            <Link
              href="/profile/notifications"
              aria-label={t("Notifications", "सूचनाएं")}
              className="press grid size-11 shrink-0 place-items-center rounded-full bg-accent/12 text-accent"
            >
              <Bell className="size-[18px]" />
            </Link>
            <Link
              href="/profile"
              aria-label={t("Profile", "प्रोफ़ाइल")}
              className="press grid size-11 shrink-0 place-items-center rounded-full bg-violet-500/15 text-violet-500"
            >
              <User className="size-[18px]" />
            </Link>
          </div>
        </div>
      </div>

      <div className="bolt-search w-full">
        <Search className="size-5 shrink-0" strokeWidth={2.25} />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange?.(e.target.value)}
          placeholder={t(
            "Search for a dish, cuisine or restaurant",
            "खाना या रेस्टोरेंट खोजें",
          )}
          aria-label={t(
            "Search for a dish, cuisine or restaurant",
            "खाना या रेस्टोरेंट खोजें",
          )}
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange?.("")}
            aria-label={t("Clear search", "खोज मिटाएं")}
            className="press tap-target grid size-6 shrink-0 place-items-center rounded-full bg-surface text-muted"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
