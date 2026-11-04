import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getVendorPaymentRulesBySlug } from "@/lib/payments/vendor-rules";
import { DEFAULT_PAYMENT_RULES } from "@/lib/payments/cod-rules";

/**
 * GET /api/restaurants/:slug/payment-options
 *
 * Which payment methods this shop takes, and its cash ceiling. The checkout
 * screen only learns which restaurant the basket belongs to on the client (it
 * lives in the cart store), so the page cannot resolve this server-side the way
 * it resolves the platform-wide toggle — hence a small read endpoint.
 *
 * This is advisory. /api/orders re-resolves the same rules from the database
 * and refuses the order itself, so a stale or tampered response here changes
 * what the customer is SHOWN, never what they are allowed to do.
 *
 * Deliberately not rate-limited beyond what the platform provides: it is a read
 * of three booleans that migration 0034 grants to `anon` outright, and the
 * checkout calls it once per basket. AGENTS.md §6 asks for a limit on every
 * write endpoint; this writes nothing.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  // No backend configured is the demo path — answer with the permissive
  // default rather than an error, so the checkout still renders.
  if (!isSupabaseConfigured || !slug) {
    return NextResponse.json({ rules: DEFAULT_PAYMENT_RULES });
  }

  try {
    const rules = await getVendorPaymentRulesBySlug(slug);
    // An admin who changes the cash limit expects the next checkout to show it.
    return NextResponse.json({ rules }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // A failed lookup must not silently widen what is on offer. Cash only is
    // the narrow answer here: it is the method that needs no platform
    // integration, and the order API will refuse anything it shouldn't allow.
    return NextResponse.json(
      { rules: { acceptCod: true, acceptOnline: false, codMaxOrder: 0 } },
      { status: 200 }
    );
  }
}
