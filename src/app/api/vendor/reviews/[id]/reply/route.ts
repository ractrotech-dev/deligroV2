import { NextResponse } from "next/server";
import { readJsonBody, vendorWriteContext } from "@/lib/auth/vendor-api.server";
import { saveReviewReply } from "@/lib/data-access/vendor-reviews";

/**
 * POST /api/vendor/reviews/:id/reply — { text } (1–1000 characters): the
 * shop's public reply to one of its published reviews; posting again edits
 * it. 404 for another shop's review.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorWriteContext(null, "vendor-growth");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const body = (await readJsonBody(request)) as { text?: unknown } | null;
  const result = await saveReviewReply(ctx.restaurant.id, ctx.profile.id, id, typeof body?.text === "string" ? body.text : "");
  if (result.ok) return NextResponse.json({ ok: true });
  const status = result.error === "not_found" || result.error === "invalid" ? 404 : result.error === "server_error" ? 500 : 400;
  return NextResponse.json({ error: result.error }, { status });
}
