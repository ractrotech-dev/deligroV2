"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, LocateFixed, Search } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { loadGoogleMaps } from "@/lib/maps/loader";
import { isMapsConfigured, DEFAULT_CENTER } from "@/lib/maps/config";
import { locationSettingsSteps } from "@/lib/location/permission-help";
import { useLang } from "@/components/providers/lang-provider";

export interface PickedLocation {
  lat: number;
  lng: number;
  address: string;
}

/**
 * Drop-a-pin delivery-location picker (Google Maps) — the same idea as the
 * legacy delivery-address page. The user searches, taps the map, drags the pin,
 * or hits "use my location"; each move reverse-geocodes to a street address and
 * reports { lat, lng, address } to the parent.
 *
 * Renders nothing when NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is unset, so callers can
 * fall back to a plain text field.
 */
export function MapPicker({
  initial,
  onPick,
  variant = "form",
}: Readonly<{
  initial?: { lat: number; lng: number } | null;
  onPick: (loc: PickedLocation) => void;
  /**
   * "checkout" — embedded map with Adjust pin, no search bar.
   * "full" — fills its parent (a full-screen pin screen): search floats on top,
   * "Use my location" sits bottom-left, clear of Google's zoom control.
   */
  variant?: "form" | "checkout" | "full";
}>) {
  // Also used by the vendor and admin shop-location forms, which have no
  // language provider and so read English.
  const { lang, t } = useLang();
  const mapEl = useRef<HTMLDivElement>(null);
  const searchEl = useRef<HTMLInputElement>(null);
  const marker = useRef<google.maps.Marker | null>(null);
  const geocoder = useRef<google.maps.Geocoder | null>(null);
  const mapObj = useRef<google.maps.Map | null>(null);

  // Keep the latest onPick without re-running the (one-shot) init effect.
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  });

  // Init to "error" (renders nothing) when the key is absent, so we never mount
  // the map container. isMapsConfigured is a build-time constant, so this is a
  // stable initial value — no conditional hooks below.
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    isMapsConfigured ? "loading" : "error",
  );
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  // Move the pin, recentre, reverse-geocode, and report upward.
  function settle(pos: google.maps.LatLng) {
    const lat = pos.lat();
    const lng = pos.lng();
    marker.current?.setPosition(pos);
    mapObj.current?.panTo(pos);
    geocoder.current
      ?.geocode({ location: { lat, lng } })
      .then((r) =>
        onPickRef.current({
          lat,
          lng,
          address: r.results?.[0]?.formatted_address ?? "",
        }),
      )
      .catch(() => onPickRef.current({ lat, lng, address: "" }));
  }

  useEffect(() => {
    if (!isMapsConfigured) return;
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !mapEl.current) return;
        const start = initial ?? DEFAULT_CENTER;

        const map = new google.maps.Map(mapEl.current, {
          center: start,
          zoom: initial ? 17 : 14,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          gestureHandling: "greedy",
        });
        const pin = new google.maps.Marker({
          map,
          position: start,
          draggable: true,
        });
        mapObj.current = map;
        marker.current = pin;
        geocoder.current = new google.maps.Geocoder();

        map.addListener("click", (e) => {
          if (e.latLng) settle(e.latLng);
        });
        pin.addListener("dragend", () => {
          const p = pin.getPosition();
          if (p) settle(p);
        });

        if (searchEl.current) {
          const ac = new google.maps.places.Autocomplete(searchEl.current, {
            fields: ["geometry", "formatted_address"],
            componentRestrictions: { country: "in" },
          });
          ac.addListener("place_changed", () => {
            const loc = ac.getPlace().geometry?.location;
            if (loc) {
              map.setZoom(17);
              settle(loc);
            }
          });
        }

        // Resolve the address for a pre-existing pin so the parent has a line.
        if (initial) settle(new google.maps.LatLng(initial.lat, initial.lng));
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // Intentionally one-shot: re-init only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Called straight from the button's click — `getCurrentPosition` has to run
  // inside the tap for the browser to show its permission prompt. Failures used
  // to be swallowed (`() => setLocating(false)`), so a blocked permission looked
  // like a button that did nothing; now each one says what to do.
  function useMyLocation() {
    setLocateError(null);
    if (!("geolocation" in navigator)) {
      setLocateError(
        t(
          "This device can't share its location. Drag the pin instead.",
          "यह फ़ोन लोकेशन नहीं दे पा रहा। पिन खींचकर अपना पता लगाएं।",
        ),
      );
      return;
    }
    if (!window.isSecureContext) {
      setLocateError(
        t(
          "Location needs a secure (https) connection. Drag the pin instead.",
          "लोकेशन के लिए सुरक्षित कनेक्शन चाहिए। पिन खींचकर अपना पता लगाएं।",
        ),
      );
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        mapObj.current?.setZoom(17);
        settle(
          new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude),
        );
      },
      (err) => {
        setLocating(false);
        setLocateError(
          err.code === err.PERMISSION_DENIED
            ? t(
                `Location is blocked for this site. ${locationSettingsSteps(lang).join(" ")} Or drag the pin to your address.`,
                `इस साइट के लिए लोकेशन बंद है। ${locationSettingsSteps(lang).join(" ")} या पिन खींचकर अपने पते पर लगाएं।`,
              )
            : err.code === err.TIMEOUT
              ? t(
                  "Your phone took too long to find you. Try again, or drag the pin.",
                  "फ़ोन को लोकेशन ढूंढने में बहुत देर लगी। फिर से कोशिश करें या पिन खींचें।",
                )
              : t(
                  "Couldn't get your location. Try again, or drag the pin.",
                  "आपकी लोकेशन नहीं मिली। फिर से कोशिश करें या पिन खींचें।",
                ),
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }

  if (status === "error") {
    if (variant === "full") {
      return (
        <div className="grid h-full place-items-center bg-surface-2 px-6 text-center text-sm text-muted">
          {t(
            "Map unavailable — your saved address will be used",
            "नक्शा नहीं खुल रहा — आपका सेव किया हुआ पता इस्तेमाल होगा",
          )}
        </div>
      );
    }
    if (variant === "checkout") {
      return (
        <div className="relative overflow-hidden rounded-xl bg-surface-2">
          <div className="grid h-44 place-items-center text-sm text-muted">
            {t(
              "Map unavailable — enter address details below",
              "नक्शा नहीं खुल रहा — नीचे पते की जानकारी लिखें",
            )}
          </div>
        </div>
      );
    }
    return null;
  }

  const checkout = variant === "checkout";

  if (variant === "full") {
    return (
      <div className="relative h-full min-h-0">
        <div ref={mapEl} className="absolute inset-0" />
        {status === "loading" ? (
          <div className="absolute inset-0 grid place-items-center bg-surface-2/60">
            <Loader2 className="size-6 animate-spin text-muted" />
          </div>
        ) : null}
        <div className="absolute inset-x-3 top-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            ref={searchEl}
            type="text"
            placeholder={t(
              "Search for area, street, landmark…",
              "मोहल्ला, गली या पास की जगह खोजें…",
            )}
            className="w-full rounded-xl border border-line bg-surface py-3 pl-9 pr-3 text-sm shadow-[var(--shadow-md)] outline-none focus:border-accent"
          />
        </div>
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating || status !== "ready"}
          className="press absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full bg-surface px-3 py-2 text-sm font-semibold text-accent shadow-[var(--shadow-md)] disabled:opacity-60"
        >
          {locating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <LocateFixed className="size-4" />
          )}
          {locating
            ? t("Locating…", "लोकेशन ढूंढ रहे हैं…")
            : t("Use my location", "मेरी लोकेशन लें")}
        </button>
        {locateError ? (
          <p
            role="alert"
            className="absolute inset-x-3 bottom-16 rounded-xl bg-surface p-3 text-xs font-medium text-deal shadow-[var(--shadow-md)]"
          >
            {locateError}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={checkout ? undefined : "space-y-2"}>
      {!checkout ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            ref={searchEl}
            type="text"
            placeholder={t(
              "Search for area, street, landmark…",
              "मोहल्ला, गली या पास की जगह खोजें…",
            )}
            className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm outline-none focus:border-accent"
          />
        </div>
      ) : null}

      <div className="relative overflow-hidden rounded-xl bg-surface-2">
        <div ref={mapEl} className={cn("w-full", checkout ? "h-44" : "h-52")} />
        {status === "loading" ? (
          <div className="absolute inset-0 grid place-items-center bg-surface-2/60">
            <Loader2 className="size-6 animate-spin text-muted" />
          </div>
        ) : null}
        {checkout ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <span className="rounded-full bg-surface px-4 py-2 text-sm font-semibold text-ink shadow-[var(--shadow-md)]">
              {t("Adjust pin", "पिन सही करें")}
            </span>
          </div>
        ) : null}
        {/* On every variant — the checkout map used to render only the "Adjust
            pin" pill, so the one map where the pin decides whether we deliver
            had no way to jump to where you are. Top-right, clear of the zoom
            control Google puts at the bottom-right. */}
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating || status !== "ready"}
          className="press absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-surface px-3 py-2 text-sm font-semibold text-accent shadow-[var(--shadow-md)] disabled:opacity-60"
        >
          {locating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <LocateFixed className="size-4" />
          )}
          {locating
            ? t("Locating…", "लोकेशन ढूंढ रहे हैं…")
            : t("Use my location", "मेरी लोकेशन लें")}
        </button>
      </div>
      {locateError ? (
        <p
          role="alert"
          className={cn("text-xs font-medium text-deal", checkout && "mt-2")}
        >
          {locateError}
        </p>
      ) : null}
      {!checkout ? (
        <p className="text-xs text-muted">
          {t(
            "Tap the map or drag the pin to set your exact delivery spot.",
            "नक्शे पर दबाएं या पिन खींचकर डिलीवरी की सही जगह चुनें।",
          )}
        </p>
      ) : null}
    </div>
  );
}
