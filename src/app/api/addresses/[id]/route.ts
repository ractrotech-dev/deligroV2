import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { updateAddress, deleteAddress } from "@/lib/data-access/addresses";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { customerFeatureOn, featureOffResponse } from "@/lib/features/guards.server";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** RLS scopes the row; this only bounds how fast one account can churn. */
async function throttle(userId: string): Promise<Response | null> {
  const result = await rateLimit(`addresses:${userId}`, 30, 60_000);
  return result.ok ? null : tooManyRequests(result);
}

/** PATCH /api/addresses/:id — edit or set default. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await customerFeatureOn("customer.saved_addresses"))) return featureOffResponse("customer.saved_addresses");
  const limited = await throttle(user.id);
  if (limited) return limited;
  const { id } = await params;

  let body: { label?: string; line?: string; lat?: number; lng?: number; isDefault?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const ok = await updateAddress(id, body);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

/** DELETE /api/addresses/:id */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await customerFeatureOn("customer.saved_addresses"))) return featureOffResponse("customer.saved_addresses");
  const limited = await throttle(user.id);
  if (limited) return limited;
  const { id } = await params;
  try {
    const ok = await deleteAddress(id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
