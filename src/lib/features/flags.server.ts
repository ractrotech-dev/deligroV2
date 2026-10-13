import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import {
  FEATURE_OFF_MESSAGE,
  ROLE_SUBJECT,
  allOn,
  featureDef,
  isFeatureKey,
  type FeatureKey,
  type FeatureMap,
  type FeatureRole,
  type FeatureSubjectKind,
} from "@/lib/features/catalog";
import { resolveFeatures, type FlagRow } from "@/lib/features/resolve";

/**
 * Reading and writing the role feature switches (migration 0052).
 *
 * Service-role reads, and safe as such: the table is locked to service_role on
 * purpose (a vendor must not read, let alone set, their own switches), and
 * every caller is already behind `requireRole` — the portal layouts and the
 * server actions this guards. The writes below are only called from
 * `app/developer/features/actions.ts`, which checks for the developer role first.
 *
 * ## When the read fails
 *
 * These switch features off; they are not the security boundary — roles and
 * RLS are, and they are unaffected. So the failure rules are:
 *   - table missing (0052 not applied): every feature ON, and remembered, so
 *     the app is exactly what it was before the migration;
 *   - any other read error: the last good answer if there is one, otherwise ON.
 *     Hiding a vendor's menu editor because of a network blip would stop a
 *     kitchen working; a switch taking a few seconds to apply would not.
 */

const CACHE_MS = 15_000;
let cache: { at: number; rows: FlagRow[] } | null = null;
let tableMissing = false;

async function loadRows(): Promise<FlagRow[]> {
  if (!isSupabaseConfigured || tableMissing) return [];
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  try {
    const { data, error } = await createAdminClient()
      .from("role_feature_flags")
      .select("feature, subject_kind, subject_id, enabled");
    if (error) {
      if (isMissingTable(error)) {
        tableMissing = true;
        return [];
      }
      return cache?.rows ?? [];
    }
    cache = { at: Date.now(), rows: (data ?? []) as FlagRow[] };
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
 * Effective switches for one account. `subjectId` is the shop for a vendor
 * (they are set per shop), the person's profile id for a manager or rider.
 */
export async function getFeatures(
  role: FeatureRole,
  subjectId: string | null | undefined
): Promise<FeatureMap> {
  const rows = await loadRows();
  if (rows.length === 0) return allOn();
  return resolveFeatures(role, rows, subjectId);
}

export async function isFeatureOn(
  key: FeatureKey,
  subjectId: string | null | undefined
): Promise<boolean> {
  const role = featureDef(key).role as FeatureRole;
  return (await getFeatures(role, subjectId))[key];
}

/** Thrown by `assertFeature`; route handlers map it to 403. */
export class FeatureDisabledError extends Error {
  constructor(public readonly feature: FeatureKey) {
    super(FEATURE_OFF_MESSAGE);
    this.name = "FeatureDisabledError";
  }
}

/**
 * The server half of "hidden AND disabled". Call it in every server action and
 * route that performs a switchable feature, after the role check: a hidden
 * button is not a disabled endpoint (AGENTS.md rule 3).
 */
export async function assertFeature(
  key: FeatureKey,
  subjectId: string | null | undefined
): Promise<void> {
  if (!(await isFeatureOn(key, subjectId))) throw new FeatureDisabledError(key);
}

/* ---------------- admin reads and writes ---------------- */

export interface StoredSwitch {
  feature: FeatureKey;
  subjectKind: "role" | FeatureSubjectKind;
  subjectId: string | null;
  enabled: boolean;
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
