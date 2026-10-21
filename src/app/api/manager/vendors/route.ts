import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { listManagerVendors } from "@/lib/data-access/manager-vendors";
import { opsOnboardVendor } from "@/lib/data-access/manager-vendor-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { parseOnboardBody } from "@/lib/ops/vendor-actions";
import { parseVendorQuery } from "@/lib/ops/vendor-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/vendors — every shop in the manager's zones (§4.1), by
 * name, keyset-paged.
 *
 * Query: q (name or slug, 2+ characters), status (comma list), filter
 * (active | online | pending | needs_attention), zone, category, cursor,
 * limit (1–100, default 50).
 *
 * → 200 { items: VendorListItem[], nextCursor, counts }
 * → 400 { error: "bad_request", field }   → 500 { error: "load_failed" }
 * Contract: docs/superpowers/plans/2026-10-21-manager-app-phase-4-vendors-products.md.
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.vendors.view");
  if (ctx instanceof Response) return ctx;

  const parsed = parseVendorQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  try {
    return NextResponse.json(await listManagerVendors(ctx.scope, parsed.query, new Date()));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/manager/vendors — onboard a shop into one of the manager's zones
 * (§4.2). Creates the owner's login, then the shop (status pending, platform
 * commission, no bank details) and its audit row in one RPC (0145). Body: the
 * plan's onboarding fields; a password is generated when none is given and
 * returned once in `credentials`.
 *
 * → 201 { id, slug, credentials? }   → 400 { error: "bad_request", field }
 * → 403 permission_denied (manager.vendors.onboard)   → 404 (zone out of scope)
 * → 409 email_taken | phone_taken   → 429
 */
export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.vendors.onboard");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "vendor-onboard", 10);
  if (limited) return limited;

  const parsed = parseOnboardBody(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const result = await opsOnboardVendor(actor, ctx.scope, parsed.input);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json(
      { id: result.id, slug: result.slug, ...(result.credentials ? { credentials: result.credentials } : {}) },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
