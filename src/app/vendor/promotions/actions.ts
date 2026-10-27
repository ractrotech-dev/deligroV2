"use server";

import { revalidatePath } from "next/cache";
import { vendorFeatureOn } from "@/lib/features/guards.server";
import { FEATURE_OFF_MESSAGE } from "@/lib/features/catalog";
import { redirect } from "next/navigation";
import { requireVendorAccess } from "@/lib/auth/vendor-access";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import {
  createPromotion,
  deletePromotion,
  getPromotion,
  setPromotionActive,
  updatePromotion,
} from "@/lib/data-access/promotions";
import {
  normalizeCode,
  validatePromotion,
  type PromotionDraft,
  type PromotionKind,
} from "@/lib/promotion-rules";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

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

/**
 * The two fields a vendor does not get to choose.
 *
 * `restaurantId` comes from the session's own shop and `fundedBy` is always
 * `"vendor"` — both ignoring whatever arrived in the form. The RLS policies
 * from 0041 enforce the same two facts at the database, so this is the
 * readable half of a guard that holds either way; a vendor posting another
 * shop's id by hand is refused by the policy, not merely by this function.
 */
function parse(form: FormData, restaurantId: string): PromotionDraft {
  const kind = (form.get("kind") as PromotionKind) ?? "percent";
  return {
    code: normalizeCode(String(form.get("code") ?? "")),
    label: String(form.get("label") ?? "").trim() || null,
    kind,
    value: toInt(form.get("value"), 0),
    minOrder: Math.max(0, toInt(form.get("minOrder"), 0)),
    maxDiscount: kind === "percent" ? toOptionalInt(form.get("maxDiscount")) : null,
    active: form.get("active") === "on",
    expiresAt: toIso(form.get("expiresAt")),
    maxPerCustomer: toOptionalInt(form.get("maxPerCustomer")),
    maxRedemptions: toOptionalInt(form.get("maxRedemptions")),
    restaurantId,
    fundedBy: "vendor",
  };
}

/**
 * A vendor may only touch a code that belongs to a shop they own AND that the
 * shop pays for. A Deligro-funded code an admin or manager scoped to this shop
 * is listed here but is not the vendor's to edit, pause or delete — the same
 * rule as `owned()` in /api/vendor/offers/[code].
 *
 * The RLS policies already scope every read and write (0180 added
 * `funded_by = 'vendor'` to the update and delete USING clauses), so this is
 * the second lock rather than the only one — but it is the one that produces a
 * sentence. Without it, editing someone else's code would silently update zero
 * rows and report success.
 */
async function ownedCode(code: string, restaurantId: string): Promise<boolean> {
  const existing = await getPromotion(code);
  return (
    existing != null &&
    existing.restaurantId === restaurantId &&
    existing.fundedBy === "vendor"
  );
}

export async function saveVendorPromotionAction(
  code: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  await requireVendorAccess();
  if (!(await vendorFeatureOn("vendor.promotions"))) {
    return { ok: false, error: FEATURE_OFF_MESSAGE };
  }
  if (!isSupabaseConfigured) {
    return {
      ok: false,
      error: "Demo mode: connect Supabase to run promotions.",
    };
  }

  const restaurant = await resolveVendorRestaurant();
  if (!restaurant) {
    return { ok: false, error: "No shop is linked to this account yet." };
  }

  const draft = parse(form, restaurant.id);
  const problem = validatePromotion(draft);
  if (problem) return { ok: false, error: problem };

  try {
    if (code) {
      if (!(await ownedCode(code, restaurant.id))) {
        return { ok: false, error: "That code doesn't belong to this shop." };
      }
      await updatePromotion(code, draft);
    } else {
      await createPromotion(draft);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("duplicate key") || message.includes("23505")) {
      // Codes are unique across the whole platform — see promotions.ts on why
      // the checkout cannot be asked to guess which shop a code meant.
      return {
        ok: false,
        error: `${draft.code} is already taken. Promo codes are unique across Deligro — try adding your shop's name.`,
      };
    }
    return { ok: false, error: "Couldn't save that code. Try again." };
  }

  revalidateVendorPromotions();
  redirect("/vendor/promotions");
}

/**
 * The offer badge on this shop's card is derived from these codes (0041), so a
 * write here changes what customers see in the feed, not just this screen.
 */
function revalidateVendorPromotions() {
  revalidatePath("/", "layout");
  revalidatePath("/vendor/promotions");
}

async function mutate(
  code: string,
  fn: (restaurantId: string) => Promise<unknown>
): Promise<ActionResult> {
  await requireVendorAccess();
  if (!(await vendorFeatureOn("vendor.promotions"))) {
    return { ok: false, error: FEATURE_OFF_MESSAGE };
  }
  if (!isSupabaseConfigured) {
    return { ok: false, error: "Demo mode: connect Supabase to run promotions." };
  }
  const restaurant = await resolveVendorRestaurant();
  if (!restaurant) return { ok: false, error: "No shop is linked to this account." };
  if (!(await ownedCode(code, restaurant.id))) {
    return { ok: false, error: "That code doesn't belong to this shop." };
  }

  try {
    await fn(restaurant.id);
  } catch {
    return { ok: false, error: "That didn't go through. Try again." };
  }
  revalidateVendorPromotions();
  return { ok: true };
}

export async function setVendorPromotionActiveAction(
  code: string,
  active: boolean
) {
  return mutate(code, () => setPromotionActive(code, active));
}

export async function deleteVendorPromotionAction(code: string) {
  return mutate(code, () => deletePromotion(code));
}
