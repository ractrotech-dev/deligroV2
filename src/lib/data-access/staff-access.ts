import "server-only";
import { randomUUID } from "node:crypto";
import type { Profile } from "@/lib/auth";
import { setAuthBan } from "@/lib/auth/account-status.server";
import {
  staffAccessRefusal,
  staffPasswordRefusal,
  validStaffReason,
  type StaffDecision,
  type StaffTarget,
} from "@/lib/auth/staff-access";
import { captureError } from "@/lib/obs/emit";
import { auditedChange } from "@/lib/data-access/ops-audit";
import { isMissingColumn } from "@/lib/data-access/schema-probe";
import { actOnRider } from "@/lib/data-access/manager-rider-actions";
import { createAdminClient } from "@/lib/supabase/admin";
import { legiblePassword } from "@/lib/utils/password";

/**
 * Stop, start again and reset the password of a manager or rider, from Admin.
 *
 * A rider goes through the same audited step a manager's own app uses (0151): every
 * /api/rider route and the /driver pages then refuse them, and the app shows why. It
 * is refused while they carry an order, so no delivery is stranded. They stay signed
 * in on purpose, or the blocking screen could not explain itself.
 *
 * A manager has no such gate of its own, so they are locked out three ways: a ban in
 * Supabase Auth (no sign-in, no token refresh), their sessions ended (0190), and
 * `staffAccountStopped` plus `is_manager()` refusing whatever token is left.
 *
 * Callers authorise first (AGENTS.md rule 5): every function takes the admin who has
 * already passed requireRole("admin"). Service role.
 */

export type StaffResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** The account as Admin acts on it, or null when there is no such profile. */
export async function getStaffAccount(id: string): Promise<StaffTarget | null> {
  const db = createAdminClient();
  const { data, error } = await db.from("profiles").select("id, role, account_status").eq("id", id).maybeSingle();
  if (error && !isMissingColumn(error)) throw error;
  if (error) {
    const { data: bare, error: bareError } = await db.from("profiles").select("id, role").eq("id", id).maybeSingle();
    if (bareError) throw bareError;
    const row = bare as { id: string; role: string } | null;
    return row ? { id: row.id, role: row.role, accountStatus: "active" } : null;
  }
  const row = data as { id: string; role: string; account_status: string | null } | null;
  return row ? { id: row.id, role: row.role, accountStatus: row.account_status ?? "active" } : null;
}

const rpcMissing = (e: { code?: string } | null) => !!e && (e.code === "PGRST202" || e.code === "42883");

async function setManagerAccess(actorId: string, target: StaffTarget, decision: StaffDecision, reason: string): Promise<StaffResult> {
  // Auth first, then the status and its audit row, so a failure anywhere leaves the
  // button still there to press again. Undone if the second step refuses.
  try {
    await setAuthBan(target.id, decision === "stop");
  } catch (e) {
    captureError(e, { source: "staff-access", attrs: { event: "staff_ban_failed", decision } });
    return { ok: false, error: "failed" };
  }
  const db = createAdminClient();
  const { error } = await db.rpc("ops_admin_set_staff_account", {
    p_actor: actorId,
    p_user: target.id,
    p_decision: decision,
    p_expected: target.accountStatus,
    p_reason: reason,
    p_client_action_id: randomUUID(),
  });
  if (error) {
    await setAuthBan(target.id, decision !== "stop").catch(() => {});
    if (rpcMissing(error)) return { ok: false, error: "migration_pending" };
    const message = (error.message ?? "").trim();
    return { ok: false, error: message === "stale" || message === "invalid_transition" ? message : "failed" };
  }
  if (decision === "stop") await endSessions(actorId, target.id);
  return { ok: true };
}

/** A second layer: the ban and `staffAccountStopped` hold even if this fails. */
async function endSessions(actorId: string, userId: string): Promise<void> {
  const { error } = await createAdminClient().rpc("ops_revoke_staff_sessions", { p_actor: actorId, p_user: userId });
  if (error) captureError(error, { source: "staff-access", attrs: { event: "staff_sessions_not_ended" } });
}

export async function setStaffAccess(admin: Profile, targetId: string, decision: StaffDecision, reason: string): Promise<StaffResult> {
  const target = await getStaffAccount(targetId);
  const refusal = staffAccessRefusal(admin.id, target, decision);
  if (refusal || !target) return { ok: false, error: refusal ?? "not_found" };
  if (!validStaffReason(reason)) return { ok: false, error: "reason_required" };

  if (target.role === "manager") return setManagerAccess(admin.id, target, decision, reason.trim());

  const r = await actOnRider({ profile: admin, scope: { all: true }, permissions: {} }, target.id, {
    action: decision === "stop" ? "suspend" : "reactivate",
    expected: target.accountStatus as "active" | "suspended",
    reason: reason.trim(),
    clientActionId: randomUUID(),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Issue a new password, shown once and never stored (AGENTS.md rule 4: the
 * vendor_login_credentials exception is not extended to staff). Logged first, and
 * every session ends, so whoever prompted the reset is locked out straight away.
 */
export async function resetStaffPassword(admin: Profile, targetId: string): Promise<StaffResult<{ password: string }>> {
  const target = await getStaffAccount(targetId);
  const refusal = staffPasswordRefusal(admin.id, target);
  if (refusal || !target) return { ok: false, error: refusal ?? "not_found" };

  const password = legiblePassword();
  await auditedChange(
    { action: "staff.password_reset", actorId: admin.id, entityType: target.role === "driver" ? "rider" : "staff", entityId: target.id, reason: "Reset in the admin console" },
    async () => {
      const { error } = await createAdminClient().auth.admin.updateUserById(target.id, { password, email_confirm: true });
      if (error) throw error;
    }
  );
  await endSessions(admin.id, target.id);
  return { ok: true, password };
}
