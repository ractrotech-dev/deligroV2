import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { listRestrictedCategories, opsSetRestrictedCategory } from "@/lib/data-access/manager-product-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { parseRestrictedCategoryBody } from "@/lib/ops/product-actions";

export const dynamic = "force-dynamic";

/**
 * GET  /api/manager/products/restricted-categories — the menu categories whose
 *      new dishes and price changes need approval (§12.9).
 * POST { name, restricted, reason, clientActionId } — add or remove one;
 *      audited. Admins only: the list is platform-wide, so one zone's
 *      manager must not change moderation for every other zone's vendors
 *      (the database refuses a manager too, 0146).
 *
 * → 200 { categories } / { ok: true, categories }   → 400 bad_request | reason_required
 * → 403 permission_denied | admin_only   → 429   → 500 load_failed | action_failed
 */
export async function GET() {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;
  try {
    return NextResponse.json({ categories: await listRestrictedCategories() });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.products.moderate");
  if (ctx instanceof Response) return ctx;
  if (ctx.profile.role !== "admin") return NextResponse.json({ error: "admin_only" }, { status: 403 });

  const limited = await managerWriteLimit(ctx, "restricted-categories", 20);
  if (limited) return limited;

  const parsed = parseRestrictedCategoryBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  }
  const b = parsed.body;
  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const result = await opsSetRestrictedCategory(actor, b.name, b.restricted, b.reason, b.clientActionId);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ ok: true, categories: await listRestrictedCategories() });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
