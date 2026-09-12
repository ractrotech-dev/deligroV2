/**
 * Minimal ambient declarations for the slice of the Google Maps JS API we use
 * (map + draggable marker + geocoder + places autocomplete + directions). Kept
 * in-repo so we don't have to pull the full @types/google.maps package for a
 * few classes.
 */
declare namespace google.maps {
  class LatLng {
    constructor(lat: number, lng: number);
    lat(): number;
    lng(): number;
  }
  interface LatLngLiteral {
    lat: number;
    lng: number;
  }
  interface MapMouseEvent {
    latLng: LatLng | null;
  }
  interface MapsEventListener {
    remove(): void;
  }
  interface MapOptions {
    center?: LatLngLiteral | LatLng;
    zoom?: number;
    disableDefaultUI?: boolean;
    zoomControl?: boolean;
    clickableIcons?: boolean;
    gestureHandling?: string;
    mapTypeControl?: boolean;
    streetViewControl?: boolean;
    fullscreenControl?: boolean;
  }
  interface MarkerOptions {
    map?: Map;
    position?: LatLngLiteral | LatLng;
    draggable?: boolean;
    title?: string;
    icon?: SymbolIcon;
  }
  interface SymbolIcon {
    path?: SymbolPath | string;
    scale?: number;
    fillColor?: string;
    fillOpacity?: number;
    strokeColor?: string;
    strokeWeight?: number;
  }
  enum SymbolPath {
    CIRCLE = 0,
  }
  class Marker {
    constructor(opts?: MarkerOptions);
    setPosition(pos: LatLngLiteral | LatLng): void;
    getPosition(): LatLng | null | undefined;
    setMap(map: Map | null): void;
    addListener(event: string, handler: (e: MapMouseEvent) => void): MapsEventListener;
  }
  interface PolylineOptions {
    map?: Map;
    path?: (LatLngLiteral | LatLng)[];
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
    geodesic?: boolean;
  }
  class Polyline {
    constructor(opts?: PolylineOptions);
    setPath(path: (LatLngLiteral | LatLng)[]): void;
  }
  class LatLngBounds {
    constructor();
    extend(point: LatLngLiteral | LatLng): void;
  }
  class Map {
    constructor(el: HTMLElement, opts?: MapOptions);
    panTo(pos: LatLngLiteral | LatLng): void;
    setZoom(zoom: number): void;
    fitBounds(bounds: LatLngBounds, padding?: number): void;
    addListener(event: string, handler: (e: MapMouseEvent) => void): MapsEventListener;
  }
  interface GeocoderRequest {
    location?: LatLngLiteral | LatLng;
  }
  interface GeocoderAddressComponent {
    long_name: string;
    short_name: string;
    types: string[];
  }
  interface GeocoderResult {
    formatted_address: string;
    address_components: GeocoderAddressComponent[];
    types: string[];
  }
  interface GeocoderResponse {
    results: GeocoderResult[];
  }
  class Geocoder {
    geocode(request: GeocoderRequest): Promise<GeocoderResponse>;
  }

  /**
   * Directions — the road route the tracking map draws, and the drive time it
   * quotes. Note the Directions API is enabled separately from the Maps JS API
   * in the Google Cloud console, on the same key: a project can render a map
   * perfectly and have every `route()` call rejected.
   */
  enum TravelMode {
    DRIVING = "DRIVING",
    /**
     * Two-wheeler routing. Served in India (and a handful of other regions) and
     * not everywhere else, so a caller must be ready for the request to be
     * rejected and fall back to DRIVING — see `driver/route-sheet.tsx`.
     */
    TWO_WHEELER = "TWO_WHEELER",
  }
  interface DirectionsRequest {
    origin: LatLngLiteral | LatLng;
    destination: LatLngLiteral | LatLng;
    travelMode: TravelMode;
  }
  /** `value` is metres; `text` is Google's own localised phrasing. */
  interface Distance {
    text: string;
    value: number;
  }
  /** `value` is seconds. */
  interface Duration {
    text: string;
    value: number;
  }
  /**
   * One written instruction. `instructions` is an HTML FRAGMENT, not text —
   * Google marks road names with `<b>` and separates clauses with `<div>`.
   * Typed as the string it is so no caller mistakes it for something safe to
   * render; `route-sheet.tsx` parses it to text rather than injecting it.
   */
  interface DirectionsStep {
    instructions?: string;
    distance?: Distance;
    duration?: Duration;
  }
  interface DirectionsLeg {
    distance?: Distance;
    duration?: Duration;
    steps?: DirectionsStep[];
  }
  interface DirectionsRoute {
    legs: DirectionsLeg[];
    /** The route simplified for drawing — what the polyline follows. */
    overview_path: LatLng[];
  }
  interface DirectionsResult {
    routes: DirectionsRoute[];
  }
  class DirectionsService {
    route(request: DirectionsRequest): Promise<DirectionsResult>;
  }
  interface DirectionsRendererOptions {
    map?: Map;
    suppressMarkers?: boolean;
    polylineOptions?: PolylineOptions;
  }
  /**
   * Draws a DirectionsResult onto a map — the road geometry, and (unless
   * suppressed) Google's own A/B markers. Used by the rider's route sheet,
   * which wants both.
   */
  class DirectionsRenderer {
    constructor(options?: DirectionsRendererOptions);
    setDirections(result: DirectionsResult): void;
    setMap(map: Map | null): void;
  }
  namespace places {
    interface PlaceGeometry {
      location?: LatLng;
    }
    interface PlaceResult {
      geometry?: PlaceGeometry;
      formatted_address?: string;
      name?: string;
    }
    interface AutocompleteOptions {
      fields?: string[];
      componentRestrictions?: { country: string | string[] };
      types?: string[];
    }
    class Autocomplete {
      constructor(input: HTMLInputElement, opts?: AutocompleteOptions);
      getPlace(): PlaceResult;
      addListener(event: string, handler: () => void): MapsEventListener;
    }
  }
}
