import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { permittedKinds } from "@/lib/reports/definitions";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/reports/kinds — the reports this caller may run, in
 * registry order, with their filters and status options (§13, §15.9 "access
 * to authorized reports only").
 *
 * Needs manager.reports.view.
 * → 200 { kinds: [{ kind, label, blurb, filters, statusOptions }] }   → 403 permission_denied
 */
export async function GET() {
  const ctx = await managerApiContext("manager.reports.view");
  if (ctx instanceof Response) return ctx;
  const kinds = permittedKinds(ctx.permissions, ctx.profile.role === "admin").map((d) => ({
    kind: d.kind, label: d.label, blurb: d.blurb, filters: d.filters, statusOptions: d.statusOptions,
  }));
  return NextResponse.json({ kinds });
}
