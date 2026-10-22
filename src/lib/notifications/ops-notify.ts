import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFeatures } from "@/lib/features/flags.server";
import type { FeatureKey } from "@/lib/features/catalog";
import type { OpsAlertKind } from "@/lib/ops-alerts/kinds";
import type { PushOptions } from "./onesignal";
import { pushTransport, recordNotification } from "./notify-user";
import {
  resolveStaffRecipients,
  type StaffAudience,
  type StaffMember,
  type StaffRecipient,
} from "./staff-audience";

export { LOCKED_KINDS, isLockedForPush, resolveStaffRecipients } from "./staff-audience";
export type { StaffAudience, StaffKind, StaffMember, StaffRecipient } from "./staff-audience";

/**
 * The one way the server tells operations staff anything (Phase 8, §14,
 * §15.7). It replaces the old zone-blind `.in("role", ["admin","manager"])`
 * push in order-events.ts.
 *
 * Who: every admin, plus the managers who hold the zone (all managers only for
 * a platform-wide incident), narrowed by a permission when the kind needs one
 * (finance, marketing, support). How: an inbox row for each of them — always,
 * whatever their switches — and a push to those who have not muted the kind.
 * Incidents, emergency complaints and anything marked `force` (SOS, a rider
 * waiting at a door for a decision, a ring stop) ignore mutes.
 *
 * English only: managers and admins read English (owner's rule). There is no
 * Hindi parameter to pass.
 */

type StaffRow = { id: string; role: string; onesignal_id: string | null };

/** Loads staff, their zones, permissions and mutes, then resolves the audience. */
export async function staffRecipients(a: StaffAudience): Promise<StaffRecipient[]> {
  const supabase = createAdminClient();
  let query = supabase.from("profiles").select("id, role, onesignal_id").in("role", ["admin", "manager"]);
  if (a.userIds && a.userIds.length > 0) query = query.in("id", a.userIds);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as StaffRow[];
  const managers = rows.filter((r) => r.role === "manager").map((r) => r.id);

  const [zonesRes, prefsRes] = await Promise.all([
    managers.length
      ? supabase.from("staff_zones").select("user_id, zone_id").in("user_id", managers)
      : Promise.resolve({ data: [], error: null }),
    rows.length
      ? supabase.from("notification_preferences").select("user_id, kind, push").in("user_id", rows.map((r) => r.id)).eq("push", false)
      : Promise.resolve({ data: [], error: null }),
  ]);
  // A failed zone read leaves managers with no zones: they are left out
  // (admins still get it) rather than told about every zone.
  const zones = new Map<string, string[]>();
  for (const z of ((zonesRes.data ?? []) as { user_id: string; zone_id: string }[])) {
    zones.set(z.user_id, [...(zones.get(z.user_id) ?? []), z.zone_id]);
  }
  // A failed preference read is "nothing muted": a lost alert is worse than an unwanted one.
  const muted = new Map<string, Set<string>>();
  for (const p of ((prefsRes.data ?? []) as { user_id: string; kind: string }[])) {
    muted.set(p.user_id, (muted.get(p.user_id) ?? new Set()).add(p.kind));
  }

  const staff: StaffMember[] = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      role: r.role === "admin" ? ("admin" as const) : ("manager" as const),
      onesignalId: r.onesignal_id,
      zoneIds: zones.get(r.id) ?? [],
      permissions: r.role === "admin" || !a.permission ? {} : await getFeatures("manager", r.id),
      muted: muted.get(r.id) ?? new Set<string>(),
    }))
  );
  return resolveStaffRecipients(staff, a);
}

export interface StaffText {
  title: string;
  body: string;
}

export interface StaffData {
  url: string;
  alertId?: string;
  ticketId?: string;
  [key: string]: unknown;
}

/**
 * Inbox rows for everyone in the audience, and a push to the unmuted. Never
 * throws; answers how many inbox rows were written and people pushed.
 * `inbox: false` is for silent pushes (ring stops), which have nothing to read.
 */
export async function notifyStaff(
  a: StaffAudience,
  text: StaffText,
  data: StaffData,
  opts: { push?: PushOptions; inbox?: boolean } = {}
): Promise<{ inbox: number; pushed: number }> {
  let people: StaffRecipient[];
  try {
    people = await staffRecipients(a);
  } catch {
    return { inbox: 0, pushed: 0 };
  }
  if (people.length === 0) return { inbox: 0, pushed: 0 };

  let inbox = 0;
  if (opts.inbox !== false) {
    const written = await Promise.all(
      people.map((p) =>
        recordNotification({
          userId: p.id,
          role: p.role,
          category: a.kind,
          title: text.title,
          body: text.body,
          url: data.url,
          data,
        }).catch(() => false)
      )
    );
    inbox = written.filter(Boolean).length;
  }

  const targets = people.filter((p) => p.push);
  if (targets.length === 0 || !pushTransport.configured()) return { inbox, pushed: 0 };
  try {
    const sent = await pushTransport.send(
      { userIds: targets.map((p) => p.id), playerIds: targets.map((p) => p.onesignalId) },
      { en: text.title },
      { en: text.body },
      { url: data.url, ...opts.push, data: { ...(opts.push?.data ?? {}), ...data } }
    );
    return { inbox, pushed: sent ? targets.length : 0 };
  } catch {
    return { inbox, pushed: 0 };
  }
}

/** Kinds, permissions and helpers re-exported for callers that only need the types. */
export type { OpsAlertKind, FeatureKey };
