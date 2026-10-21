import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { listManagerVendors } from "@/lib/data-access/manager-vendors";
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
