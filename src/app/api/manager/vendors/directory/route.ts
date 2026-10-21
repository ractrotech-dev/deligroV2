import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid, narrowScope } from "@/lib/auth/manager-scope";
import { listVendorDirectory } from "@/lib/data-access/manager-vendors";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/vendors/directory?zone= — every shop in the manager's zones
 * (any status), by name, for the vendor pickers on Orders, Products and
 * Statistics. Needs any one of the views those screens sit behind.
 *
 * → 200 { vendors: [{ id, name, status, zoneId, zoneName }] }
 * → 400 { error: "bad_request", field: "zone" }   → 500 { error: "load_failed" }
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const p = ctx.permissions;
  if (!p["manager.orders.view"] && !p["manager.products.view"] && !p["manager.vendors.view"] && !p["manager.reports.view"]) {
    return NextResponse.json({ error: "permission_denied" }, { status: 403 });
  }

  const zone = new URL(request.url).searchParams.get("zone");
  if (zone && !isUuid(zone)) return NextResponse.json({ error: "bad_request", field: "zone" }, { status: 400 });

  try {
    return NextResponse.json({ vendors: await listVendorDirectory(narrowScope(ctx.scope, zone)) });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
