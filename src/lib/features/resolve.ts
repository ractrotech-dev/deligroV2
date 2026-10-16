import {
  FEATURES,
  ROLE_SUBJECT,
  allOn,
  type FeatureKey,
  type FeatureMap,
  type FeatureRole,
} from "@/lib/features/catalog";

/** One stored switch — a row of `role_feature_flags` (migration 0052). */
export interface FlagRow {
  feature: string;
  subject_kind: "role" | "restaurant" | "profile";
  subject_id: string | null;
  enabled: boolean;
}

/**
 * The effective switches for one account.
 *
 * Precedence, most specific first: this shop's / this person's override, then
 * the role-wide switch, then ON. "No row" is never "off" — an empty table, or a
 * database without 0052, leaves every feature exactly as it was.
 *
 * Pure, so the rule is testable offline (scripts/qa/role-features.ts) and the
 * server guard and the UI cannot disagree about it.
 */
export function resolveFeatures(
  role: FeatureRole,
  rows: readonly FlagRow[],
  subjectId: string | null | undefined
): FeatureMap {
  const out = allOn();
  const kind = ROLE_SUBJECT[role];
  for (const f of FEATURES) {
    if (f.role !== role) continue;
    const roleWide = rows.find((r) => r.feature === f.key && r.subject_kind === "role");
    const own = subjectId
      ? rows.find(
          (r) => r.feature === f.key && r.subject_kind === kind && r.subject_id === subjectId
        )
      : undefined;
    const decidingRow = own ?? roleWide;
    out[f.key as FeatureKey] = decidingRow ? decidingRow.enabled : true;
  }
  return out;
}
