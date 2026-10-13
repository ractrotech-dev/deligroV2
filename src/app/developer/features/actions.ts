"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { featureDef, isFeatureKey, ROLE_SUBJECT, type FeatureRole } from "@/lib/features/catalog";
import { writeSwitch } from "@/lib/features/flags.server";

export interface SwitchResult {
  ok: boolean;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Set one feature switch — role-wide (`subjectId` null) or for one shop /
 * person — or clear it back to "inherit" with `enabled: null`.
 *
 * Developer only (AGENTS.md rule 3), rate-limited (rule 6), and every input is
 * validated against the catalogue: an unknown feature key or a subject of the
 * wrong kind is refused, not stored.
 */
export async function setFeatureSwitchAction(input: {
  feature: string;
  subjectId: string | null;
  enabled: boolean | null;
}): Promise<SwitchResult> {
  const admin = await requireRole("developer");
  if (!isSupabaseConfigured) return { ok: false, error: "Supabase is not configured." };

  const limit = await rateLimit(`feature-switch:${admin.id}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many changes at once. Wait a moment." };

  if (!isFeatureKey(input.feature)) return { ok: false, error: "Unknown feature." };
  if (input.subjectId !== null && !UUID.test(input.subjectId)) {
    return { ok: false, error: "Unknown account." };
  }
  if (input.enabled !== null && typeof input.enabled !== "boolean") {
    return { ok: false, error: "Invalid value." };
  }

  const role = featureDef(input.feature).role as FeatureRole;
  try {
    await writeSwitch({
      feature: input.feature,
      subject: input.subjectId ? { kind: ROLE_SUBJECT[role], id: input.subjectId } : null,
      enabled: input.enabled,
      adminId: admin.id,
    });
  } catch {
    return {
      ok: false,
      error: "Could not save. Is migration 0052 applied to this database?",
    };
  }

  revalidatePath("/developer/features");
  // The portals read switches in their layouts; make them re-read.
  revalidatePath("/vendor", "layout");
  revalidatePath("/manager", "layout");
  revalidatePath("/driver", "layout");
  return { ok: true };
}
