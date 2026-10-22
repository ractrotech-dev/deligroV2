import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getMyTicket } from "@/lib/data-access/support";

/**
 * GET /api/rider/support/tickets/[id] — one of the rider's tickets and its
 * thread: the rider's messages and staff replies, never internal notes, each
 * photo as a 10-minute signed URL.
 *
 *   200 { ticket: { id, number, category, categoryLabel, priority, subject,
 *                   status, statusLabel, orderId, orderCode, createdAt,
 *                   updatedAt, resolvedAt, lat, lng, locationUrl },
 *         messages: { id, body, fromStaff, authorRole,
 *                     attachments: { url }[], createdAt }[] }
 *   404 not_found  — not this rider's ticket, or no such ticket (one answer,
 *                    and no URL is ever signed for someone else's photos)
 *   401 · 403 not_rider · 429 · 503 migration_pending (0087) · 500
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-tickets:${profile.id}`, 120, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  try {
    const thread = await getMyTicket(profile.id, id);
    if (!thread) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(thread, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return riderRouteError(e, { route: "/api/rider/support/tickets/[id]", method: "GET", riderId: profile.id, event: "ticket_thread" });
  }
}
