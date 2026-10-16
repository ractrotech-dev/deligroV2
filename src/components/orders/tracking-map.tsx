"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bike, Loader2, Store } from "lucide-react";
import { loadGoogleMaps } from "@/lib/maps/loader";
import { isMapsConfigured, DEFAULT_CENTER } from "@/lib/maps/config";
import type { TrackPoint } from "@/lib/tracking/rider-position";
import { pointAlongPath, progressAlongLine } from "@/lib/tracking/route-path";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

/** What one Directions lookup told us about the trip. */
export interface RoadRoute {
  /** Road distance, km. */
  km: number;
  /** Google's drive time for it, minutes. */
  minutes: number;
}

/**
 * Round the endpoints before keying the route request on them.
 *
 * ~11 m of precision. The destination is a fixed address and the shop is a
 * fixed pin, so in practice this never changes for the life of an order — which
 * is the point. The tracking screen polls every 3 seconds and hands this
 * component fresh object identities each time; without a value key, a route
 * lookup would fire on every poll, roughly 1,200 billed requests over an
 * hour-long delivery.
 */
function endpointKey(a: TrackPoint, b: TrackPoint): string {
  const r = (n: number) => n.toFixed(4);
  return `${r(a.lat)},${r(a.lng)}|${r(b.lat)},${r(b.lng)}`;
}

export function TrackingMap({
  restaurant,
  destination,
  rider,
  showRider,
  snapRiderToRoute = false,
  onRoute,
  className,
  bottomInset = 0,
}: Readonly<{
  /**
   * The shop's pin, or null when the vendor has never set one. Null draws no
   * restaurant marker and no route line — see the origin note in
   * `rider-position.ts`. The map shows the destination alone rather than a
   * route out of a coordinate nobody set.
   */
  restaurant: TrackPoint | null;
  destination: TrackPoint;
  rider: TrackPoint | null;
  showRider: boolean;
  /**
   * Project the courier pin onto the road route instead of drawing it where it
   * was handed to us. True only for an ESTIMATED pin, which is interpolated
   * along a straight line and so is not a measurement of anything. A GPS fix is
   * never moved — see `route-path.ts`.
   */
  snapRiderToRoute?: boolean;
  /** Called once per route lookup, so the screen can use Google's drive time. */
  onRoute?: (route: RoadRoute | null) => void;
  /** Sizing for the map box. Defaults to the strip this used to be fixed at. */
  className?: string;
  /**
   * How much of the map's bottom edge is covered by something in front of it —
   * the tracking screen's drag sheet, in practice. The map is still that tall,
   * so everything that decides what the customer can see subtracts it: the
   * bounds fit, the pan that follows the courier, and the captions that have to
   * be read to mean anything.
   */
  bottomInset?: number;
}>) {
  const t = useT();
  const mapEl = useRef<HTMLDivElement>(null);
  const mapObj = useRef<google.maps.Map | null>(null);
  const restaurantMarker = useRef<google.maps.Marker | null>(null);
  const destMarker = useRef<google.maps.Marker | null>(null);
  const riderMarker = useRef<google.maps.Marker | null>(null);
  const routeLine = useRef<google.maps.Polyline | null>(null);
  const routeKey = useRef<string | null>(null);
  // Held in a ref, and updated in an effect rather than during render, so the
  // route lookup below does not re-run every time the parent passes a fresh
  // callback identity — which it does on every 3-second poll.
  const onRouteRef = useRef(onRoute);
  useEffect(() => {
    onRouteRef.current = onRoute;
  }, [onRoute]);
  /** The courier pan is idempotent: same fix, same inset, no second pan. */
  const panKey = useRef<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    isMapsConfigured ? "loading" : "error",
  );
  /**
   * The road geometry, once Directions has answered. Null means we are drawing
   * the straight line — either the lookup has not returned yet, or it failed
   * (the Directions API is enabled separately from the Maps JS API on the same
   * key, so "map renders, route doesn't" is a real and quiet configuration).
   * `routeFailed` is what tells the customer which of the two they are looking
   * at; a straight line presented as a route is a distance they will believe.
   */
  const [routePath, setRoutePath] = useState<TrackPoint[] | null>(null);
  const [routeFailed, setRouteFailed] = useState(false);

  useEffect(() => {
    if (!isMapsConfigured) return;
    let cancelled = false;

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !mapEl.current) return;

        const center = rider ?? destination ?? DEFAULT_CENTER;
        const map = new google.maps.Map(mapEl.current, {
          center,
          zoom: 15,
          disableDefaultUI: true,
          zoomControl: true,
          // Default is the bottom-right, which on the tracking screen is behind
          // the sheet.
          zoomControlOptions: {
            position: google.maps.ControlPosition.RIGHT_TOP,
          },
          clickableIcons: false,
          gestureHandling: "greedy",
        });
        mapObj.current = map;

        // Both the shop marker and the line between the two ends need a real
        // origin. Without one the map shows where the food is GOING, which is
        // the half we actually know.
        if (restaurant) {
          restaurantMarker.current = new google.maps.Marker({
            map,
            position: restaurant,
            title: t("Restaurant", "रेस्टोरेंट"),
          });
          routeLine.current = new google.maps.Polyline({
            map,
            path: [restaurant, destination],
            strokeColor: "#17b26a",
            strokeOpacity: 0.85,
            strokeWeight: 4,
            geodesic: true,
          });
        }
        destMarker.current = new google.maps.Marker({
          map,
          position: destination,
          title: t("Your location", "आपकी लोकेशन"),
        });

        if (showRider && rider) {
          riderMarker.current = new google.maps.Marker({
            map,
            position: rider,
            title: t("Courier", "राइडर"),
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 10,
              fillColor: "#17b26a",
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 3,
            },
          });
        }

        fitBounds(map, restaurant, destination, rider, null, bottomInset);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
    // One-shot map init
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Where to actually draw the courier.
   *
   * An estimated pin arrives interpolated along the straight line between shop
   * and door — through fields, across the river, whatever lies between. Once
   * there is road geometry, the same fraction of the journey is resolved to a
   * point on the road instead, so the dot follows the route the customer can
   * see. A GPS fix is passed through untouched: it is a measurement, and moving
   * it onto our drawn line would be dressing our guess up as the courier's
   * position.
   */
  const riderPoint = useMemo(() => {
    if (!rider) return null;
    // Snapping measures progress along the shop→door line, so with no shop
    // there is nothing to measure against: show the raw point instead.
    if (!snapRiderToRoute || !routePath || !restaurant) return rider;
    const along = progressAlongLine(restaurant, destination, rider);
    return pointAlongPath(routePath, along) ?? rider;
  }, [rider, snapRiderToRoute, routePath, restaurant, destination]);

  /**
   * One Directions lookup per pair of endpoints — see `endpointKey` for why
   * that is not the same as "per render".
   *
   * This is the whole reason the route is fetched in the browser rather than on
   * the server: the estimate the server computes has to survive a poll every 3
   * seconds, so it uses the distance model in `lib/orders/road-leg.ts` and
   * spends nothing. The customer's screen needs the geometry anyway to draw the
   * road, and once it has that it also has Google's own drive time — so it
   * hands that back through `onRoute` and the headline takes the longer of the
   * two. One billed request per order, at the surface that was already loading
   * a map.
   */
  useEffect(() => {
    if (status !== "ready") return;
    // No origin, no route to ask for — and asking with a stand-in would bill a
    // Directions lookup to draw a road nobody travels.
    if (!restaurant) return;

    const key = endpointKey(restaurant, destination);
    // Set before the request resolves, so a poll landing mid-flight cannot
    // start a second one. A failure is remembered the same way: retrying a
    // rejected key every 3 seconds would bill for the same refusal all delivery.
    if (routeKey.current === key) return;
    routeKey.current = key;

    let cancelled = false;

    new google.maps.DirectionsService()
      .route({
        origin: restaurant,
        destination,
        travelMode: google.maps.TravelMode.DRIVING,
      })
      .then((result) => {
        if (cancelled) return;

        const route = result.routes[0];
        const leg = route?.legs?.[0];
        const path = route?.overview_path;

        if (!leg?.distance || !leg?.duration || !path?.length) {
          // A 200 with no usable route — two points with no road between them,
          // which is a real answer for an address pinned in the middle of a
          // field. The straight line stays, and says so.
          setRouteFailed(true);
          onRouteRef.current?.(null);
          return;
        }

        setRoutePath(path.map((p) => ({ lat: p.lat(), lng: p.lng() })));
        setRouteFailed(false);
        onRouteRef.current?.({
          km: leg.distance.value / 1000,
          minutes: Math.round(leg.duration.value / 60),
        });
      })
      .catch(() => {
        if (cancelled) return;
        setRouteFailed(true);
        onRouteRef.current?.(null);
      });

    return () => {
      cancelled = true;
    };
  }, [status, restaurant, destination]);

  useEffect(() => {
    if (!mapObj.current || status !== "ready") return;

    // Both are created only when there is an origin, so both are absent in the
    // unpinned case and the optional calls simply do nothing.
    if (restaurant) {
      restaurantMarker.current?.setPosition(restaurant);
      routeLine.current?.setPath(routePath ?? [restaurant, destination]);
    }
    destMarker.current?.setPosition(destination);

    if (showRider && riderPoint) {
      if (!riderMarker.current) {
        riderMarker.current = new google.maps.Marker({
          map: mapObj.current,
          position: riderPoint,
          title: t("Courier", "राइडर"),
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: "#17b26a",
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 3,
          },
        });
      } else {
        riderMarker.current.setPosition(riderPoint);
        riderMarker.current.setMap(mapObj.current);
      }
      // Centring puts the courier halfway down a map whose bottom half is
      // behind the sheet. Pan the covered strip back out, and only when the fix
      // actually moved — panning to the same point every three seconds, then
      // shifting it again, is a map that twitches for the whole delivery.
      const key = `${riderPoint.lat},${riderPoint.lng},${bottomInset}`;
      if (panKey.current !== key) {
        panKey.current = key;
        mapObj.current.panTo(riderPoint);
        if (bottomInset > 0)
          mapObj.current.panBy(0, Math.round(bottomInset / 2));
      }
    } else {
      panKey.current = null;
      riderMarker.current?.setMap(null);
    }
  }, [
    restaurant,
    destination,
    riderPoint,
    showRider,
    status,
    routePath,
    bottomInset,
    t,
  ]);

  /**
   * Refit when the road geometry lands — the initial fit spans the two
   * endpoints and the map opens at zoom 15, fine for a doorstep and useless for
   * a 75 km route whose middle is entirely off screen — and when the sheet
   * comes to rest somewhere new, which changes how much map there is to fit
   * into. The first fit is always made with no inset, because the sheet's
   * resting position isn't known until the client has measured the screen.
   *
   * Keyed on those two inputs alone: the 3-second poll hands this component
   * fresh object identities for the same two pins, and refitting on those would
   * yank the customer's zoom back every time it answered.
   */
  const lastFit = useRef<string | null>(null);
  useEffect(() => {
    const map = mapObj.current;
    if (!map || status !== "ready") return;
    const key = `${routePath?.length ?? 0}:${bottomInset}`;
    if (lastFit.current === key) return;
    lastFit.current = key;
    fitBounds(map, restaurant, destination, null, routePath, bottomInset);
  }, [routePath, status, restaurant, destination, bottomInset]);

  if (status === "error") {
    return (
      <TrackingMapFallback
        restaurant={restaurant}
        destination={destination}
        rider={rider}
        showRider={showRider}
        className={className}
        bottomInset={bottomInset}
      />
    );
  }

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden bg-surface-2",
        className ?? "h-56",
      )}
    >
      <div ref={mapEl} className="h-full w-full" />
      {status === "loading" ? (
        <div className="absolute inset-0 grid place-items-center bg-surface-2/70">
          <Loader2 className="size-6 animate-spin text-muted" />
        </div>
      ) : null}
      {/* The map rendered but Directions did not answer, so the green line is
          the straight one. Said out loud for the same reason the no-SDK
          fallback says it: on a real map, a line between two pins reads as a
          route, and a customer measuring their delivery off it would be
          measuring a line no vehicle can drive. */}
      {routeFailed ? (
        <p
          style={{ bottom: bottomInset }}
          className="absolute inset-x-0 bg-surface/85 px-3 py-1.5 text-[11px] font-medium leading-snug text-muted"
        >
          {t(
            "Road route unavailable — the line is direct, not along roads.",
            "सड़क का रास्ता नहीं मिला — यह सीधी लाइन है, सड़क के रास्ते नहीं।",
          )}
        </p>
      ) : null}
    </div>
  );
}

function fitBounds(
  map: google.maps.Map,
  restaurant: TrackPoint | null,
  destination: TrackPoint,
  rider: TrackPoint | null,
  routePath?: TrackPoint[] | null,
  bottomInset = 0,
) {
  const bounds = new google.maps.LatLngBounds();
  // An unpinned shop contributes nothing to the box — the destination and any
  // real rider fix are the only points we can actually place.
  if (restaurant) bounds.extend(restaurant);
  bounds.extend(destination);
  if (rider) bounds.extend(rider);
  // A road route can bulge well outside the box its two ends describe.
  if (routePath) for (const p of routePath) bounds.extend(p);
  // Per-edge, so the box is fitted into the part of the map that is not behind
  // the sheet. A uniform inset centres a 70 km route on a covered midpoint.
  map.fitBounds(bounds, {
    top: 48,
    right: 48,
    left: 48,
    bottom: 48 + bottomInset,
  });
}

/** Where a point sits inside the padded bounding box, as CSS percentages. */
interface Placed {
  left: string;
  top: string;
}

/**
 * Project real coordinates onto the panel, so every marker keeps its true
 * position relative to the others. A degenerate span (one point, or several at
 * the same place) collapses to the centre rather than dividing by zero.
 */
function placer(points: TrackPoint[]): (p: TrackPoint) => Placed {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;

  // Inset so a marker at an extreme isn't half outside the panel.
  const PAD = 18;
  const SPAN = 100 - PAD * 2;

  return (p) => ({
    left: `${lngSpan === 0 ? 50 : PAD + ((p.lng - minLng) / lngSpan) * SPAN}%`,
    // North is up, so the highest latitude gets the smallest `top`.
    top: `${latSpan === 0 ? 50 : PAD + ((maxLat - p.lat) / latSpan) * SPAN}%`,
  });
}

/**
 * What we can honestly draw with no Maps SDK: the restaurant, the destination
 * and — when there is one — the courier, each at its real coordinates, plus the
 * straight line between the two fixed ends.
 *
 * It used to draw a decorative grid and walk the courier marker along
 * `left = 28 + offset*42%`, `top = 18 + sin(offset·2π)*8%`, on a 400 ms timer,
 * with `rider` used only as a truthiness check and its actual coordinates
 * discarded. Since `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is unset, that was the
 * production path: for the whole delivery a customer watched a dot that moved
 * while the courier stood still and stood still nowhere near the courier — and
 * the "this is an estimate" caption in `tracking-view` is suppressed exactly
 * when the rider IS sharing GPS, so the invention was least disclosed in the
 * case where it was most wrong.
 *
 * This is a schematic, not a map: it has no roads and the line is not a route.
 * The caption says so, because a customer reading distance off it would
 * otherwise be reading a straight line as a journey.
 */
function TrackingMapFallback({
  restaurant,
  destination,
  rider,
  showRider,
  className,
  bottomInset = 0,
}: Readonly<{
  restaurant: TrackPoint | null;
  destination: TrackPoint;
  rider: TrackPoint | null;
  showRider: boolean;
  className?: string;
  bottomInset?: number;
}>) {
  const t = useT();
  const courier = showRider && rider ? rider : null;
  const place = placer([
    ...(restaurant ? [restaurant] : []),
    destination,
    ...(courier ? [courier] : []),
  ]);
  // No pin, no shop marker and no line to it — the same rule the live map
  // follows. The schematic then shows the destination and any real rider fix.
  const shop = restaurant ? place(restaurant) : null;
  const home = place(destination);
  const bike = courier ? place(courier) : null;

  return (
    <div
      className={cn(
        "relative overflow-hidden bg-[linear-gradient(135deg,#e6f4ec,#eef1f2)]",
        className ?? "h-56",
      )}
    >
      {/* The schematic is laid out in percentages, so it is confined to the
          strip that is actually on screen rather than to the box — half of
          which can be behind the tracking sheet. Without this the courier and
          the door are projected into a band nobody can see. */}
      <div className="absolute inset-x-0 top-0" style={{ bottom: bottomInset }}>
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {/* Stroked via `style`, not a `stroke` attribute: a CSS variable is
            only valid in a style declaration, and `stroke="var(--line)"` as a
            presentation attribute simply doesn't paint. */}
          {shop ? (
            <line
              x1={Number.parseFloat(shop.left)}
              y1={Number.parseFloat(shop.top)}
              x2={Number.parseFloat(home.left)}
              y2={Number.parseFloat(home.top)}
              style={{ stroke: "var(--line)" }}
              strokeWidth="0.6"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>

        {shop ? (
          <Marker at={shop} label={t("Restaurant", "रेस्टोरेंट")}>
            <span className="grid size-7 place-items-center rounded-full bg-surface text-ink ring-4 ring-white/70">
              <Store className="size-3.5" />
            </span>
          </Marker>
        ) : null}

        <Marker at={home} label={t("Your location", "आपकी लोकेशन")}>
          <span className="grid size-7 place-items-center rounded-full bg-ink text-bg ring-4 ring-white/70">
            <span className="size-2 rounded-full bg-bg" />
          </span>
        </Marker>

        {bike ? (
          <Marker at={bike} label={t("Courier", "राइडर")}>
            <span className="grid size-8 place-items-center rounded-full bg-accent text-[var(--on-accent)] ring-4 ring-white/70">
              <Bike className="size-4" />
            </span>
          </Marker>
        ) : null}
      </div>

      <p
        style={{ bottom: bottomInset }}
        className="absolute inset-x-0 bg-surface/85 px-3 py-1.5 text-[11px] font-medium leading-snug text-muted"
      >
        {t(
          "No map available — positions shown in a straight line, not along roads.",
          "मैप उपलब्ध नहीं है — जगहें सीधी लाइन में दिखाई गई हैं, सड़क के रास्ते नहीं।",
        )}
      </p>
    </div>
  );
}

/** Centres its child on a projected point. */
function Marker({
  at,
  label,
  children,
}: Readonly<{
  at: Placed;
  label: string;
  children: React.ReactNode;
}>) {
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: at.left, top: at.top }}
      title={label}
    >
      {children}
    </div>
  );
}
