import { NextResponse } from "next/server";
import { readJsonBody, vendorApiContext } from "@/lib/auth/vendor-api.server";
import { getInbox, markRead } from "@/lib/data-access/user-notifications";
import { listLiveAnnouncements } from "@/lib/data-access/announcements";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isUuid } from "@/lib/vendor/uuid";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/notifications?before=<iso> — the caller's inbox, newest
 * first (50 a page), the unread count, and live announcements for vendors.
 * `available: false` before 0064.
 */
export async function GET(request: Request) {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-inbox:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const before = new URL(request.url).searchParams.get("before");
  if (before && Number.isNaN(Date.parse(before))) return NextResponse.json({ error: "invalid_before" }, { status: 400 });
  try {
    // The shared inbox (0064 / 0087) plus the live announcements for shops,
    // in the shape the Partner app reads. Announcements failing costs only
    // the pinned cards, never the inbox.
    const [inbox, announcements] = await Promise.all([
      getInbox(ctx.profile.id, { before: before ?? undefined, limit: 50 }),
      listLiveAnnouncements("vendor").catch(() => []),
    ]);
    return NextResponse.json({
      available: inbox.available,
      items: inbox.items,
      unread: inbox.unread,
      announcements,
      hasMore: inbox.hasMore,
    });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/** POST /api/vendor/notifications — { ids: [uuid…] } or { all: true }: mark read. */
export async function POST(request: Request) {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-inbox:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const body = (await readJsonBody(request)) as { ids?: unknown; all?: unknown } | null;
  const ids = body?.ids;
  if (body?.all !== true && !(Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every((i) => typeof i === "string" && isUuid(i)))) {
    return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
  }
  try {
    const marked = await markRead(ctx.profile.id, body?.all === true ? "all" : (ids as string[]));
    return NextResponse.json({ ok: true, marked });
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
