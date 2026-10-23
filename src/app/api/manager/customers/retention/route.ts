import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid, narrowScope } from "@/lib/auth/manager-scope";
import { getRetention } from "@/lib/data-access/manager-customers";
import { addDays, istDayKey } from "@/lib/metrics/ist";
import { badField, loadFailed, parseOptionalRange } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/customers/retention?from&to&zone — repeat orders and
 * retention for the scope (§10.6): summary over the range (default: the last
 * 90 days) and six monthly cohorts ending with `to`'s month.
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.customers.view");
  if (ctx instanceof Response) return ctx;
  const p = new URL(request.url).searchParams;
  const parsed = parseOptionalRange(p);
  if (!parsed.ok) return badField(parsed.field);
  const zone = p.get("zone");
  if (zone && !isUuid(zone)) return badField("zone");
  const today = istDayKey(new Date());
  const range = parsed.range ?? { from: addDays(today, -89), to: today };
  try {
    const r = await getRetention(narrowScope(ctx.scope, zone?.toLowerCase() ?? null), range);
    return NextResponse.json({ from: range.from, to: range.to, ...r });
  } catch {
    return loadFailed();
  }
}
