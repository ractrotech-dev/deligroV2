import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingColumn } from "@/lib/data-access/schema-probe";
import type { Viewer } from "@/lib/ops/rider-serialize";

/**
 * The one-admin payments switch (0152 section 5). Off by default: the person
 * who requests a payment can never approve it. When an admin turns it on, an
 * admin — never a manager — may approve their own request with a reason, and
 * the request is marked self-approved. The switch changes only through
 * `ops_set_single_admin_payments`, which checks the actor is an admin, needs a
 * reason and writes the audit row in the same transaction.
 *
 * Callers authorise first (requireRole("admin") / managerApiContext).
 */

/** The switch, or null when 0152 is not applied (read as off). */
export async function singleAdminPaymentsOn(): Promise<boolean | null> {
  const { data, error } = await createAdminClient()
    .from("platform_settings")
    .select("allow_single_admin_payments")
    .limit(1)
    .maybeSingle<{ allow_single_admin_payments: boolean | null }>();
  if (error) {
    if (isMissingColumn(error)) return null;
    throw error;
  }
  return data?.allow_single_admin_payments === true;
}

/**
 * The viewer with the switch filled in. Only an admin can use it, so a
 * manager's viewer is returned as is without a read; a failed read leaves it
 * off (the database refuses a self-approval either way).
 */
export async function withPaymentSettings(viewer: Viewer): Promise<Viewer> {
  if (!viewer.isAdmin) return viewer;
  const on = await singleAdminPaymentsOn().catch(() => false);
  return { ...viewer, singleAdminPayments: on === true };
}

export type SetSwitchResult = { ok: true; enabled: boolean } | { ok: false; error: "reason_required" | "forbidden" | "not_migrated" | "failed" };

export async function setSingleAdminPayments(
  adminId: string,
  enabled: boolean,
  reason: string,
  clientActionId: string
): Promise<SetSwitchResult> {
  const { data, error } = await createAdminClient().rpc("ops_set_single_admin_payments", {
    p_actor: adminId,
    p_enabled: enabled,
    p_reason: reason,
    p_client_action_id: clientActionId,
  });
  if (error) {
    const message = error.message ?? "";
    if (message === "reason_required") return { ok: false, error: "reason_required" };
    if (message === "forbidden") return { ok: false, error: "forbidden" };
    if (error.code === "PGRST202" || /does not exist/.test(message)) return { ok: false, error: "not_migrated" };
    return { ok: false, error: "failed" };
  }
  return { ok: true, enabled: (data as { enabled?: boolean } | null)?.enabled === true };
}
