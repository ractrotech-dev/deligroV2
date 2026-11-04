import "server-only";
import { revalidatePath } from "next/cache";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  featureDef,
  isFeatureKey,
  ROLE_SUBJECT,
  ROLE_WIDE_ONLY,
  type FeatureRole,
} from "@/lib/features/catalog";
import { writeSwitch } from "@/lib/features/flags.server";
import type { SwitchInput, SwitchResult } from "@/lib/features/switch-types";

/** The most one Turn on / Turn off can change. More than any role has switches. */
const MAX_BULK = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Set one feature switch — role-wide (`subjectId` null) or for one shop /
 * person — or clear it back to "inherit" with `enabled: null`.
 *
 * The caller has already checked the role (Admin → App features requires an
 * admin, Developer → Feature access a developer; AGENTS.md rule 3) and passes
 * the actor; the database re-checks it and writes the ops-audit entry with
 * the change (`ops_set_feature_switch`, migration 0141). Rate-limited (rule 6),
 * and every input is validated against the catalogue: an unknown feature key
 * or a subject of the wrong kind is refused, not stored.
 */
export async function saveFeatureSwitch(actorId: string, input: SwitchInput): Promise<SwitchResult> {
  if (!isSupabaseConfigured) return { ok: false, error: "Supabase is not configured." };

  const limit = await rateLimit(`feature-switch:${actorId}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many changes at once. Wait a moment." };

  const res = await writeOne(actorId, input);
  if (res.ok) revalidateFeatureScreens();
  return res;
}

/**
 * Turn on / Turn off for several features at once. Each change is its own audited
 * write, as if made by hand. Stops at the first refusal and says how far it got;
 * what was already saved stays saved and shows on the page.
 */
export async function saveFeatureSwitches(actorId: string, inputs: SwitchInput[]): Promise<SwitchResult> {
  if (!isSupabaseConfigured) return { ok: false, error: "Supabase is not configured." };
  if (!Array.isArray(inputs) || inputs.length === 0) return { ok: false, error: "Nothing selected." };
  if (inputs.length > MAX_BULK) return { ok: false, error: "Too many at once." };

  const limit = await rateLimit(`feature-switch-bulk:${actorId}`, 10, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many changes at once. Wait a moment." };

  let done = 0;
  for (const input of inputs) {
    const res = await writeOne(actorId, input);
    if (!res.ok) {
      if (done) revalidateFeatureScreens();
      return { ok: false, error: `${done} of ${inputs.length} saved. ${res.error ?? "Could not save."}` };
    }
    done += 1;
  }
  revalidateFeatureScreens();
  return { ok: true };
}

async function writeOne(actorId: string, input: SwitchInput): Promise<SwitchResult> {
  if (!isFeatureKey(input.feature)) return { ok: false, error: "Unknown feature." };
  if (input.subjectId !== null && !UUID.test(input.subjectId)) {
    return { ok: false, error: "Unknown account." };
  }
  if (input.enabled !== null && typeof input.enabled !== "boolean") {
    return { ok: false, error: "Invalid value." };
  }

  const def = featureDef(input.feature);
  const role = def.role as FeatureRole;
  if (input.subjectId !== null && ROLE_WIDE_ONLY.includes(role)) {
    return { ok: false, error: "This switch applies to everyone; it has no per-account exceptions." };
  }
  // Nothing in the apps can use it yet. Setting it now would only leave a surprise
  // for the day the feature is connected.
  if (def.pending && input.enabled !== null) {
    return { ok: false, error: `${def.label} can't be changed yet. ${def.pending}` };
  }
  try {
    await writeSwitch({
      feature: input.feature,
      subject: input.subjectId ? { kind: ROLE_SUBJECT[role], id: input.subjectId } : null,
      enabled: input.enabled,
      adminId: actorId,
    });
  } catch {
    return {
      ok: false,
      error:
        role === "customer"
          ? "Could not save. Is migration 0200 applied to this database?"
          : "Could not save. Is migration 0052 applied to this database?",
    };
  }
  return { ok: true };
}

function revalidateFeatureScreens() {
  revalidatePath("/developer/features");
  revalidatePath("/admin/settings/feature-access");
  // The portals read switches in their layouts; make them re-read.
  revalidatePath("/vendor", "layout");
  revalidatePath("/manager", "layout");
  revalidatePath("/driver", "layout");
  revalidatePath("/admin", "layout");
  // The customer website reads its switches in the (customer) layout.
  revalidatePath("/", "layout");
}
