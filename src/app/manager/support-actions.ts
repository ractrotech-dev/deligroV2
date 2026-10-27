"use server";

import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { listOpenEmergencies } from "@/lib/data-access/support";
import { staffScopeFor } from "@/lib/auth/manager-api.server";
import type { EmergencyItem } from "@/components/ops/emergency-types";

/**
 * The live emergency feed behind the red banner on the admin home and the
 * manager board (it polls this every few seconds). Managers and admins only.
 *
 * Read-only; rate-limited per staff member (it is polled). The service-role
 * read is authorised by the gate above it. A manager with "Call customers" switched off gets no phone
 * numbers — the same switch that hides riders' numbers on the board.
 */
export async function listEmergenciesAction(): Promise<EmergencyItem[]> {
  const staff = await requireRole(["manager", "admin"]);
  // A banner polls every 8 s; 60 a minute covers several open tabs. Over it,
  // the call throws and the banner keeps what it last showed.
  const limit = await rateLimit(`ops-emergencies:${staff.id}`, 60, 60_000);
  if (!limit.ok) throw new Error("rate_limited");
  if (!isSupabaseConfigured) return [];
  // Only the caller's zones (0143): the read below is service-role.
  const scope = await staffScopeFor(staff);
  const [rows, canCall] = await Promise.all([
    listOpenEmergencies(scope).catch(() => []),
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
    alertedAt: r.alertedAt,
    assigned: r.assignedTo !== null,
  };
}
