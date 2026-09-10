import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getSettings } from "@/lib/settings";
import { checkServiceArea, type ServiceArea } from "@/lib/geo/service-area";

/**
 * GET /api/restaurants/:slug/serviceability?lat=&lng=
 *
 * Whether this shop delivers to that pin. The checkout screen only learns which
 * restaurant the basket belongs to on the client (it lives in the cart store),
 * and the pin changes as the customer picks addresses — so this is a read
 * endpoint for the same reason `payment-options` next door is one.
 *
 * Advisory, exactly like that endpoint: `createOrder` re-runs `checkServiceArea`
 * against the address actually submitted and refuses the order itself, so a
 * stale or tampered answer here changes what the customer is SHOWN, never what
 * they are allowed to do.
 *
 * Writes nothing, so no rate limit (AGENTS.md §6). It reveals only whether one
 * point is within a published radius of a public shop.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));

  // The old single `unknown` fallback covered both branches below. They are not
  // the same thing, and now that `unverifiable` greys out the checkout button
  // the difference is visible to a customer.
  const area = (
    status: ServiceArea["status"],
    reason?: ServiceArea["reason"]
  ): ServiceArea => ({ status, distanceKm: null, radiusKm: 0, reason });

  // No backend at all — the demo build. There is no radius to enforce and no
  // `createOrder` to reach, so refusing here would only break the demo without
  // protecting anything. Permissive on purpose, and safe because this endpoint
  // is advisory: the real gate re-runs the check server-side.
  if (!isSupabaseConfigured || !slug) {
    return NextResponse.json({ area: area("unlimited") });
  }

  // The customer has not put their address on the map yet. That is precisely
  // `address_unpinned` — say so, so the checkout can ask them to pick a
  // location rather than telling them they are out of range.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({
      area: area("unverifiable", "address_unpinned"),
    });
  }

  try {
    const supabase = await createClient();
    const [{ data: restaurant }, settings] = await Promise.all([
      supabase
        .from("restaurants")
        .select("lat, lng")
        .eq("slug", slug)
        .eq("approved", true)
        .maybeSingle(),
      getSettings(),
    ]);

    return NextResponse.json({
      area: checkServiceArea({
        shop: restaurant,
        destination: { lat, lng },
        radiusKm: settings.deliveryRadiusKm,
      }),
    });
  } catch {
    // "We couldn't check" is not "you're out of range". Saying the latter would
    // talk a customer out of an order they could have had; the order API is the
    // gate that actually decides, and it re-checks with data it can read.
    //
    // Still permissive after the fail-closed change, and deliberately: this is a
    // TRANSIENT read failure, not a missing pin. Blocking here would grey out
    // checkout on a network blip, while `createOrder` — which now refuses an
    // unverifiable area outright — is the decision that actually protects the
    // radius. Advisory endpoints do not need to fail closed when the gate behind
    // them does; they need to not lie, which is why this does not claim
    // `in_range` either.
    return NextResponse.json({ area: area("unlimited") });
  }
}
