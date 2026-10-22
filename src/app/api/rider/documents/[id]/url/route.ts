import { profileJson, profileRouteError, riderProfileGate } from "@/lib/auth/rider-profile-route";
import { SIGNED_URL_SECONDS, riderDocumentUrl } from "@/lib/data-access/rider-profile";

const ROUTE = "/api/rider/documents/[id]/url";

/**
 * GET /api/rider/documents/:id/url — a 10-minute signed link to one of the
 * rider's own documents, to view it.
 *
 *   200 { url, expiresIn: 600 }
 *   404 not_found   not this rider's, replaced, malformed or absent — all alike,
 *                   and nothing is signed (Review Focus 2)
 *   401 · 403 not_rider · 429 · 503 migration_pending · 500
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await riderProfileGate(ROUTE, { write: false, perMinute: 30 });
  if (!gate.ok) return gate.response;
  const { id } = await params;
  try {
    const url = await riderDocumentUrl(gate.driverId, id);
    if (!url) return profileJson({ error: "not_found" }, 404);
    return profileJson({ url, expiresIn: SIGNED_URL_SECONDS });
  } catch (e) {
    return profileRouteError(e, ROUTE, "GET", gate.driverId);
  }
}
