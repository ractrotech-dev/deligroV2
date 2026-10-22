import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { PHOTO_REMOVED_TEXT, getCustomerProofUrl } from "@/lib/data-access/order-proof";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/orders/:id/proof
 *
 * The proof-of-delivery photo the rider took at the door, as a 10-minute
 * signed URL from the private `delivery-proofs` bucket. For the customer who
 * placed the order and no one else — the rider and ops reach the photo through
 * their own paths.
 *
 *   200 { url, expiresIn }
 *   200 { url: null, removed: true, message: "Photo removed after 90 days" }
 *                           the photo was deleted under the 90-day retention
 *                           rule (ruling P8-R4) — said plainly, not an error
 *   400 invalid_order
 *   401 unauthorized
 *   403 forbidden           not this customer's order (or no such order)
 *   404 not_found           no photo for this order
 *   429 rate limited
 *   503 migration_pending   no `delivery-proofs` bucket yet (0082)
 *
 * Rate limit: 30 a minute per customer — one tap on the link, never a poll.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const limit = await rateLimit(`order-proof:${user.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "invalid_order" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await getCustomerProofUrl(id, user.id);
    if (result.ok) {
      return NextResponse.json(
        { url: result.url, expiresIn: result.expiresIn },
        { headers: NO_STORE }
      );
    }
    switch (result.error) {
      case "forbidden":
        return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
      case "no_photo":
        return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
      case "photo_removed":
        return NextResponse.json(
          { url: null, removed: true, message: PHOTO_REMOVED_TEXT },
          { headers: NO_STORE }
        );
      case "migration_pending":
        return NextResponse.json({ error: "migration_pending" }, { status: 503, headers: NO_STORE });
    }
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}
