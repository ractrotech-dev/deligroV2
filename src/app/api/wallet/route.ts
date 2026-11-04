import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getMyWallet } from "@/lib/data-access/wallet";
import { captureError } from "@/lib/obs/emit";

/**
 * GET /api/wallet?cursor=ISO — the signed-in customer's wallet: balance and history,
 * newest first. The customer is the session and nothing in the request: there is no
 * parameter with which to ask for anyone else's.
 *
 * The balance column isn't granted to `authenticated` (0197), so this is how a customer
 * reads it. Writes aren't here: points move only through the delivery and order paths.
 *
 *   200 { wallet: { enabled, balance, moves[], nextCursor } }
 *   401 unauthorized · 429 · 500 server_error · 503 backend_not_configured
 */
export async function GET(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const limit = await rateLimit(`wallet-read:${user.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const raw = new URL(request.url).searchParams.get("cursor");
  const cursor = raw && Number.isFinite(Date.parse(raw)) ? raw : null;

  try {
    const wallet = await getMyWallet(user.id, { cursor });
    return NextResponse.json({ wallet });
  } catch (e) {
    captureError(e, { source: "wallet/read", attrs: { event: "wallet_read_failed" } });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
