import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { issueChangeCode } from "@/lib/data-access/wallet";
import { walletCodeMessage } from "@/lib/wallet/money";
import { captureError } from "@/lib/obs/emit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/orders/:id/wallet-code — the customer gets the code they read out to a
 * rider with no change. Only for their own order, only while it is out for delivery
 * with cash due; the database decides (wallet_issue_change_code, 0198).
 *
 * The answer is the only place the code exists: it is stored as a hash. Asking again
 * makes a new code and kills the old one, and does not reset the wrong tries.
 *
 *   200 { code, expiresAt }
 *   401 unauthorized · 404 not_found · 409 { error, message } · 429 · 500
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const limit = await rateLimit(`wallet-code:${user.id}`, 10, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const result = await issueChangeCode(user.id, id);
    if (result.ok) {
      return NextResponse.json({ code: result.code, expiresAt: result.expiresAt });
    }
    if (result.error === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: result.error, message: walletCodeMessage(result.error) },
      { status: 409 },
    );
  } catch (e) {
    captureError(e, { source: "wallet/code", orderId: id, attrs: { event: "wallet_code_failed" } });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
