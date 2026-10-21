import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listVendorPromotions, type Promotion } from "@/lib/data-access/promotions";
import { columnKnownMissing, isMissingColumn, rememberColumn } from "@/lib/data-access/schema-probe";
import { orderFoodValue } from "@/lib/settlements/math";

/**
 * Offers (requirements §9): the shop's own codes with what each earned it,
 * and the Deligro-funded promotions running at the shop, read-only.
 */
export interface OfferImpact {
  orders: number;
  /** Food value of those orders (the shop's sale). */
  sales: number;
  discount: number;
}

export type VendorOffer = Promotion & { impact: OfferImpact; status: "live" | "scheduled" | "expired" | "paused" | "used_up" };

export interface PlatformOffer {
  code: string;
  label: string | null;
  kind: "percent" | "flat";
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  startsAt: string | null;
  expiresAt: string | null;
  /** Only this shop vs. every shop. */
  shopOnly: boolean;
  impact: OfferImpact;
}

export function offerStatus(p: Pick<Promotion, "active" | "startsAt" | "expiresAt" | "maxRedemptions" | "redemptions">, now = Date.now()): VendorOffer["status"] {
  if (p.expiresAt && Date.parse(p.expiresAt) <= now) return "expired";
  if (p.maxRedemptions != null && p.redemptions >= p.maxRedemptions) return "used_up";
  if (!p.active) return "paused";
  if (p.startsAt && Date.parse(p.startsAt) > now) return "scheduled";
  return "live";
}

/** Orders at this shop that used each code, as impact figures. RLS: the owner's orders. */
async function impactByCode(restaurantId: string): Promise<Map<string, OfferImpact>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("orders")
    .select("coupon_code, total, delivery_fee, tax_amount, tip, discount, discount_funded_by")
    .eq("restaurant_id", restaurantId)
    .not("coupon_code", "is", null)
    .neq("status", "cancelled")
    .limit(5000);
  const out = new Map<string, OfferImpact>();
  if (error) return out;
  for (const r of data ?? []) {
    const code = String(r.coupon_code);
    const cur = out.get(code) ?? { orders: 0, sales: 0, discount: 0 };
    cur.orders++;
    cur.discount += Number(r.discount) || 0;
    cur.sales += orderFoodValue({
      total: Number(r.total) || 0,
      deliveryFee: Number(r.delivery_fee) || 0,
      taxAmount: Number(r.tax_amount) || 0,
      tip: Number(r.tip) || 0,
      discount: Number(r.discount) || 0,
      discountFundedBy: r.discount_funded_by === "platform" ? "platform" : "vendor",
    });
    out.set(code, cur);
  }
  return out;
}

const START_COLUMN = "coupons.starts_at";

/**
 * Platform-funded codes that work at this shop. `coupons` is not readable by
 * vendors (0041), so this uses the service role — for the session's shop only,
 * and only codes that are live or scheduled, never another shop's own codes.
 */
async function platformOffers(restaurantId: string): Promise<Omit<PlatformOffer, "impact">[]> {
  const admin = createAdminClient();
  const base = "code, label, kind, value, min_order, max_discount, expires_at, restaurant_id";
  const run = (cols: string) =>
    admin
      .from("coupons")
      .select(cols)
      .eq("funded_by", "platform")
      .eq("active", true)
      .or(`restaurant_id.is.null,restaurant_id.eq.${restaurantId}`)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("created_at", { ascending: false })
      .limit(50);
  let res = columnKnownMissing(START_COLUMN) ? await run(base) : await run(`${base}, starts_at`);
  if (res.error && isMissingColumn(res.error)) {
    rememberColumn(START_COLUMN, false);
    res = await run(base);
  }
  if (res.error) return [];
  return ((res.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    code: String(r.code),
    label: (r.label as string | null) ?? null,
    kind: r.kind === "flat" ? "flat" : "percent",
    value: Number(r.value),
    minOrder: Number(r.min_order),
    maxDiscount: r.max_discount == null ? null : Number(r.max_discount),
    startsAt: (r.starts_at as string | null | undefined) ?? null,
    expiresAt: (r.expires_at as string | null) ?? null,
    shopOnly: r.restaurant_id === restaurantId,
  }));
}

export async function getVendorOffers(restaurantId: string): Promise<{ own: VendorOffer[]; platform: PlatformOffer[] }> {
  const [own, platform, impact] = await Promise.all([
    listVendorPromotions(restaurantId),
    platformOffers(restaurantId),
    impactByCode(restaurantId),
  ]);
  const none: OfferImpact = { orders: 0, sales: 0, discount: 0 };
  return {
    own: own.map((p) => ({ ...p, impact: impact.get(p.code) ?? none, status: offerStatus(p) })),
    platform: platform.map((p) => ({ ...p, impact: impact.get(p.code) ?? none })),
  };
}
