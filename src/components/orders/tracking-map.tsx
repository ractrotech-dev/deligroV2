"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bike, Loader2, Store } from "lucide-react";
import { loadGoogleMaps } from "@/lib/maps/loader";
import { isMapsConfigured, DEFAULT_CENTER } from "@/lib/maps/config";
import type { TrackPoint } from "@/lib/tracking/rider-position";
import { pointAlongPath, progressAlongLine } from "@/lib/tracking/route-path";

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
}: {
  restaurant: TrackPoint;
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
}) {
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
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    isMapsConfigured ? "loading" : "error"
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
          clickableIcons: false,
          gestureHandling: "greedy",
        });
        mapObj.current = map;

        restaurantMarker.current = new google.maps.Marker({
          map,
          position: restaurant,
          title: "Restaurant",
        });
        destMarker.current = new google.maps.Marker({
          map,
          position: destination,
          title: "Your location",
        });
        routeLine.current = new google.maps.Polyline({
          map,
          path: [restaurant, destination],
          strokeColor: "#17b26a",
          strokeOpacity: 0.85,
          strokeWeight: 4,
          geodesic: true,
        });

        if (showRider && rider) {
          riderMarker.current = new google.maps.Marker({
            map,
            position: rider,
            title: "Courier",
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

        fitBounds(map, restaurant, destination, rider);
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
    if (!snapRiderToRoute || !routePath) return rider;
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

    restaurantMarker.current?.setPosition(restaurant);
    destMarker.current?.setPosition(destination);
    routeLine.current?.setPath(routePath ?? [restaurant, destination]);

    if (showRider && riderPoint) {
      if (!riderMarker.current) {
        riderMarker.current = new google.maps.Marker({
          map: mapObj.current,
          position: riderPoint,
          title: "Courier",
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
      mapObj.current.panTo(riderPoint);
    } else {
      riderMarker.current?.setMap(null);
    }
  }, [restaurant, destination, riderPoint, showRider, status, routePath]);

  /**
   * Refit once the road geometry lands. The initial fit spans the two endpoints
   * and the map opens at zoom 15 — fine for a doorstep, useless for a 75 km
   * route whose middle is entirely off screen.
   */
  useEffect(() => {
    if (!mapObj.current || status !== "ready" || !routePath) return;
    fitBounds(mapObj.current, restaurant, destination, null, routePath);
  }, [routePath, status, restaurant, destination]);

  if (status === "error") {
    return (
      <TrackingMapFallback
        restaurant={restaurant}
        destination={destination}
        rider={rider}
        showRider={showRider}
      />
    );
  }

  return (
    <div className="relative h-56 w-full overflow-hidden bg-surface-2">
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
        <p className="absolute inset-x-0 bottom-0 bg-surface/85 px-3 py-1.5 text-[10px] font-medium leading-snug text-muted">
          Road route unavailable — the line is direct, not along roads.
        </p>
      ) : null}
    </div>
  );
}

function fitBounds(
  map: google.maps.Map,
  restaurant: TrackPoint,
  destination: TrackPoint,
  rider: TrackPoint | null,
  routePath?: TrackPoint[] | null
) {
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(restaurant);
  bounds.extend(destination);
  if (rider) bounds.extend(rider);
  // A road route can bulge well outside the box its two ends describe.
  if (routePath) for (const p of routePath) bounds.extend(p);
  map.fitBounds(bounds, 48);
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
}: {
  restaurant: TrackPoint;
  destination: TrackPoint;
  rider: TrackPoint | null;
  showRider: boolean;
}) {
  const courier = showRider && rider ? rider : null;
  const place = placer([restaurant, destination, ...(courier ? [courier] : [])]);
  const shop = place(restaurant);
  const home = place(destination);
  const bike = courier ? place(courier) : null;

  return (
    <div className="relative h-56 overflow-hidden bg-[linear-gradient(135deg,#e6f4ec,#eef1f2)]">
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {/* Stroked via `style`, not a `stroke` attribute: a CSS variable is
            only valid in a style declaration, and `stroke="var(--line)"` as a
            presentation attribute simply doesn't paint. */}
        <line
          x1={parseFloat(shop.left)}
          y1={parseFloat(shop.top)}
          x2={parseFloat(home.left)}
          y2={parseFloat(home.top)}
          style={{ stroke: "var(--line)" }}
          strokeWidth="0.6"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <Marker at={shop} label="Restaurant">
        <span className="grid size-7 place-items-center rounded-full bg-surface text-ink ring-4 ring-white/70">
          <Store className="size-3.5" />
        </span>
      </Marker>

      <Marker at={home} label="Your location">
        <span className="grid size-7 place-items-center rounded-full bg-ink text-bg ring-4 ring-white/70">
          <span className="size-2 rounded-full bg-bg" />
        </span>
      </Marker>

      {bike ? (
        <Marker at={bike} label="Courier">
          <span className="grid size-8 place-items-center rounded-full bg-accent text-[var(--on-accent)] ring-4 ring-white/70">
            <Bike className="size-4" />
          </span>
        </Marker>
      ) : null}

      <p className="absolute inset-x-0 bottom-0 bg-surface/85 px-3 py-1.5 text-[10px] font-medium leading-snug text-muted">
        No map available — positions shown in a straight line, not along roads.
      </p>
    </div>
  );
}

/** Centres its child on a projected point. */
function Marker({
  at,
  label,
  children,
}: {
  at: Placed;
  label: string;
  children: React.ReactNode;
}) {
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
