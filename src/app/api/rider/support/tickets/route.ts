import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { createTicket, listMyTickets } from "@/lib/data-access/support";
import { readSupportBody } from "@/lib/support/request-body";
import { RIDER_TICKET_CATEGORIES, SAFETY_CATEGORIES, categoryLabel, defaultPriority } from "@/lib/support/rules";
import { isFeatureOn } from "@/lib/features/flags.server";
import { featureOffResponse } from "@/lib/features/guards.server";

const ROUTE = "/api/rider/support/tickets";

/**
 * GET /api/rider/support/tickets — the rider's tickets (newest activity
 * first), Deligro's support numbers and the category lists in §13.3 order.
 *
 *   200 { tickets: TicketSummary[], contact: { phone, whatsapp },
 *         categories: { key, label }[], safetyCategories: { key, label }[] }
 *   401 · 403 not_rider · 429 · 503 migration_pending (0087) · 500
 *
 * With `driver.support` off the answer is still 200, with `tickets: []`: the
 * support numbers are what the app keeps on the phone for an SOS with no
 * signal, and a switch for ordinary tickets must never cost the rider that.
 */
export async function GET() {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-tickets:${profile.id}`, 120, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    const supportOn = await isFeatureOn("driver.support", profile.id);
    const [tickets, settings] = await Promise.all([
      supportOn ? listMyTickets(profile.id) : Promise.resolve([]),
      getSettings(),
    ]);
    return NextResponse.json(
      {
        tickets,
        contact: { phone: settings.supportPhone || null, whatsapp: settings.supportWhatsapp || null },
        categories: RIDER_TICKET_CATEGORIES.map((key) => ({ key, label: categoryLabel(key) })),
        safetyCategories: SAFETY_CATEGORIES.map((key) => ({ key, label: categoryLabel(key) })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return riderRouteError(e, { route: ROUTE, method: "GET", riderId: profile.id, event: "list_tickets" });
  }
}

/**
 * POST /api/rider/support/tickets — raise a ticket with its first message.
 *
 *   JSON { category, subject?, message, orderId?, lat?, lng? }, or multipart
 *   with the same fields and up to 4 photos under `photos` (JPEG/PNG, 5 MB
 *   each, magic-byte checked).
 *
 *   201 { ok: true, id, number, priority }
 *       An emergency category (accident_emergency, a safety report) is filed
 *       as an SOS: deduplicated, and every manager and admin is rung.
 *   400 invalid_body | invalid_category | invalid_subject | invalid_message |
 *       invalid_order (not an order this rider delivered) |
 *       too_many_photos | photo_too_large | bad_photo_type
 *   401 · 403 not_rider · 429 · 503 migration_pending (0087) · 500
 *
 * Rate limit: 10 a minute per rider.
 *
 * `driver.support` off -> 403 feature_disabled for an ordinary ticket. An
 * emergency (`accident_emergency`, any safety report) is always accepted: a
 * safety report has no switch.
 */
export async function POST(request: Request) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-ticket:${profile.id}`, 10, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const body = await readSupportBody(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const f = body.fields;
  if (defaultPriority(String(f.category ?? "")) !== "emergency" && !(await isFeatureOn("driver.support", profile.id))) {
    return featureOffResponse("driver.support");
  }

  try {
    const result = await createTicket(
      { id: profile.id, role: "rider" },
      {
        category: f.category,
        subject: f.subject,
        message: f.message,
        orderId: f.orderId,
        lat: f.lat,
        lng: f.lng,
        attachments: body.files,
      }
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(
      { ok: true, id: result.id, number: result.number, priority: result.priority },
      { status: 201 }
    );
  } catch (e) {
    return riderRouteError(e, { route: ROUTE, method: "POST", riderId: profile.id, event: "create_ticket" });
  }
}
