import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { addFavorite, removeFavorite } from "@/lib/data-access/favorites";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

/**
 * Both verbs are cheap writes but unbounded ones — a loop here is free storage
 * growth on our side. Keyed on the session; the data layer still owns authz.
 */
async function throttle(): Promise<Response | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null; // addFavorite/removeFavorite answer 401 themselves
  const limit = await rateLimit(`favorites:${user.id}`, 60, 60_000);
  return limit.ok ? null : tooManyRequests(limit);
}

/**
 * The heart on a restaurant.
 *   POST   { slug } → save
 *   DELETE { slug } → unsave
 * The owner is the session, never the body — RLS enforces the same.
 */

async function slugFrom(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { slug?: string };
    const slug = body.slug?.trim();
    return slug || null;
  } catch {
    return null;
  }
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : "server_error";
  if (message === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (message === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const limited = await throttle();
  if (limited) return limited;

  const slug = await slugFrom(request);
  if (!slug) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    await addFavorite(slug);
    return NextResponse.json({ ok: true, favorite: true });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const limited = await throttle();
  if (limited) return limited;

  const slug = await slugFrom(request);
  if (!slug) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    await removeFavorite(slug);
    return NextResponse.json({ ok: true, favorite: false });
  } catch (err) {
    return fail(err);
  }
}
