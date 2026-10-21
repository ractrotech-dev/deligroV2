"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/obs/emit";
import { formString } from "@/lib/utils/form-data";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { getPayout } from "@/lib/data-access/rider-earnings";
import {
  insertAdjustment,
  recordPayout,
  resolveRiderOrder,
  riderExists,
} from "@/lib/data-access/admin-riders";
import { istDay } from "@/lib/rider/earnings-math";
import {
  MIGRATION_PENDING_MESSAGE,
  describePayout,
  formatMoney,
  isSchemaMissing,
  parseAdjustment,
  parsePayout,
  payoutErrorMessage,
  writeErrorMessage,
  type ActionResult,
} from "@/lib/rider/admin-money";

/**
 * The Money tab's two writes: an adjustment (bonus, adjustment, deduction,
 * salary) and a payout.
 *
 * Both run on the admin's OWN cookie client, not the service role: the
 * adjustment policy needs `is_admin() and created_by = auth.uid()` and
 * `record_rider_payout` checks `is_admin()` itself, and both are only
 * meaningful when the database can see who is asking. The role check here is
 * the first line of each action (AGENTS.md rule 3); the database's is the
 * second, not a substitute.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO = "Demo mode: connect Supabase to record rider money. Nothing was saved.";
const TOO_FAST = "Too many changes in a minute. Wait a moment and try again.";

function refresh(driverId: string): void {
  revalidatePath(`/admin/riders/${driverId}`);
  revalidatePath("/admin/riders");
}

/** Add a bonus, adjustment, deduction or salary entry to a rider's ledger. */
export async function addAdjustmentAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-adjustment:${admin.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_FAST };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const driverId = formString(form, "driverId");
  if (!UUID.test(driverId)) return { ok: false, error: "That rider could not be identified. Reload the page and try again." };

  const parsed = parseAdjustment(form, { today: istDay(new Date()) });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const entry = parsed.value;

  try {
    if (!(await riderExists(driverId))) return { ok: false, error: "That rider no longer exists." };
    let orderId: string | null = null;
    if (entry.orderCode) {
      orderId = await resolveRiderOrder(driverId, entry.orderCode);
      if (!orderId) {
        return { ok: false, error: `This rider has no delivery for order #${entry.orderCode}. Check the code, or leave it blank.` };
      }
    }
    const db = await createClient();
    const result = await insertAdjustment(db, admin.id, driverId, entry, orderId);
    if (!result.ok) {
      if (!isSchemaMissing(result.error)) {
        captureError(result.error, {
          source: "admin-riders/adjustment",
          attrs: { event: "adjustment_failed", driverId, code: result.error.code },
        });
      }
      return { ok: false, error: writeErrorMessage(result.error, "adjustment") };
    }
  } catch (e) {
    if (isRiderSchemaPending(e)) return { ok: false, error: MIGRATION_PENDING_MESSAGE };
    captureError(e, { source: "admin-riders/adjustment", attrs: { event: "adjustment_failed", driverId } });
    return { ok: false, error: writeErrorMessage({}, "adjustment") };
  }

  refresh(driverId);
  const verb = entry.kind === "deduction" ? "Deducted" : entry.kind === "salary" ? "Added salary of" : "Added";
  const noun = entry.kind === "bonus" ? " bonus" : "";
  return { ok: true, message: `${verb} ${formatMoney(entry.amount)}${noun} - it shows in the records below.` };
}

/**
 * Settle everything owed up to a date. The database picks the rows and the
 * amount; this reads the payout back and reports what was ACTUALLY recorded,
 * because the preview the operator clicked on can be stale.
 */
export async function recordPayoutAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-payout:${admin.id}`, 10, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_FAST };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const driverId = formString(form, "driverId");
  if (!UUID.test(driverId)) return { ok: false, error: "That rider could not be identified. Reload the page and try again." };

  const parsed = parsePayout(form, { today: istDay(new Date()) });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const payout = parsed.value;

  const db = await createClient();
  const result = await recordPayout(db, driverId, payout);
  if (!result.ok) {
    const expected =
      isSchemaMissing(result.error) || /nothing_to_pay|invalid_payout|forbidden/.test(result.error.message ?? "");
    if (!expected) {
      captureError(result.error, {
        source: "admin-riders/payout",
        attrs: { event: "payout_failed", driverId, code: result.error.code },
      });
    }
    return { ok: false, error: payoutErrorMessage(result.error) };
  }

  refresh(driverId);

  let recorded: Awaited<ReturnType<typeof getPayout>> = null;
  try {
    recorded = await getPayout(driverId, result.id);
  } catch (e) {
    // The payout IS recorded; only the read-back failed.
    captureError(e, { source: "admin-riders/payout", attrs: { event: "payout_readback_failed", driverId } });
  }
  if (!recorded) {
    return { ok: true, message: "Payout recorded. Reload to see the amount in the payouts list." };
  }

  const rawPreview = formString(form, "previewAmount");
  const previewed = rawPreview !== "" && Number.isFinite(Number(rawPreview)) ? Number(rawPreview) : null;
  return { ok: true, message: describePayout(recorded, payout.method, previewed) };
}
