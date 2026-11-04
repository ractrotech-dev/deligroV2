import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import {
  FEATURE_OFF_MESSAGE,
  ROLE_SUBJECT,
  defaults,
  featureDef,
  isFeatureKey,
  type FeatureKey,
  type FeatureMap,
  type FeatureRole,
  type FeatureSubjectKind,
} from "@/lib/features/catalog";
import { resolveFeatures, type FlagRow } from "@/lib/features/resolve";
import { isRpcMissing, unauditedFallbackAllowed } from "@/lib/manager/rpc-errors";

/**
 * Reading and writing the role feature switches (migration 0052).
 *
 * Service-role reads, and safe as such: the table is locked to service_role on
 * purpose (a vendor must not read, let alone set, their own switches), and
 * every caller is already behind `requireRole` — the portal layouts and the
 * server actions this guards, or answers a guest's own "for everyone" question.
 * The writes below are only called from `save-switch.server.ts`, behind the admin
 * and developer actions, which check the role first.
 *
 * ## When the read fails
 *
 * These switch features off; they are not the security boundary — roles and
 * RLS are, and they are unaffected. So the failure rules are:
 *   - table missing (0052 not applied): every feature at its default, and
 *     remembered, so the app is exactly what it was before the migration;
 *   - any other read error: the last good answer if there is one, otherwise
 *     the defaults. Hiding a vendor's menu editor because of a network blip
 *     would stop a kitchen working; a switch taking a few seconds to apply
 *     would not. The sensitive manager powers (payments, adjustments, customer
 *     contact…) default OFF, so for them a failed read fails closed.
 */

const CACHE_MS = 15_000;
/** PostgREST answers at most 1000 rows a call; customer exceptions can pass that. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
let cache: { at: number; rows: FlagRow[] } | null = null;
let tableMissing = false;

async function loadRows(): Promise<FlagRow[]> {
  if (!isSupabaseConfigured || tableMissing) return [];
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  try {
    const admin = createAdminClient();
    const rows: FlagRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await admin
        .from("role_feature_flags")
        .select("feature, subject_kind, subject_id, enabled")
        .order("id", { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (error) {
        if (isMissingTable(error)) {
          tableMissing = true;
          return [];
        }
        return cache?.rows ?? [];
      }
      rows.push(...((data ?? []) as FlagRow[]));
      if ((data?.length ?? 0) < PAGE_SIZE) break;
    }
    cache = { at: Date.now(), rows };
    return cache.rows;
  } catch {
    return cache?.rows ?? [];
  }
}

/** Whether 0052 is live — the admin panel says so when it isn't. */
export async function featureSwitchesAvailable(): Promise<boolean> {
  await loadRows();
  return isSupabaseConfigured && !tableMissing;
}

/**
 * Whether customer switches can be saved here: 0200 lets the table hold them, and
 * adds `customer_feature_on` in the same migration, so that function answers for
 * both. Only a function that is really missing says no; any other failure leaves the
 * switches usable, and a refused save still reports itself.
 */
export async function customerSwitchesAvailable(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const { error } = await createAdminClient().rpc("customer_feature_on", {
    p_feature: "customer.reorder",
    p_default: true,
  });
  return !(error && isRpcMissing(error));
}

/**
 * Effective switches for one account. `subjectId` is the shop for a vendor
 * (they are set per shop), the person's profile id for a manager or rider.
 */
export async function getFeatures(
  role: FeatureRole,
  subjectId: string | null | undefined
): Promise<FeatureMap> {
  const rows = await loadRows();
  // No rows (empty table, 0052 missing, or a failed read with nothing cached):
  // each feature's default. Default-off powers therefore fail closed.
  if (rows.length === 0) return defaults();
  return resolveFeatures(role, rows, subjectId);
}

export async function isFeatureOn(
  key: FeatureKey,
  subjectId: string | null | undefined
): Promise<boolean> {
  const role = featureDef(key).role as FeatureRole;
  return (await getFeatures(role, subjectId))[key];
}

/** Thrown by `assertVendorFeature` and `createOrder`; route handlers map it to 403. */
export class FeatureDisabledError extends Error {
  constructor(public readonly feature: FeatureKey) {
    super(FEATURE_OFF_MESSAGE);
    this.name = "FeatureDisabledError";
  }
}

/* ---------------- admin reads and writes ---------------- */

export interface StoredSwitch {
  feature: FeatureKey;
  subjectKind: "role" | FeatureSubjectKind;
  subjectId: string | null;
  enabled: boolean;
  /** Who set it and when, where recorded. Filled by `listSwitchesWithAuthor` only. */
  changedBy?: string | null;
  changedAt?: string | null;
}

/** Every stored switch, fresh (the panel must not show a 15 s old answer). */
export async function listSwitches(): Promise<StoredSwitch[]> {
  cache = null;
  const rows = await loadRows();
  return rows
    .filter((r) => isFeatureKey(r.feature))
    .map((r) => ({
      feature: r.feature as FeatureKey,
      subjectKind: r.subject_kind,
      subjectId: r.subject_id,
      enabled: r.enabled,
    }));
}

/** One account's own switches with who set each one: the admin's per-account view. */
export async function listAccountSwitches(
  subjectKind: FeatureSubjectKind,
  subjectId: string
): Promise<StoredSwitch[]> {
  if (!isSupabaseConfigured) return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("role_feature_flags")
    .select("feature, subject_kind, subject_id, enabled, updated_at, updated_by")
    .eq("subject_kind", subjectKind)
    .eq("subject_id", subjectId);
  if (error || !data) return [];
  const rows = data as (FlagRow & { updated_at: string | null; updated_by: string | null })[];
  const authorIds = [...new Set(rows.map((r) => r.updated_by).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (authorIds.length) {
    const { data: people } = await admin.from("profiles").select("id, full_name, phone").in("id", authorIds);
    for (const p of (people ?? []) as { id: string; full_name: string | null; phone: string | null }[]) {
      names.set(p.id, p.full_name?.trim() || p.phone || "Staff");
    }
  }
  return rows
    .filter((r) => isFeatureKey(r.feature))
    .map((r) => ({
      feature: r.feature as FeatureKey,
      subjectKind: r.subject_kind,
      subjectId: r.subject_id,
      enabled: r.enabled,
      changedBy: r.updated_by ? names.get(r.updated_by) ?? "Removed account" : null,
      changedAt: r.updated_at,
    }));
}

/**
 * Set a switch, or clear it with `enabled: null` (back to inherit).
 * `subject` null means role-wide.
 */
export async function writeSwitch(input: {
  feature: FeatureKey;
  subject: { kind: FeatureSubjectKind; id: string } | null;
  enabled: boolean | null;
  adminId: string;
}): Promise<void> {
  const role = featureDef(input.feature).role as FeatureRole;
  if (input.subject && input.subject.kind !== ROLE_SUBJECT[role]) {
    throw new Error("wrong_subject_kind");
  }
  const supabase = createAdminClient();
  const kind = input.subject ? input.subject.kind : "role";
  const id = input.subject ? input.subject.id : null;

  // 0141: one call replaces the switch and writes its ops-audit entry in the
  // same transaction (and re-checks the actor is an admin or developer).
  const { error: rpcError } = await supabase.rpc("ops_set_feature_switch", {
    p_actor: input.adminId,
    p_role: role,
    p_feature: input.feature,
    p_subject_kind: kind,
    p_subject_id: id,
    p_enabled: input.enabled,
  });
  if (!rpcError) {
    cache = null;
    return;
  }
  // Only a database without 0141 — and so without an audit log to write to —
  // falls back to the plain writes below. A "missing" RPC next to an existing
  // audit log is a stale schema cache, and any other failure is a failure.
  const probe = isRpcMissing(rpcError)
    ? await supabase.from("ops_audit_log").select("id", { head: true, count: "exact" }).limit(1)
    : null;
  if (!unauditedFallbackAllowed(rpcError, probe?.error ?? null)) throw rpcError;

  let del = supabase
    .from("role_feature_flags")
    .delete()
    .eq("feature", input.feature)
    .eq("subject_kind", kind);
  del = id ? del.eq("subject_id", id) : del.is("subject_id", null);
  const { error: delError } = await del;
  if (delError) throw delError;

  if (input.enabled !== null) {
    const { error } = await supabase.from("role_feature_flags").insert({
      role,
      feature: input.feature,
      subject_kind: kind,
      subject_id: id,
      enabled: input.enabled,
      updated_by: input.adminId,
    });
    if (error) throw error;
  }
  cache = null;
}
