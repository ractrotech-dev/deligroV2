"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, MapPin, Navigation, X } from "lucide-react";
import { loadGoogleMaps } from "@/lib/maps/loader";
import { isMapsConfigured } from "@/lib/maps/config";
import type { TrackPoint } from "@/lib/tracking/rider-position";

/**
 * Directions, inside the app.
 *
 * WHAT THIS IS NOT: turn-by-turn navigation. Google Maps Platform's terms
 * reserve real-time sensor-guided navigation for the Navigation SDK, which is
 * native Android/iOS only — this is a Next.js PWA, so that product is not
 * available to us at any price. What is available, and what this is, is a route
 * *view*: the road drawn, the distance and drive time, and the written turn
 * list. A rider following it is reading a route, not being guided along one.
 *
 * So "Open in Google Maps" stays, as a deliberate second control rather than a
 * fallback nobody finds. A rider who wants a voice in their ear should have it;
 * what they should not have to do is leave the delivery screen — with the OTP,
 * the customer's phone number and the handover button on it — merely to see
 * where they are going.
 *
 * ONE Directions request per destination. The rider's own movement does not
 * re-fetch: continuous re-routing is both the expensive half and the half that
 * edges toward what the terms above restrict.
 */

/** A single written instruction, already stripped of Google's markup. */
interface RouteStep {
  text: string;
  distance: string;
}

interface RouteAnswer {
  steps: RouteStep[];
  distance: string;
  duration: string;
}

/**
 * Google returns each instruction as an HTML fragment (`html_instructions`) —
 * `<b>` around road names, `<div>` for "Destination will be on the left".
 *
 * Parsed to text rather than rendered. It is third-party markup, and the rule
 * that third-party markup never reaches the DOM does not bend because the third
 * party is reputable: `dangerouslySetInnerHTML` here would be a standing XSS
 * sink pointed at a response we do not control. The DOMParser route also gets
 * entity decoding (`&amp;`, `&#39;`) for free, which a regex strip would not.
 */
function toPlainText(html: string): string {
  if (typeof window === "undefined") return html;
  // Block-level tags carry a line break's worth of meaning; without this,
  // "Turn left" and "Destination will be on the right" run together.
  const spaced = html.replace(/<\/?(div|br|p)[^>]*>/gi, " ");
  const doc = new DOMParser().parseFromString(spaced, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function RouteSheet({
  destination,
  destinationLabel,
  origin,
  mapsUrl,
  onClose,
}: {
  /** Where this leg ends. Null when the stop has never been pinned. */
  destination: TrackPoint | null;
  /** The stop's name, for the header — "Saffron Kitchen", "Home". */
  destinationLabel: string;
  /** The rider's live position, from the watch the board already runs. */
  origin: TrackPoint | null;
  /** The Google Maps hand-off, kept as a second control. Null when unbuildable. */
  mapsUrl: string | null;
  onClose: () => void;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  // Derived at render, not set from inside the effect. Whether there is a maps
  // key and whether this stop has a pin are both known before the first paint,
  // so writing them into state from an effect would only schedule a second
  // render to reach a conclusion the first one could already draw. The sheet is
  // mounted fresh per opening, so this initial value is the whole story for its
  // lifetime.
  const routable = isMapsConfigured && Boolean(destination);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    routable ? "loading" : "error"
  );
  const [route, setRoute] = useState<RouteAnswer | null>(null);

  // The origin at the moment the sheet opened. Deliberately frozen: re-running
  // the effect on every GPS fix would re-request Directions every few seconds.
  const openedFrom = useRef(origin);

  useEffect(() => {
    // Already rendered as "error" — nothing to load and nothing to set.
    if (!routable || !destination) return;
    let cancelled = false;

    loadGoogleMaps()
      .then(async () => {
        if (cancelled || !mapEl.current) return;

        const map = new google.maps.Map(mapEl.current, {
          center: destination,
          zoom: 14,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          gestureHandling: "greedy",
        });

        const renderer = new google.maps.DirectionsRenderer({
          map,
          suppressMarkers: false,
          polylineOptions: { strokeColor: "#17b26a", strokeWeight: 5 },
        });

        const from = openedFrom.current;
        if (!from) {
          // No fix yet — show the destination rather than nothing. A rider who
          // just opened the app has not had a GPS lock for long, and a blank
          // sheet is worse than a map of where they are going.
          new google.maps.Marker({ map, position: destination });
          if (!cancelled) setStatus("ready");
          return;
        }

        try {
          const result = await new google.maps.DirectionsService().route({
            origin: from,
            destination,
            // Available in India and routes a bike differently from a car:
            // narrower roads, different turn restrictions. Every Deligro rider
            // is on two wheels.
            travelMode: google.maps.TravelMode.TWO_WHEELER,
          });
          if (cancelled) return;

          renderer.setDirections(result);
          const leg = result.routes[0]?.legs?.[0];
          if (leg) {
            setRoute({
              distance: leg.distance?.text ?? "",
              duration: leg.duration?.text ?? "",
              steps: (leg.steps ?? []).map((step) => ({
                text: toPlainText(step.instructions ?? ""),
                distance: step.distance?.text ?? "",
              })),
            });
          }
          setStatus("ready");
        } catch {
          if (cancelled) return;
          // TWO_WHEELER is not served everywhere. Fall back to driving rather
          // than showing a rider an error over a routing preference.
          try {
            const result = await new google.maps.DirectionsService().route({
              origin: from,
              destination,
              travelMode: google.maps.TravelMode.DRIVING,
            });
            if (cancelled) return;
            renderer.setDirections(result);
            const leg = result.routes[0]?.legs?.[0];
            if (leg) {
              setRoute({
                distance: leg.distance?.text ?? "",
                duration: leg.duration?.text ?? "",
                steps: (leg.steps ?? []).map((step) => ({
                  text: toPlainText(step.instructions ?? ""),
                  distance: step.distance?.text ?? "",
                })),
              });
            }
            setStatus("ready");
          } catch {
            if (!cancelled) setStatus("error");
          }
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [destination, routable]);

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-bg"
      role="dialog"
      aria-modal="true"
      aria-label={`Directions to ${destinationLabel}`}
    >
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close directions"
          className="press grid size-9 shrink-0 place-items-center rounded-full bg-surface-2"
        >
          <X className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-label">Directions</p>
          <p className="truncate text-[15px] font-bold">{destinationLabel}</p>
        </div>
        {route ? (
          <div className="shrink-0 text-right">
            <p className="text-data text-lg font-extrabold leading-none">
              {route.duration}
            </p>
            <p className="text-[11px] font-medium text-muted">
              {route.distance}
            </p>
          </div>
        ) : null}
      </header>

      <div className="relative h-[42%] shrink-0 bg-surface-2">
        <div ref={mapEl} className="absolute inset-0" />
        {status === "loading" ? (
          <div className="absolute inset-0 grid place-items-center">
            <Loader2 className="size-5 animate-spin text-muted" />
          </div>
        ) : null}
        {status === "error" ? (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <p className="text-sm text-muted">
              {destination
                ? "Couldn't load the route here. Open in Google Maps below."
                : "This stop has no map pin, so there's no route to draw. The address is on the job card."}
            </p>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {route && route.steps.length > 0 ? (
          <ol className="space-y-0">
            {route.steps.map((step, i) => (
              <li
                key={`${i}-${step.text}`}
                className="flex items-start gap-3 border-b border-[color:var(--line)] py-3 last:border-0"
              >
                <span className="text-data mt-0.5 w-5 shrink-0 text-right text-xs font-bold text-muted">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm leading-snug">
                  {step.text}
                </span>
                <span className="text-data shrink-0 text-xs text-muted">
                  {step.distance}
                </span>
              </li>
            ))}
          </ol>
        ) : status === "ready" ? (
          <p className="flex items-start gap-2 py-3 text-sm text-muted">
            <MapPin className="mt-0.5 size-4 shrink-0" />
            No written directions for this trip — the route is on the map above.
          </p>
        ) : null}
      </div>

      {/* The escape hatch, and it is never hidden. A rider who wants voice
          guidance has to be able to get to it in one tap from here, not by
          closing the sheet and hunting for another control. */}
      {mapsUrl ? (
        <div className="shrink-0 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="press flex w-full items-center justify-center gap-2 rounded-xl border border-line py-3 text-sm font-semibold"
          >
            <Navigation className="size-4" />
            Open in Google Maps
            <ExternalLink className="size-3.5 text-muted" />
          </a>
        </div>
      ) : null}
    </div>
  );
}
