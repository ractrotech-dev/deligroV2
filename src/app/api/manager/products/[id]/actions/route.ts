import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getManagerProductDetail } from "@/lib/data-access/manager-products";
import { opsProductAction } from "@/lib/data-access/manager-product-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { PRODUCT_ACTION_PERMISSION, parseProductActionBody } from "@/lib/ops/product-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/products/[id]/actions — flag, hide, unhide, approve,
 * reject, resolve_flag, dismiss_flag or adjust_stock on one dish (§12.8,
 * §12.9, stock). Flagging needs manager.products.view; moderation needs
 * manager.products.moderate; stock needs manager.products.adjust_stock.
 * One RPC per action (0146) changes and audits together; a replayed
 * clientActionId answers 200 and changes nothing. 60 writes a minute.
 *
 * → 200 { ok: true, product }   → 400 bad_request | reason_required
 * → 403 permission_denied   → 404 not_found   → 409 invalid_transition | stale   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "product-actions");
  if (limited) return limited;

  const { id: rawId } = await params;
  if (!isUuid(rawId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const id = rawId.toLowerCase();

  const parsed = parseProductActionBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  }
  const permission = PRODUCT_ACTION_PERMISSION[parsed.action.action];
  if (ctx.permissions[permission] !== true) {
    return NextResponse.json({ error: "permission_denied", permission }, { status: 403 });
  }

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const result = await opsProductAction(actor, ctx.scope, id, parsed.action);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }

  try {
    const product = await getManagerProductDetail(ctx.scope, id, { permissions: ctx.permissions, now: new Date() });
    return NextResponse.json({ ok: true, product });
  } catch {
    // The action is done; only the re-read failed.
    return NextResponse.json({ ok: true, product: null });
  }
}
