import type { FeatureKey } from "@/lib/features/catalog";
import type { OpsAlertKind } from "@/lib/ops-alerts/kinds";

/**
 * Who on the operations side hears about something — pure, so the rule is
 * tested offline (scripts/qa/manager-ops-notify.ts) and ops-notify.ts only
 * loads the rows it needs.
 */

/** What staff are told about: an alert kind, or activity on a ticket they hold. */
export type StaffKind = OpsAlertKind | "ticket_activity" | "ops_notice";

export interface StaffAudience {
  /** The zone the thing happened in; null = platform-wide. */
  zoneId: string | null;
  kind: StaffKind;
  /** A manager also needs this switch on (finance, marketing, support kinds). */
  permission?: FeatureKey;
  /** Admins only (a level-2+ escalation, for instance). */
  adminsOnly?: boolean;
  /** Exactly these people (an assignee), still limited to staff. */
  userIds?: string[];
  /** Critical items of some kinds cannot be muted. */
  severity?: "info" | "warning" | "critical";
  /** Ignore mutes: SOS, a rider waiting for a decision, ring stops. */
  force?: boolean;
}

export interface StaffMember {
  id: string;
  role: "admin" | "manager";
  onesignalId: string | null;
  zoneIds: string[];
  /** Resolved manager switches; ignored for admins. */
  permissions: Partial<Record<string, boolean>>;
  /** Kinds this person switched the push off for. */
  muted: Set<string>;
}

export interface StaffRecipient {
  id: string;
  role: "admin" | "manager";
  onesignalId: string | null;
  /** False = inbox row only (muted). */
  push: boolean;
}

/** Kinds whose push cannot be switched off (the prefs screen shows them locked). */
export const LOCKED_KINDS = ["incident", "complaint_high_priority"] as const;

/**
 * An incident always pushes; a complaint only when it is critical (an
 * emergency ticket). The prefs endpoint refuses to mute either.
 */
export function isLockedForPush(kind: string, severity?: string): boolean {
  if (kind === "incident") return true;
  if (kind === "complaint_high_priority") return severity === undefined || severity === "critical";
  return false;
}

export function resolveStaffRecipients(staff: readonly StaffMember[], a: StaffAudience): StaffRecipient[] {
  const wanted = a.userIds && a.userIds.length > 0 ? new Set(a.userIds) : null;
  const unmutable = a.force === true || isLockedForPush(a.kind, a.severity ?? (a.kind === "incident" ? "critical" : "warning"));
  const out: StaffRecipient[] = [];
  for (const s of staff) {
    if (wanted && !wanted.has(s.id)) continue;
    if (s.role === "manager") {
      if (a.adminsOnly) continue;
      // An explicit recipient list (an assignee) skips the zone test — the
      // database already checked they hold the ticket's zone.
      if (!wanted) {
        if (a.zoneId === null) {
          if (a.kind !== "incident") continue;
        } else if (!s.zoneIds.includes(a.zoneId)) {
          continue;
        }
      }
      if (a.permission && s.permissions[a.permission] !== true) continue;
    }
    out.push({
      id: s.id,
      role: s.role,
      onesignalId: s.onesignalId,
      push: unmutable || !s.muted.has(a.kind),
    });
  }
  return out;
}
