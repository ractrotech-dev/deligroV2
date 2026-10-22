import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PromotionInput } from "@/lib/data-access/promotions";

/**
 * The admin console's promo-code writes, on the same audited path as the
 * Manager app (0161's ops_upsert_offer / ops_offer_action): one change, one
 * ops_audit_log row, one coupon_changes row. Callers have already checked
 * requireRole("admin") — these run as the service role with the admin as the
 * actor, and the RPCs re-check that actor.
 *
 * Vendors' own codes (the Partner app) keep writing through their session
 * (promotions.ts); the coupon_changes trigger records those too.
 */

export class OfferWriteError extends Error {
  constructor(readonly code: string, readonly field?: string) {
    super(code);
    this.name = "OfferWriteError";
  }
}

const REASON = "Changed in the admin console";

function terms(input: PromotionInput): Record<string, unknown> {
  return {
    label: input.label,
    kind: input.kind,
    value: input.value,
    minOrder: input.minOrder,
    maxDiscount: input.maxDiscount,
    startsAt: input.startsAt ?? null,
    expiresAt: input.expiresAt,
    maxPerCustomer: input.maxPerCustomer,
    maxRedemptions: input.maxRedemptions,
    vendorIds: input.restaurantId ? [input.restaurantId] : [],
    fundedBy: input.fundedBy,
  };
}

function raise(error: { message?: string; details?: string | null }): never {
  throw new OfferWriteError((error.message ?? "action_failed").trim(), error.details ?? undefined);
}

/** Create (existingCode null) or edit a code, then set its on/off switch. */
export async function adminSaveOffer(adminId: string, existingCode: string | null, input: PromotionInput): Promise<void> {
  const db = createAdminClient();
  const code = (existingCode ?? input.code).trim().toUpperCase();
  if (existingCode) {
    const { data } = await db.from("coupons").select("updated_at, restaurant_id, funded_by").eq("code", code).maybeSingle();
    const cur = data as { updated_at: string; restaurant_id: string | null; funded_by: string } | null;
    if (!cur) throw new OfferWriteError("not_found");
    // The shop and the payer are fixed once a code exists (see promotions.ts).
    const { vendorIds: _v, fundedBy: _f, ...rest } = terms(input);
    void _v; void _f;
    const { error } = await db.rpc("ops_upsert_offer", {
      p_actor: adminId, p_code: code, p_terms: rest, p_expected_updated_at: cur.updated_at, p_reason: REASON,
      p_client_action_id: randomUUID(),
    });
    if (error) raise(error);
  } else {
    const { error } = await db.rpc("ops_upsert_offer", {
      p_actor: adminId, p_code: code, p_terms: terms(input), p_expected_updated_at: null, p_reason: null,
      p_client_action_id: randomUUID(),
    });
    if (error) raise(error);
  }
  const { data } = await db.from("coupons").select("active").eq("code", code).maybeSingle();
  if (data && (data as { active: boolean }).active !== input.active) await adminSetOfferActive(adminId, code, input.active);
}

export async function adminSetOfferActive(adminId: string, code: string, active: boolean): Promise<void> {
  const { error } = await createAdminClient().rpc("ops_offer_action", {
    p_actor: adminId, p_code: code.trim().toUpperCase(), p_action: active ? "activate" : "deactivate", p_reason: REASON,
    p_client_action_id: randomUUID(),
  });
  if (error) raise(error);
}
