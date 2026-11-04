import "server-only";

/**
 * Google Places, for the apps that cannot carry the Maps key: the Manager app
 * asks our server, which asks Google. Null means Google could not answer, which
 * covers a missing key, a disabled service, a timeout and a bad response.
 *
 * GOOGLE_MAPS_SERVER_KEY comes first because a browser key restricted by website
 * refuses calls from a server. The public key is the fallback for as long as it
 * has no such restriction.
 */
const KEY = process.env.GOOGLE_MAPS_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
const BASE = "https://maps.googleapis.com/maps/api/place";

export interface PlaceHit {
  placeId: string;
  name: string;
  address: string;
}

export interface PlaceDetails {
  name: string;
  address: string;
  lat: number;
  lng: number;
  pincode: string | null;
}

async function google(path: string, params: Record<string, string>): Promise<Record<string, unknown> | null> {
  if (!KEY) return null;
  const url = new URL(`${BASE}/${path}/json`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", KEY);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Businesses in India matching the text. `session` groups a search for billing. */
export async function searchShopPlaces(q: string, session: string): Promise<PlaceHit[] | null> {
  const json = await google("autocomplete", {
    input: q,
    types: "establishment",
    components: "country:in",
    sessiontoken: session,
  });
  if (json?.status === "ZERO_RESULTS") return [];
  if (json?.status !== "OK") return null;
  const predictions = json.predictions as {
    place_id: string;
    description: string;
    structured_formatting?: { main_text?: string; secondary_text?: string };
  }[];
  return predictions.map((p) => ({
    placeId: p.place_id,
    name: p.structured_formatting?.main_text ?? p.description,
    address: p.structured_formatting?.secondary_text ?? "",
  }));
}

export async function shopPlaceDetails(placeId: string, session: string): Promise<PlaceDetails | null> {
  const json = await google("details", {
    place_id: placeId,
    fields: "name,formatted_address,geometry/location,address_components",
    sessiontoken: session,
  });
  if (json?.status !== "OK") return null;
  const r = json.result as {
    name?: string;
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
    address_components?: { long_name: string; types: string[] }[];
  };
  const lat = r.geometry?.location?.lat;
  const lng = r.geometry?.location?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return {
    name: r.name ?? "",
    address: r.formatted_address ?? "",
    lat,
    lng,
    pincode: r.address_components?.find((c) => c.types.includes("postal_code"))?.long_name ?? null,
  };
}
