"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { adminSaveOffer, adminSetOfferActive, OfferWriteError } from "@/lib/data-access/admin-offers";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formString } from "@/lib/utils/form-data";
import {
  deletePromotion,
} from "@/lib/data-access/promotions";
import {
  normalizeCode,
  validatePromotion,
  type PromotionDraft,
  type PromotionFunding,
  type PromotionKind,
} from "@/lib/promotion-rules";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** A blank numeric field means "no limit", which is not the same as 0. */
function toOptionalInt(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toInt(raw: FormDataEntryValue | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toIso(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parse(form: FormData): PromotionDraft {
  const kind = (form.get("kind") as PromotionKind) ?? "percent";
  const restaurantId = formString(form, "restaurantId").trim() || null;
  const fundedBy = (form.get("fundedBy") as PromotionFunding) ?? "platform";
  return {
    code: normalizeCode(formString(form, "code")),
    label: formString(form, "label").trim() || null,
    kind,
    value: toInt(form.get("value"), 0),
    minOrder: Math.max(0, toInt(form.get("minOrder"), 0)),
    // A flat code has no ceiling to set; forcing null here keeps a stale value
    // from riding along when someone switches a percentage code to flat.
    maxDiscount: kind === "percent" ? toOptionalInt(form.get("maxDiscount")) : null,
    active: form.get("active") === "on",
    expiresAt: toIso(form.get("expiresAt")),
    maxPerCustomer: toOptionalInt(form.get("maxPerCustomer")),
    maxRedemptions: toOptionalInt(form.get("maxRedemptions")),
    restaurantId,
    // "Vendor pays" is meaningless without a shop, and the constraint in 0041
    // would refuse it. Correct it here so the operator gets the sentence from
    // validatePromotion rather than a constraint-violation toast.
    fundedBy: restaurantId ? fundedBy : "platform",
  };
}

/** Both create and edit come through here — `code` empty means create. */
export async function saveCouponAction(
  code: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const admin = await requireRole("admin");
  if (!isSupabaseConfigured) {
    return {
      ok: false,
      error:
        "Demo mode: connect Supabase to create promo codes. The form works, but saving needs a backend.",
    };
  }

  const draft = parse(form);
  const problem = validatePromotion(draft);
  if (problem) return { ok: false, error: problem };

  // The audited path (0161): the change, its ops_audit_log row and its
  // coupon_changes row are one transaction, with this admin as the actor.
  try {
    await adminSaveOffer(admin.id, code || null, draft);
  } catch (err) {
    const why = err instanceof OfferWriteError ? err.code : "";
    if (why === "code_taken") return { ok: false, error: `${draft.code} already exists. Pick another code.` };
    if (why === "bad_request") return { ok: false, error: `Check the ${err instanceof OfferWriteError && err.field ? err.field : "form"} field.` };
    if (why === "expired") return { ok: false, error: "That code has ended. Give it a later end date before switching it on." };
    if (why === "exhausted") return { ok: false, error: "That code has been used up. Raise its limit before switching it on." };
    return { ok: false, error: "Couldn't save that code. Try again." };
  }

  revalidateCoupons();
  redirect("/admin/coupons");
}

/**
 * The shop badge is derived from live coupons (0041), so any write here can
 * change what the customer app renders on a restaurant card. Rebuilding the
 * layout is what keeps the two in step.
 */
function revalidateCoupons() {
  revalidatePath("/", "layout");
  revalidatePath("/admin/coupons");
}

async function mutate(fn: () => Promise<unknown>): Promise<ActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) {
    return { ok: false, error: "Demo mode: connect Supabase to manage promo codes." };
  }
  try {
    await fn();
  } catch {
    return { ok: false, error: "That didn't go through. Try again." };
  }
  revalidateCoupons();
  return { ok: true };
}

export async function setCouponActiveAction(code: string, active: boolean) {
  const admin = await requireRole("admin");
  return mutate(() => adminSetOfferActive(admin.id, code, active));
}

export async function deleteCouponAction(code: string) {
  return mutate(() => deletePromotion(code));
}
