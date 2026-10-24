import { after, NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isSupabaseConfigured, SUPABASE_SERVICE_ROLE_KEY } from "@/lib/supabase/config";
import { currentEnv, currentRelease, templateRoute } from "@/lib/obs/ids";
import { redactUrl } from "@/lib/obs/redact";
import { doorOf } from "@/lib/obs/page-speed";

/**
 * POST /api/obs/timings — a browser reporting how long its pages took
 * (OBSERVABILITY_V2.md, phase 5; migration 0172).
 *
 * Body: { rows: [{ path, kind: "first" | "move", visitorMs, serverMs | null }] },
 * at most 20 per batch. Like /api/obs/client, nothing is trusted: the page is
 * reduced to its pattern here (/orders/<id> → /orders/[id], no query string),
 * the part of the app and the device type are decided here, numbers are
 * clamped, and no person is stored. Rate limited per address. Always 204.
 */

type Kind = "first" | "move";

function ms(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 120_000 ? Math.round(v) : null;
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured || !SUPABASE_SERVICE_ROLE_KEY) return new NextResponse(null, { status: 204 });

  const limit = await rateLimit(`obs-timings:${clientIp(request)}`, 60, 300_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: { rows?: unknown };
  try {
    body = (await request.json()) as { rows?: unknown };
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  if (!Array.isArray(body.rows)) return new NextResponse(null, { status: 204 });

  const ua = request.headers.get("user-agent") ?? "";
  const device = /mobi|android|iphone|ipad|ipod/i.test(ua) ? "phone" : "computer";
  const release = currentRelease();
  const rows = body.rows.slice(0, 20).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const r = raw as { path?: unknown; kind?: unknown; visitorMs?: unknown; serverMs?: unknown };
    const kind: Kind | null = r.kind === "first" || r.kind === "move" ? r.kind : null;
    const visitor = ms(r.visitorMs);
    if (!kind || visitor === null || typeof r.path !== "string" || !r.path.startsWith("/")) return [];
    const path = redactUrl(r.path).split("?")[0] ?? "/";
    return [{ page: templateRoute(path).slice(0, 120), door: doorOf(path), device, kind, visitor_ms: visitor, server_ms: ms(r.serverMs), release }];
  });
  if (rows.length === 0) return new NextResponse(null, { status: 204 });

  const env = currentEnv();
  after(async () => {
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      await createAdminClient().rpc("obs_record_timings", { p_env: env, p_rows: rows });
    } catch {
      /* a lost timing costs one data point */
    }
  });
  return new NextResponse(null, { status: 204 });
}
