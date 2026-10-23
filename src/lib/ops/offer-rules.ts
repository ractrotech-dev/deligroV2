/**
 * Offer rules — pure, no I/O. The same limits 0161's ops_upsert_offer
 * enforces (so a bad body answers 400 with a field before the round trip),
 * the state an offer list shows, and the usage figures.
 */
import { daysInRange, inRange, istDayKey } from "@/lib/metrics/ist";
import type { DateRange } from "@/lib/metrics/types";

export type OfferState = "scheduled" | "active" | "expired" | "inactive" | "exhausted";
export const OFFER_STATES: readonly OfferState[] = ["scheduled", "active", "expired", "inactive", "exhausted"];

export interface OfferTerms {
  code: string;
  label: string | null;
  kind: "percent" | "flat";
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  startsAt: string | null;
  expiresAt: string | null;
  maxPerCustomer: number | null;
  maxRedemptions: number | null;
  vendorIds: string[];
  zoneIds: string[];
  itemIds: string[];
  fundedBy: "platform" | "vendor";
  requestId: string | null;
}

export const MAX_OFFER_DAYS = 366;

/** Precedence: switched off > past its end > used up > not started > running. */
export function offerState(
  o: { active: boolean; startsAt: string | null; expiresAt: string | null; maxRedemptions: number | null; redemptions: number },
  now: Date,
): OfferState {
  if (!o.active) return "inactive";
  if (o.expiresAt && Date.parse(o.expiresAt) <= now.getTime()) return "expired";
  if (o.maxRedemptions !== null && o.redemptions >= o.maxRedemptions) return "exhausted";
  if (o.startsAt && Date.parse(o.startsAt) > now.getTime()) return "scheduled";
  return "active";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const optInt = (v: unknown): number | null | undefined =>
  v === null || v === undefined ? null : typeof v === "number" && Number.isInteger(v) ? v : undefined;
const ids = (v: unknown, max: number): string[] | undefined =>
  v === undefined || v === null ? [] : Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && UUID.test(x))
    ? [...new Set(v as string[])] : undefined;
const optIso = (v: unknown): string | null | undefined =>
  v === null || v === undefined || v === "" ? null : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined;

/**
 * Validate offer terms. `partial` validates only the fields present (an edit);
 * `requireExpiry` is true for managers (every manager offer must end).
 */
export function validateOfferTerms(
  input: unknown,
  now: Date,
  opts: { partial?: boolean; requireExpiry?: boolean } = {},
): { ok: true; value: Partial<OfferTerms> } | { ok: false; field: string } {
  if (!input || typeof input !== "object") return { ok: false, field: "body" };
  const i = input as Record<string, unknown>;
  const has = (k: string) => !opts.partial || k in i;
  const out: Partial<OfferTerms> = {};

  if (!opts.partial) {
    const code = typeof i.code === "string" ? i.code.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{3,20}$/.test(code)) return { ok: false, field: "code" };
    out.code = code;
  } else if ("code" in i) {
    return { ok: false, field: "code" };
  }
  if (has("label")) {
    if (i.label != null && (typeof i.label !== "string" || i.label.length > 60)) return { ok: false, field: "label" };
    out.label = typeof i.label === "string" ? i.label.trim() || null : null;
  }
  if (has("kind")) {
    if (i.kind !== "percent" && i.kind !== "flat") return { ok: false, field: "kind" };
    out.kind = i.kind;
  }
  if (has("value")) {
    const v = num(i.value);
    const kind = out.kind ?? (i.kind as string | undefined);
    if (v === undefined || v <= 0 || v > 100_000 || (kind === "percent" && v > 90)) return { ok: false, field: "value" };
    out.value = v;
  }
  if (has("minOrder")) {
    const v = i.minOrder === undefined ? 0 : num(i.minOrder);
    if (v === undefined || v < 0 || v > 100_000) return { ok: false, field: "minOrder" };
    out.minOrder = v;
  }
  if (has("maxDiscount")) {
    const v = i.maxDiscount === null || i.maxDiscount === undefined ? null : num(i.maxDiscount);
    if (v === undefined || (v !== null && (v <= 0 || v > 100_000))) return { ok: false, field: "maxDiscount" };
    out.maxDiscount = v;
  }
  if (has("startsAt")) {
    const v = optIso(i.startsAt);
    if (v === undefined) return { ok: false, field: "startsAt" };
    out.startsAt = v;
  }
  if (has("expiresAt")) {
    const v = optIso(i.expiresAt);
    if (v === undefined || (v === null && opts.requireExpiry)) return { ok: false, field: "expiresAt" };
    if (v !== null) {
      const t = Date.parse(v);
      if (t <= now.getTime() || t > now.getTime() + MAX_OFFER_DAYS * 86_400_000) return { ok: false, field: "expiresAt" };
    }
    out.expiresAt = v;
  }
  if (out.startsAt && out.expiresAt && Date.parse(out.startsAt) >= Date.parse(out.expiresAt)) return { ok: false, field: "startsAt" };
  for (const k of ["maxPerCustomer", "maxRedemptions"] as const) {
    if (!has(k)) continue;
    const v = optInt(i[k]);
    if (v === undefined || (v !== null && (v < 1 || v > 1_000_000))) return { ok: false, field: k };
    out[k] = v;
  }
  for (const [k, max] of [["vendorIds", 50], ["zoneIds", 20], ["itemIds", 100]] as const) {
    if (!has(k)) continue;
    const v = ids(i[k], max);
    if (!v) return { ok: false, field: k };
    out[k] = v;
  }
  if (has("fundedBy")) {
    const v = i.fundedBy === undefined ? "platform" : i.fundedBy;
    if (v !== "platform" && v !== "vendor") return { ok: false, field: "fundedBy" };
    out.fundedBy = v;
  }
  if (has("requestId")) {
    if (i.requestId != null && (typeof i.requestId !== "string" || !UUID.test(i.requestId))) return { ok: false, field: "requestId" };
    out.requestId = (i.requestId as string | null | undefined) ?? null;
  }
  if (!opts.partial && (out.itemIds?.length ?? 0) > 0 && (out.vendorIds?.length ?? 0) === 0) return { ok: false, field: "vendorIds" };
  return { ok: true, value: out };
}

export interface OfferRedemption {
  orderId: string;
  customerId: string;
  discount: number;
  createdAt: string;
  restaurantId: string;
  /** The order was later cancelled. */
  cancelled: boolean;
  orderTotal: number;
  fundedBy: "platform" | "vendor" | null;
  /** First counted order this customer ever placed. */
  firstOrder: boolean;
}

export interface OfferUsage {
  from: string;
  to: string;
  redemptions: number;
  uniqueCustomers: number;
  newCustomers: number;
  orders: number;
  cancelledRedemptions: number;
  discountGiven: number;
  discountByFunder: { vendor: number; platform: number };
  customerPaid: number;
  remainingRedemptions: number | null;
  byVendor: { vendorId: string; redemptions: number; discountGiven: number }[];
  daily: { date: string; redemptions: number; discountGiven: number }[];
}

/**
 * Usage over `range`. A redemption on an order later cancelled is counted in
 * `cancelledRedemptions` and left out of the discount and paid totals (the
 * customer was never charged for it). `totalRedemptions` is all-time, for the
 * remaining count.
 */
export function offerUsage(
  redemptions: OfferRedemption[],
  range: DateRange,
  limits: { maxRedemptions: number | null; totalRedemptions: number },
): OfferUsage {
  const rows = redemptions.filter((r) => inRange(r.createdAt, range));
  const kept = rows.filter((r) => !r.cancelled);
  const daily = daysInRange(range).map((date) => ({ date, redemptions: 0, discountGiven: 0 }));
  const byDay = new Map(daily.map((d) => [d.date, d]));
  const byVendor = new Map<string, { vendorId: string; redemptions: number; discountGiven: number }>();
  const funder = { vendor: 0, platform: 0 };
  for (const r of kept) {
    const d = byDay.get(istDayKey(r.createdAt));
    if (d) { d.redemptions++; d.discountGiven += r.discount; }
    const v = byVendor.get(r.restaurantId) ?? { vendorId: r.restaurantId, redemptions: 0, discountGiven: 0 };
    v.redemptions++; v.discountGiven += r.discount;
    byVendor.set(r.restaurantId, v);
    if (r.fundedBy === "vendor") funder.vendor += r.discount; else funder.platform += r.discount;
  }
  return {
    from: range.from,
    to: range.to,
    redemptions: kept.length,
    uniqueCustomers: new Set(kept.map((r) => r.customerId)).size,
    newCustomers: new Set(kept.filter((r) => r.firstOrder).map((r) => r.customerId)).size,
    orders: new Set(kept.map((r) => r.orderId)).size,
    cancelledRedemptions: rows.length - kept.length,
    discountGiven: funder.vendor + funder.platform,
    discountByFunder: funder,
    customerPaid: kept.reduce((s, r) => s + r.orderTotal, 0),
    remainingRedemptions: limits.maxRedemptions === null ? null : Math.max(0, limits.maxRedemptions - limits.totalRedemptions),
    byVendor: [...byVendor.values()].sort((a, b) => b.discountGiven - a.discountGiven || a.vendorId.localeCompare(b.vendorId)),
    daily,
  };
}

/** "••••••3210" — the last four digits only, or null. */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return "••••••" + digits.slice(-4);
}

/**
 * Does a code apply at this shop? The checkout's own rule (price_coupon, 0161): a code
 * owned by one shop applies there only; a code with a shop list applies only at a
 * listed shop; a code with a zone list only in a listed zone; both lists must pass.
 * A code with no lists is platform-wide. (Not `restaurant_id is null` alone: that also
 * holds for a code written for a few other shops.)
 */
export function offerAppliesAtShop(
  o: { ownerShopId: string | null; vendorIds: string[]; zoneIds: string[] },
  shop: { id: string; zoneId: string | null },
): boolean {
  if (o.ownerShopId && o.ownerShopId !== shop.id) return false;
  if (o.vendorIds.length > 0 && !o.vendorIds.includes(shop.id)) return false;
  if (o.zoneIds.length > 0 && !(shop.zoneId && o.zoneIds.includes(shop.zoneId))) return false;
  return true;
}
