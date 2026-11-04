import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { listAddresses, createAddress } from "@/lib/data-access/addresses";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { customerFeatureOn, featureOffResponse } from "@/lib/features/guards.server";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** Bound how fast one account can churn address rows. */
async function throttle(userId: string, limit = 30): Promise<Response | null> {
  const result = await rateLimit(`addresses:${userId}`, limit, 60_000);
  return result.ok ? null : tooManyRequests(result);
}

/**
 * GET /api/addresses — the signed-in user's saved addresses.
 *
 * Still answers with `customer.saved_addresses` off. The new app and the website
 * don't ask while it is off, and an old app that ignores the switch has to be able
 * to deliver to an address it already has: without one it can't order at all.
 * `POST`, `PATCH` and `DELETE` are refused.
 */
export async function GET() {
  if (!isSupabaseConfigured) return NextResponse.json({ addresses: [] });
  if (!(await requireUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ addresses: await listAddresses() });
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

/** POST /api/addresses — add an address. */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await customerFeatureOn("customer.saved_addresses"))) return featureOffResponse("customer.saved_addresses");

  const limited = await throttle(user.id);
  if (limited) return limited;

  let body: { label?: string; line?: string; lat?: number; lng?: number; isDefault?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body.line || body.line.trim().length < 6) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  try {
    const address = await createAddress({
      label: (body.label ?? "Home").trim(),
      line: body.line.trim(),
      lat: body.lat ?? null,
      lng: body.lng ?? null,
      isDefault: body.isDefault,
    });
    return NextResponse.json({ address });
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
