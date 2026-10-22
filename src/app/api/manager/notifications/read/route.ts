import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { markRead } from "@/lib/data-access/manager-inbox";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/notifications/read — mark the person's own inbox rows read.
 * Body { ids: [uuid] (1–200) } or { all: true }.
 *
 * → 200 { unread }   → 400 bad_request   → 429
 */
export async function POST(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "inbox-read", 120);
  if (limited) return limited;
  const body = await readJsonObject(request);
  let target: { ids: string[] } | { all: true };
  const ids = body?.ids;
  if (body?.all === true) {
    target = { all: true };
  } else if (Array.isArray(ids) && ids.length > 0 && ids.length <= 200 && ids.every((x) => typeof x === "string" && isUuid(x))) {
    target = { ids: (ids as string[]).map((x) => x.toLowerCase()) };
  } else {
    return NextResponse.json({ error: "bad_request", field: "ids" }, { status: 400 });
  }
  try {
    return NextResponse.json({ unread: await markRead(ctx.profile.id, target) });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
