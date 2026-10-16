import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { submitReview } from "@/lib/data-access/reviews";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

/** The HTTP status for a refused review. */
function reviewErrorStatus(error?: string): number {
  if (error === "unauthorized") return 401;
  if (error === "not_found") return 404;
  return 400;
}

/** POST /api/reviews  { orderId, rating, comment? } */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });

  // submitReview re-checks ownership; this only stops one account hammering the
  // endpoint to probe which order ids exist.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const limit = await rateLimit(`reviews:${user.id}`, 20, 60_000);
    if (!limit.ok) return tooManyRequests(limit);
  }

  let body: { orderId?: string; rating?: number; comment?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body.orderId || !body.rating) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const result = await submitReview(body.orderId, body.rating, body.comment);
  if (!result.ok) {
    const status = reviewErrorStatus(result.error);
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
