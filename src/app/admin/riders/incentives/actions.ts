"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/obs/emit";
import { formString } from "@/lib/utils/form-data";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { getIncentiveRule } from "@/lib/data-access/rider-earnings";
import {
  createIncentiveRule,
  setIncentiveRuleActive,
  updateIncentiveRule,
} from "@/lib/data-access/admin-riders";
import {
  MIGRATION_PENDING_MESSAGE,
  isSchemaMissing,
  parseIncentiveRule,
  writeErrorMessage,
  type ActionResult,
} from "@/lib/rider/admin-money";

/**
 * Incentive rules: create, edit, switch on and off. There is no delete: a rule
 * with any award can never go (`rider_incentive_awards.rule_id` is RESTRICT),
 * and switching it off already stops it paying - so the console offers one way
 * to retire a rule, and it is the safe one.
 *
 * Writes use the admin's own cookie client (the insert policy requires
 * `created_by = auth.uid()`). A rule's period and start date are fixed for
 * every role once created, so an edit never sends them.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO = "Demo mode: connect Supabase to save incentive rules. Nothing was saved.";
const TOO_FAST = "Too many changes in a minute. Wait a moment and try again.";

function refresh(): void {
  revalidatePath("/admin/riders/incentives");
}

/** Create a rule, or (with a posted `id`) edit one. Redirects to the list on success. */
export async function saveIncentiveRuleAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-rule:${admin.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_FAST };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const id = formString(form, "id").trim();
  if (id && !UUID.test(id)) return { ok: false, error: "That rule could not be identified. Reload the page and try again." };

  try {
    let stored = null;
    if (id) {
      stored = await getIncentiveRule(id);
      if (!stored) return { ok: false, error: "That rule no longer exists." };
    }
    const parsed = parseIncentiveRule(form, stored ? { mode: "edit", startsOn: stored.startsOn } : { mode: "create" });
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const db = await createClient();
    const result = id
      ? await updateIncentiveRule(db, id, parsed.value)
      : await createIncentiveRule(db, admin.id, parsed.value);
    if (!result.ok) {
      if (result.notFound) return { ok: false, error: "That rule no longer exists, or you can't change it." };
      if (!isSchemaMissing(result.error)) {
        captureError(result.error, {
          source: "admin-riders/rule",
          attrs: { event: "rule_save_failed", code: result.error.code },
        });
      }
      return { ok: false, error: writeErrorMessage(result.error, "rule") };
    }
  } catch (e) {
    if (isRiderSchemaPending(e)) return { ok: false, error: MIGRATION_PENDING_MESSAGE };
    captureError(e, { source: "admin-riders/rule", attrs: { event: "rule_save_failed" } });
    return { ok: false, error: writeErrorMessage({}, "rule") };
  }

  refresh();
  redirect("/admin/riders/incentives");
}

/** Switch a rule on or off. */
export async function toggleIncentiveRuleAction(id: string, active: boolean): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-rule:${admin.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_FAST };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!UUID.test(id) || typeof active !== "boolean") {
    return { ok: false, error: "That rule could not be identified. Reload the page and try again." };
  }

  const db = await createClient();
  const result = await setIncentiveRuleActive(db, id, active);
  if (!result.ok) {
    if (result.notFound) return { ok: false, error: "That rule no longer exists, or you can't change it." };
    if (!isSchemaMissing(result.error)) {
      captureError(result.error, {
        source: "admin-riders/rule",
        attrs: { event: "rule_toggle_failed", code: result.error.code },
      });
    }
    return { ok: false, error: writeErrorMessage(result.error, "rule") };
  }
  refresh();
  return { ok: true, message: active ? "Rule switched on." : "Rule switched off - it will not pay from now on." };
}
