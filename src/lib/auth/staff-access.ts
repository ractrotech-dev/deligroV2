/**
 * Who an admin may stop, start again or reset the password of, and the words for
 * each refusal. Pure, so it is tested directly. The server half is
 * data-access/staff-access.ts.
 *
 * Only managers and riders: the Team page lists nobody else. An admin is always
 * refused here, which covers "yourself" and "the last admin" and means one admin
 * cannot lock out another from this screen. The database refuses the same (0190).
 */

export type StaffDecision = "stop" | "start";

export interface StaffTarget {
  id: string;
  role: string;
  /** profiles.account_status: 'active' when the column is missing (before 0151). */
  accountStatus: string;
}

export type StaffRefusal = "not_found" | "self" | "admin" | "not_staff" | "already";

export function staffPasswordRefusal(actorId: string, target: StaffTarget | null): StaffRefusal | null {
  if (!target) return "not_found";
  if (target.id === actorId) return "self";
  if (target.role === "admin") return "admin";
  if (target.role !== "manager" && target.role !== "driver") return "not_staff";
  return null;
}

export function staffAccessRefusal(actorId: string, target: StaffTarget | null, decision: StaffDecision): StaffRefusal | null {
  const refusal = staffPasswordRefusal(actorId, target);
  if (refusal || !target) return refusal;
  const stopped = target.accountStatus !== "active";
  return (decision === "stop") === stopped ? "already" : null;
}

const MESSAGES: Record<string, string> = {
  not_found: "That person could not be found.",
  self: "You can't do this to your own account.",
  admin: "Admins can't be changed from here.",
  not_staff: "Only managers and riders can be changed from here.",
  already: "It's already done. Reload the page.",
  stale: "Someone changed this account a moment ago. Reload and try again.",
  invalid_transition: "It's already done. Reload the page.",
  active_delivery: "This rider is on a delivery. Finish or move it first.",
  reason_required: "Say why (3 to 300 characters).",
  migration_pending: "This needs database update 0190 first.",
  too_fast: "Too many changes. Wait a minute.",
  demo: "Demo mode: connect Supabase to change accounts.",
};

export function staffAccessMessage(code: string): string {
  return MESSAGES[code] ?? "That didn't go through. Try again.";
}

export function validStaffReason(reason: unknown): reason is string {
  return typeof reason === "string" && reason.trim().length >= 3 && reason.trim().length <= 300;
}
