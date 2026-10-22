"use server";

import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { listOpenEmergencies } from "@/lib/data-access/support";
import type { EmergencyItem } from "@/components/ops/emergency-types";

/**
 * The live emergency feed behind the red banner on the admin home and the
 * manager board (it polls this every few seconds). Managers and admins only.
 *
 * Read-only, so no rate limit; the service-role read is authorised by the
 * gate above it. A manager with "Call customers" switched off gets no phone
 * numbers — the same switch that hides riders' numbers on the board.
 */
export async function listEmergenciesAction(): Promise<EmergencyItem[]> {
  const staff = await requireRole(["manager", "admin"]);
  if (!isSupabaseConfigured) return [];
  const [rows, canCall] = await Promise.all([
    listOpenEmergencies().catch(() => []),
    staff.role === "admin" ? Promise.resolve(true) : staffFeatureOn("manager.call_customer"),
  ]);
  return rows.map((r) => toEmergencyItem(r, canCall));
}

function toEmergencyItem(
  r: Awaited<ReturnType<typeof listOpenEmergencies>>[number],
  canCall: boolean
): EmergencyItem {
  return {
    id: r.id,
    number: r.number,
    categoryLabel: r.categoryLabel,
    subject: r.subject,
    status: r.status,
    riderName: r.requesterName,
    riderCode: r.riderCode,
    riderPhone: canCall ? r.requesterPhone : null,
    orderId: r.orderId,
    orderCode: r.orderCode,
    locationUrl: r.locationUrl,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    assigned: r.assignedTo !== null,
  };
}
