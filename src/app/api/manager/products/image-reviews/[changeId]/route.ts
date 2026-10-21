import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { opsReviewImage } from "@/lib/data-access/manager-product-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { parseImageReviewBody } from "@/lib/ops/product-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/products/image-reviews/[changeId]
 *   { outcome: "ok" | "flag", flagReason?: "wrong_image" | "inappropriate", note?, clientActionId }
 * "Looks fine" marks the photo reviewed; Flag (a note required) also opens a
 * listing flag and tells the shop. One audited RPC (0146); a replayed
 * clientActionId changes nothing. manager.products.moderate; 60 writes a minute.
 *
 * → 200 { ok: true }   → 400 bad_request | reason_required   → 404 not_found
 * → 409 invalid_transition (already reviewed)   → 429   → 500 action_failed
 */
export async function POST(request: Request, { params }: { params: Promise<{ changeId: string }> }) {
  const ctx = await managerApiContext("manager.products.moderate");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "image-reviews");
  if (limited) return limited;

  const { changeId: raw } = await params;
  const changeId = Number(raw);
  if (!Number.isInteger(changeId) || changeId < 1) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = parseImageReviewBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  }
  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const result = await opsReviewImage(actor, ctx.scope, changeId, parsed.body);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
