import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid, narrowScope } from "@/lib/auth/manager-scope";
import { getProductInsights } from "@/lib/data-access/manager-products";
import { vendorInScope } from "@/lib/data-access/manager-vendors";
import { addDays, istDayKey, isDayKey } from "@/lib/metrics/ist";

export const dynamic = "force-dynamic";

/** The longest range insights read, in days. */
const MAX_DAYS = 92;

/**
 * GET /api/manager/products/insights?from=&to=&zone=&vendor= — frequently
 * unavailable dishes, price changes, top and slow sellers and out-of-stock
 * dishes over an IST date range, default the last 30 days (§12.3, §12.5,
 * §12.6, §12.10).
 *
 * → 200 { from, to, frequentlyUnavailable, priceChanges, topSellers, slowSellers, outOfStock }
 * → 400 { error: "bad_request", field }   → 404 (vendor out of scope)   → 500 { error: "load_failed" }
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;

  const sp = new URL(request.url).searchParams;
  const today = istDayKey(new Date());
  const to = sp.get("to") || today;
  const from = sp.get("from") || addDays(to, -29);
  if (!isDayKey(from)) return NextResponse.json({ error: "bad_request", field: "from" }, { status: 400 });
  if (!isDayKey(to) || to > today) return NextResponse.json({ error: "bad_request", field: "to" }, { status: 400 });
  if (from > to || addDays(from, MAX_DAYS) <= to) return NextResponse.json({ error: "bad_request", field: "from" }, { status: 400 });
  const zone = sp.get("zone");
  const vendor = sp.get("vendor");
  if (zone && !isUuid(zone)) return NextResponse.json({ error: "bad_request", field: "zone" }, { status: 400 });
  if (vendor && !isUuid(vendor)) return NextResponse.json({ error: "bad_request", field: "vendor" }, { status: 400 });
  const scope = narrowScope(ctx.scope, zone);

  try {
    if (vendor && !(await vendorInScope(scope, vendor.toLowerCase()))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(await getProductInsights(scope, { from, to }, vendor ? vendor.toLowerCase() : null));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
