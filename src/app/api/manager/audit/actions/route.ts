import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { AUDIT_ACTIONS } from "@/lib/ops/audit-catalog";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/audit/actions — every audited action code with its label
 * and group, for the audit screen's filter. Needs `manager.audit.view_zone`.
 *
 * → 200 { actions: [{ code, label, group }] }   → 403 permission_denied
 */
export async function GET() {
  const ctx = await managerApiContext("manager.audit.view_zone");
  if (ctx instanceof Response) return ctx;
  return NextResponse.json({ actions: AUDIT_ACTIONS.map(({ code, label, group }) => ({ code, label, group })) });
}
