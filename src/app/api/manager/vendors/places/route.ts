import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { searchShopPlaces, shopPlaceDetails } from "@/lib/maps/places.server";

const SESSION = /^[0-9a-f-]{36}$/i;
const PLACE_ID = /^[\w-]{1,300}$/;

/**
 * GET /api/manager/vendors/places?q=&session=        → { results: PlaceHit[] }
 * GET /api/manager/vendors/places?placeId=&session=  → { place: PlaceDetails }
 *
 * Finds a shop on Google Maps while onboarding it, so its address and pin can be
 * filled in. Only for managers who can onboard. Rate-limited although it is a
 * read, because each call is billed to the platform's Google account.
 *
 * → 400 bad_request   → 403 permission_denied   → 429
 * → 404 not_found (no such place)   → 503 places_unavailable (Google gave no answer)
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.vendors.onboard");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "vendor-places", 60);
  if (limited) return limited;

  const url = new URL(request.url);
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION.test(session)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const placeId = url.searchParams.get("placeId");
  if (placeId !== null) {
    if (!PLACE_ID.test(placeId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const place = await shopPlaceDetails(placeId, session);
    return place
      ? NextResponse.json({ place })
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 120) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const results = await searchShopPlaces(q, session);
  return results
    ? NextResponse.json({ results })
    : NextResponse.json({ error: "places_unavailable" }, { status: 503 });
}
