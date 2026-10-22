import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getInbox, markRead } from "@/lib/data-access/user-notifications";
import { isUuid } from "@/lib/support/rules";

const ROUTE = "/api/rider/notifications";

/**
 * GET /api/rider/notifications?before=<iso>&limit=<1-100, default 30> — the
 * rider's inbox, newest first. Every push the rider was sent is here, muted
 * ones included.
 *
 *   200 { available, notifications: { id, category, title, body, data, read,
 *         readAt, createdAt }[], unread, hasMore, nextBefore }
 *       `data.url` is the app route a tap opens; `available: false` means the
 *       inbox table (0087) is not there yet (the list is empty, not an error).
 *   400 invalid_before
 *   401 · 403 not_rider · 429 · 500
 */
export async function GET(request: Request) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-inbox:${profile.id}`, 120, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const sp = new URL(request.url).searchParams;
  const before = sp.get("before");
  if (before !== null && !Number.isFinite(Date.parse(before))) {
    return NextResponse.json({ error: "invalid_before" }, { status: 400 });
  }
  const size = Number(sp.get("limit") ?? "30");
  try {
    const inbox = await getInbox(profile.id, {
      before: before ? new Date(before).toISOString() : null,
      limit: Number.isFinite(size) ? size : 30,
    });
    return NextResponse.json(
      {
        available: inbox.available,
        notifications: inbox.items,
        unread: inbox.unread,
        hasMore: inbox.hasMore,
        nextBefore: inbox.nextBefore,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return riderRouteError(e, { route: ROUTE, method: "GET", riderId: profile.id, event: "inbox" });
  }
}

/**
 * POST /api/rider/notifications — mark read.
 *
 *   { action: "read", ids: uuid[] (1–100) }   those of the rider's that are unread
 *   { action: "read_all" }                     every unread one
 *
 *   200 { ok: true, updated }   ids that are not the rider's are ignored
 *   400 invalid_body | invalid_action | invalid_ids
 *   401 · 403 not_rider · 429 · 500
 */
export async function POST(request: Request) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-inbox-write:${profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  let ids: string[] | "all";
  if (body.action === "read_all") {
    ids = "all";
  } else if (body.action === "read") {
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100 || !body.ids.every(isUuid)) {
      return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
    }
    ids = body.ids as string[];
  } else {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  try {
    return NextResponse.json({ ok: true, updated: await markRead(profile.id, ids) });
  } catch (e) {
    return riderRouteError(e, { route: ROUTE, method: "POST", riderId: profile.id, event: "inbox_read" });
  }
}
