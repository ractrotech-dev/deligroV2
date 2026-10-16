"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  LoaderCircle,
  MapPin,
  Navigation,
  Plus,
  RotateCw,
  Search,
} from "lucide-react";
import { useLocation } from "@/stores/location-store";
import { useSavedAddresses } from "@/hooks/use-saved-addresses";
import { isMapsConfigured } from "@/lib/maps/config";
import { loadGoogleMaps } from "@/lib/maps/loader";
import { locationSettingsSteps } from "@/lib/location/permission-help";
import { addressLocality } from "@/lib/utils/address-locality";
import { useLang } from "@/components/providers/lang-provider";
import { pick } from "@/lib/i18n/lang";

/**
 * Delivery-location picker.
 *
 * Where the header's address chip leads. Three ways to answer the same
 * question — search for a place, use the device fix, or pick something already
 * saved — and a way to add a new address if none of them fit.
 *
 * The permission explainer is deliberately NOT raised from here: by the time
 * you're on this screen you've already been asked once, and the browser only
 * honours one prompt anyway. "Use current location" goes straight to the device.
 */
export default function LocationPage() {
  const router = useRouter();
  const { lang, t } = useLang();

  const status = useLocation((s) => s.status);
  const label = useLocation((s) => s.label);
  const error = useLocation((s) => s.error);
  const blocked = useLocation((s) => s.blocked);
  const detect = useLocation((s) => s.detect);
  const setPlace = useLocation((s) => s.setPlace);
  const adoptSaved = useLocation((s) => s.adoptSaved);
  const clearCandidate = useLocation((s) => s.clearCandidate);
  const savedActive = useLocation((s) => s.savedActive);
  const candidate = useLocation((s) => s.candidate);

  const { addresses, loading, selectedId, setDefault, create } =
    useSavedAddresses();

  const [confirming, setConfirming] = useState(false);
  const [confirmFailed, setConfirmFailed] = useState(false);

  const searchEl = useRef<HTMLInputElement>(null);
  const detecting = status === "loading";

  // Places autocomplete on the search field — same key and loader the address
  // map uses. Silently absent if the key isn't set; the rest of the page works.
  useEffect(() => {
    if (!isMapsConfigured) return;
    let cancelled = false;

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !searchEl.current) return;
        const ac = new google.maps.places.Autocomplete(searchEl.current, {
          fields: ["geometry", "formatted_address", "name"],
          componentRestrictions: { country: "in" },
        });
        ac.addListener("place_changed", () => {
          const place = ac.getPlace();
          const loc = place.geometry?.location;
          if (!loc) return;
          const found = {
            label:
              place.name ??
              place.formatted_address ??
              t("Selected location", "चुनी गई जगह"),
            sublabel: place.formatted_address ?? null,
            coords: { lat: loc.lat(), lng: loc.lng() },
          };
          // With a saved address active, a searched place is a candidate to
          // confirm below, not a silent replacement for it.
          if (useLocation.getState().savedActive) {
            useLocation.getState().setCandidate(found);
            return;
          }
          setPlace(found);
          router.back();
        });
      })
      .catch(() => {
        // Autocomplete is a convenience — the other paths still work without it.
      });

    return () => {
      cancelled = true;
    };
  }, [router, setPlace, t]);

  // Leave as soon as the device gives us a fix.
  const detectedRef = useRef(status);
  useEffect(() => {
    // Not when the fix is a candidate: that needs confirming on this screen.
    if (detectedRef.current === "loading" && status === "granted" && !candidate)
      router.back();
    detectedRef.current = status;
  }, [status, router, candidate]);

  function chooseSaved(id: string, addressLabel: string, line: string) {
    const address = addresses.find((a) => a.id === id);
    // In memory only: the saved address is read from the server on every
    // launch, so it is not copied into the browser's storage.
    adoptSaved({
      label: addressLabel,
      sublabel: addressLocality(line) ?? line,
      coords:
        address?.lat != null && address?.lng != null
          ? { lat: address.lat, lng: address.lng }
          : null,
    });
    router.back();
    // Persist the choice after navigating — the header already reads the store,
    // so there's nothing to wait for on screen.
    void setDefault(id).catch(() => {});
  }

  // Confirming a found place makes it a real saved address and the default, so
  // the header and checkout cannot name different places.
  async function confirmCandidate() {
    if (!candidate || confirming) return;
    setConfirming(true);
    setConfirmFailed(false);
    try {
      const line = [candidate.label, candidate.sublabel]
        .filter(Boolean)
        .join(", ");
      const saved = await create({
        label: "Other",
        line,
        lat: candidate.coords?.lat ?? null,
        lng: candidate.coords?.lng ?? null,
        isDefault: true,
      });
      adoptSaved({
        label: saved.label,
        sublabel: addressLocality(saved.line) ?? saved.line,
        coords: candidate.coords,
      });
      router.back();
    } catch {
      setConfirmFailed(true);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="min-h-full">
      <header className="app-header sticky top-0 z-20 flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label={t("Back", "वापस")}
          className="press grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 text-ink"
        >
          <ChevronLeft className="size-5" />
        </button>
        <h1 className="min-w-0 flex-1 text-[17px] font-extrabold tracking-tight">
          {t("Delivery location", "डिलीवरी की जगह")}
        </h1>
      </header>

      <div className="px-4 pb-8 pt-1">
        <div className="bolt-search w-full">
          <Search className="size-5 shrink-0" strokeWidth={2.25} />
          <input
            ref={searchEl}
            type="search"
            placeholder={t(
              "Search for an area, street or landmark",
              "मोहल्ला, गली या पास की जगह खोजें",
            )}
            aria-label={t(
              "Search for a delivery location",
              "डिलीवरी की जगह खोजें",
            )}
          />
        </div>

        <div className="mt-4 divide-y divide-line">
          <button
            type="button"
            onClick={() => detect()}
            disabled={detecting}
            className="press flex w-full items-center gap-3 py-3.5 text-left disabled:opacity-60"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
              {detecting ? (
                <LoaderCircle className="size-5 animate-spin" />
              ) : (
                <Navigation className="size-5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-accent-ink">
                {detecting
                  ? t("Locating…", "लोकेशन ढूंढ रहे हैं…")
                  : t("Use my current location", "मेरी अभी की लोकेशन लें")}
              </span>
              <span className="mt-0.5 block truncate text-[13px] text-muted">
                {status === "granted" && label && !savedActive
                  ? label
                  : t("Detected from your device", "आपके फ़ोन से पता चलेगी")}
              </span>
            </span>
          </button>

          <Link
            href="/profile/addresses"
            className="press flex w-full items-center gap-3 py-3.5 text-left"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink">
              <Plus className="size-5" />
            </span>
            <span className="text-[15px] font-bold">
              {t("Add a new address", "नया पता जोड़ें")}
            </span>
          </Link>
        </div>

        {/* The error is a button, not a caption. It used to be a plain <p>, so
            tapping the message — the obvious thing to do — did nothing at all.
            Tapping it runs `detect()` inside the tap, which is what lets the
            browser show its permission prompt. When the browser has BLOCKED the
            site it will not prompt again whatever we call, so the steps to
            unblock it are spelled out beneath. */}
        {error && !detecting ? (
          <div role="alert" className="mt-3 rounded-xl bg-accent-soft p-3">
            <button
              type="button"
              onClick={() => detect()}
              className="press flex w-full items-start gap-2 text-left text-[14px] font-semibold text-accent-ink"
            >
              <RotateCw className="mt-0.5 size-4 shrink-0" />
              <span>
                {pick(lang, error)}
                <span className="mt-1 block text-[13px] font-bold underline">
                  {t(
                    "Tap here to try again",
                    "फिर से कोशिश करने के लिए यहां दबाएं",
                  )}
                </span>
              </span>
            </button>

            {blocked ? (
              <div className="mt-3 border-t border-line pt-3">
                <p className="text-[13px] font-bold text-ink">
                  {t("How to turn location on:", "लोकेशन कैसे चालू करें:")}
                </p>
                <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[13px] leading-snug text-ink">
                  {locationSettingsSteps(lang).map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="press mt-3 w-full rounded-full border border-accent py-2 text-[14px] font-bold text-accent-ink"
                >
                  {t("Reload page", "पेज फिर से खोलें")}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {candidate ? (
          <div className="mt-3 rounded-xl border border-line bg-surface-2 p-3">
            <p className="text-[13px] font-bold uppercase tracking-[0.08em] text-muted">
              {t("Use this location?", "Use this location?")}
            </p>
            <p className="mt-1 text-[15px] font-extrabold">{candidate.label}</p>
            {candidate.sublabel ? (
              <p className="text-[13px] text-muted">{candidate.sublabel}</p>
            ) : null}
            <p className="mt-2 text-[13px] text-muted">
              {t(
                "Your delivery address stays on your saved address until you confirm.",
                "Your delivery address stays on your saved address until you confirm.",
              )}
            </p>
            {confirmFailed ? (
              <p role="alert" className="mt-2 text-[13px] font-semibold text-accent-ink">
                {t(
                  "Could not save it. Try again.",
                  "Could not save it. Try again.",
                )}
              </p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void confirmCandidate()}
                disabled={confirming}
                className="press flex-1 rounded-full bg-accent py-2.5 text-[14px] font-bold text-white disabled:opacity-60"
              >
                {confirming
                  ? t("Saving…", "Saving…")
                  : t("Save and deliver here", "Save and deliver here")}
              </button>
              <button
                type="button"
                onClick={clearCandidate}
                disabled={confirming}
                className="press rounded-full border border-line px-4 py-2.5 text-[14px] font-bold"
              >
                {t("Not now", "Not now")}
              </button>
            </div>
          </div>
        ) : null}

        <h2 className="pb-1 pt-6 text-[13px] font-bold uppercase tracking-[0.08em] text-muted">
          {t("Saved addresses", "सेव पते")}
        </h2>

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted">
            <LoaderCircle className="size-4 animate-spin" />{" "}
            {t("Loading addresses…", "पते लोड हो रहे हैं…")}
          </p>
        ) : null}
        {!loading && addresses.length === 0 ? (
          <p className="py-6 text-sm text-muted">
            {t(
              "Nothing saved yet. Add an address and it’ll show up here.",
              "अभी कोई पता सेव नहीं है। पता जोड़ें, वह यहां दिखेगा।",
            )}
          </p>
        ) : null}
        {!loading && addresses.length > 0 ? (
          <ul className="divide-y divide-line">
            {addresses.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => chooseSaved(a.id, a.label, a.line)}
                  className="press flex w-full items-start gap-3 py-3.5 text-left"
                >
                  <span
                    className={`mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl ${
                      a.id === selectedId
                        ? "bg-accent text-[var(--on-accent)]"
                        : "bg-surface-2 text-muted"
                    }`}
                  >
                    <MapPin className="size-5" />
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
                    <span className="mt-0.5 block text-[13px] leading-snug text-muted">
                      {a.line}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
