import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { replyToMyTicket } from "@/lib/data-access/support";
import { readSupportBody } from "@/lib/support/request-body";

/**
 * POST /api/rider/support/tickets/[id]/messages — the rider replies.
 *
 *   JSON { message } or multipart { message, photos (up to 4) }.
 *   201 { ok: true, id }   A ticket waiting on the rider, resolved or closed
 *                          opens again.
 *   400 invalid_body | invalid_message | too_many_photos | photo_too_large |
 *       bad_photo_type
 *   404 not_found          not this rider's ticket (same as missing)
 *   401 · 403 not_rider · 429 · 503 migration_pending (0087) · 500
 *
 * Rate limit: 20 a minute per rider.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-ticket-reply:${profile.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  const body = await readSupportBody(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });

  try {
    const result = await replyToMyTicket({ id: profile.id, role: "rider" }, id, {
      message: body.fields.message,
      attachments: body.files,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
    }
    return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
  } catch (e) {
    return riderRouteError(e, { route: "/api/rider/support/tickets/[id]/messages", method: "POST", riderId: profile.id, event: "ticket_reply" });
  }
}
