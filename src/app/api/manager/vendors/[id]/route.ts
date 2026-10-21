import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getManagerVendorDetail } from "@/lib/data-access/manager-vendors";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/vendors/[id] — one shop in the manager's zones: status and
 * who decided it, contact, address, hours and holidays, registration,
 * documents, the last 30 days' performance, open complaints, the actions this
 * manager may take, and — with manager.finance.view only — commission,
 * pending payment and settlements (§4.3–§4.13).
 *
 * → 200 { vendor: VendorDetail }   → 404 { error: "not_found" } (missing and
 *   out of zone look the same)   → 500 { error: "load_failed" }
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.vendors.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const vendor = await getManagerVendorDetail(ctx.scope, id.toLowerCase(), { permissions: ctx.permissions, now: new Date() });
    if (!vendor) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ vendor });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
