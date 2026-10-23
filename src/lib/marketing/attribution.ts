/**
 * Campaign attribution and performance — pure, no I/O.
 *
 * An order is attributed to a campaign when it is a counted, non-cancelled
 * order placed inside the window and either (a) redeemed the campaign's linked
 * code, or (b) is at one of the campaign's shops (for sponsored dishes: holds
 * one of its dishes) and its customer clicked the campaign within the 24 h
 * before ordering. Each order counts once. Customer identity never leaves
 * this module — the result carries counts only.
 */
import { istDayKey, daysInRange, inRange, previousPeriod } from "@/lib/metrics/ist";
import type { DateRange } from "@/lib/metrics/types";

export const ATTRIBUTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AttributionCampaign {
  id: string;
  kind: "featured_store" | "banner" | "seasonal" | "sponsored_product";
  startsAt: string;
  endsAt: string;
  offerCode: string | null;
  vendorIds: string[];
  itemIds: string[];
}

export interface AttrOrder {
  id: string;
  customerId: string | null;
  restaurantId: string;
  createdAt: string;
  status: string;
  total: number;
  couponCode: string | null;
  menuItemIds: string[];
  /** ops_counts_as_order: false for an unpaid online checkout. */
  counted: boolean;
}

export interface AttrClick {
  customerId: string | null;
  createdAt: string;
}

export interface AttrEvent {
  kind: "impression" | "click";
  createdAt: string;
}

export interface AttrRedemption {
  orderId: string;
  discount: number;
  createdAt: string;
}

export interface CampaignPerformance {
  from: string;
  to: string;
  impressions: number;
  clicks: number;
  ctr: number;
  redemptions: number;
  discountGiven: number;
  attributedOrders: number;
  attributedSales: number;
  attributedCustomers: number;
  comparison: { beforeOrders: number; beforeSales: number; duringOrders: number; duringSales: number } | null;
  daily: { date: string; impressions: number; clicks: number; attributedOrders: number; attributedSales: number }[];
}

const live = (o: AttrOrder) => o.counted && o.status !== "cancelled";

function atCampaignShop(c: AttributionCampaign, o: AttrOrder): boolean {
  if (c.kind === "sponsored_product") return o.menuItemIds.some((i) => c.itemIds.includes(i));
  return c.vendorIds.length === 0 || c.vendorIds.includes(o.restaurantId);
}

/** The orders a campaign earned. Clicks are the campaign's (or its banner's). */
export function attributeOrders(
  c: AttributionCampaign,
  orders: AttrOrder[],
  clicks: AttrClick[],
): { orderIds: string[]; orders: number; sales: number; customers: number } {
  const start = Date.parse(c.startsAt), end = Date.parse(c.endsAt);
  const clicksBy = new Map<string, number[]>();
  for (const k of clicks) {
    if (!k.customerId) continue;
    const list = clicksBy.get(k.customerId) ?? [];
    list.push(Date.parse(k.createdAt));
    clicksBy.set(k.customerId, list);
  }
  const ids = new Set<string>();
  const customers = new Set<string>();
  let sales = 0;
  for (const o of orders) {
    if (!live(o) || ids.has(o.id)) continue;
    const t = Date.parse(o.createdAt);
    if (t < start || t >= end) continue;
    const byCode = c.offerCode !== null && o.couponCode === c.offerCode;
    const byClick = o.customerId !== null && atCampaignShop(c, o)
      && (clicksBy.get(o.customerId) ?? []).some((k) => k <= t && t - k <= ATTRIBUTION_WINDOW_MS);
    if (!byCode && !byClick) continue;
    ids.add(o.id);
    sales += o.total;
    if (o.customerId) customers.add(o.customerId);
  }
  return { orderIds: [...ids], orders: ids.size, sales, customers: customers.size };
}

/**
 * Performance over `range` (inclusive IST days). `shopOrders` are the
 * campaign shops' orders over the range and the equal period before it —
 * used for the featured / sponsored "Before / During" comparison only.
 */
export function campaignPerformance(
  c: AttributionCampaign,
  events: AttrEvent[],
  clicks: AttrClick[],
  orders: AttrOrder[],
  redemptions: AttrRedemption[],
  range: DateRange,
  shopOrders: AttrOrder[] = [],
): CampaignPerformance {
  const inR = (at: string) => inRange(at, range);
  const ev = events.filter((e) => inR(e.createdAt));
  const impressions = ev.filter((e) => e.kind === "impression").length;
  const clickCount = ev.filter((e) => e.kind === "click").length;
  const attributed = attributeOrders(c, orders.filter((o) => inR(o.createdAt)), clicks);
  const attributedSet = new Set(attributed.orderIds);
  const red = redemptions.filter((r) => inR(r.createdAt));

  const days = daysInRange(range);
  const daily = days.map((date) => ({ date, impressions: 0, clicks: 0, attributedOrders: 0, attributedSales: 0 }));
  const byDay = new Map(daily.map((d) => [d.date, d]));
  for (const e of ev) {
    const d = byDay.get(istDayKey(e.createdAt));
    if (d) { if (e.kind === "impression") d.impressions++; else d.clicks++; }
  }
  for (const o of orders) {
    if (!attributedSet.has(o.id)) continue;
    const d = byDay.get(istDayKey(o.createdAt));
    if (d) { d.attributedOrders++; d.attributedSales += o.total; }
  }

  let comparison: CampaignPerformance["comparison"] = null;
  if (c.kind === "featured_store" || c.kind === "sponsored_product") {
    const before = previousPeriod(range);
    const pick = (o: AttrOrder) => live(o) && atCampaignShop(c, o);
    const during = shopOrders.filter((o) => pick(o) && inR(o.createdAt));
    const prior = shopOrders.filter((o) => pick(o) && inRange(o.createdAt, before));
    comparison = {
      beforeOrders: prior.length,
      beforeSales: prior.reduce((s, o) => s + o.total, 0),
      duringOrders: during.length,
      duringSales: during.reduce((s, o) => s + o.total, 0),
    };
  }

  return {
    from: range.from,
    to: range.to,
    impressions,
    clicks: clickCount,
    ctr: impressions > 0 ? Math.round((clickCount / impressions) * 1000) / 10 : 0,
    redemptions: red.length,
    discountGiven: red.reduce((s, r) => s + r.discount, 0),
    attributedOrders: attributed.orders,
    attributedSales: attributed.sales,
    attributedCustomers: attributed.customers,
    comparison,
    daily,
  };
}
