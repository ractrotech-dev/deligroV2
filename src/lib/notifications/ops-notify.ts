import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFeatures } from "@/lib/features/flags.server";
import type { FeatureKey } from "@/lib/features/catalog";
import type { OpsAlertKind } from "@/lib/ops-alerts/kinds";
import type { PushOptions } from "./onesignal";
import { pushTransport, recordNotification } from "./notify-user";
import { staffCardFor } from "./push-card";
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

/**
 * The staff, their zones and their mutes — read once and reused. One alert run
 * can notify about hundreds of alerts; without this each one re-read the whole
 * staff and every manager's switches (review #3). Permissions are resolved
 * lazily and once per person, only when an audience needs one.
 */
export interface StaffDirectory {
  members(withPermissions: boolean): Promise<StaffMember[]>;
}

export function createStaffDirectory(userIds?: string[]): StaffDirectory {
  type Base = { rows: StaffRow[]; zones: Map<string, string[]>; muted: Map<string, Set<string>> };
  let base: Promise<Base> | null = null;
  const permissions = new Map<string, Promise<Partial<Record<string, boolean>>>>();

  const loadBase = async (): Promise<Base> => {
    const supabase = createAdminClient();
    let query = supabase.from("profiles").select("id, role, onesignal_id").in("role", ["admin", "manager"]);
    if (userIds && userIds.length > 0) query = query.in("id", userIds);
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
    return { rows, zones, muted };
  };

  const permissionsOf = (id: string) => {
    let p = permissions.get(id);
    if (!p) {
      p = getFeatures("manager", id);
      permissions.set(id, p);
    }
    return p;
  };

  return {
    async members(withPermissions: boolean): Promise<StaffMember[]> {
      base ??= loadBase();
      const b = await base;
      return Promise.all(
        b.rows.map(async (r) => ({
          id: r.id,
          role: r.role === "admin" ? ("admin" as const) : ("manager" as const),
          onesignalId: r.onesignal_id,
          zoneIds: b.zones.get(r.id) ?? [],
          permissions: r.role === "admin" || !withPermissions ? {} : await permissionsOf(r.id),
          muted: b.muted.get(r.id) ?? new Set<string>(),
        }))
      );
    },
  };
}

/** Loads staff, their zones, permissions and mutes, then resolves the audience. */
export async function staffRecipients(a: StaffAudience, directory: StaffDirectory = createStaffDirectory(a.userIds)): Promise<StaffRecipient[]> {
  return resolveStaffRecipients(await directory.members(!!a.permission), a);
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
 * `directory` lets a caller that notifies many times (the alert engine) read the
 * staff once instead of once per alert.
 */
export async function notifyStaff(
  a: StaffAudience,
  text: StaffText,
  data: StaffData,
  opts: { push?: PushOptions; inbox?: boolean; directory?: StaffDirectory } = {}
): Promise<{ inbox: number; pushed: number }> {
  let people: StaffRecipient[];
  try {
    people = await staffRecipients(a, opts.directory);
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
      { url: data.url, card: staffCardFor(a.kind), ...opts.push, data: { ...(opts.push?.data ?? {}), ...data } }
    );
    return { inbox, pushed: sent ? targets.length : 0 };
  } catch {
    return { inbox, pushed: 0 };
  }
}

/** Kinds, permissions and helpers re-exported for callers that only need the types. */
export type { OpsAlertKind, FeatureKey };
