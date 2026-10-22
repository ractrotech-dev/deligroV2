/**
 * Report builders — pure. Each turns what the server fetched (0157/0158
 * rollups, settlement headers, payouts) into rows, totals over every row,
 * highlights and notes. Money figures are never re-derived here: they come
 * from the SQL mirrors of src/lib/metrics, so a report's totals equal the
 * dashboard's and Finance's for the same orders (§13, §18.4).
 *
 * Totals: sums of money and count columns; rates recomputed from summed
 * numerators and denominators (never an average of averages); minutes as
 * weighted means.
 */
import type { DateRange } from "@/lib/metrics";
import { dailyFromFinanceRollup, salesFromRollup, type FinanceRollup } from "@/lib/ops/finance-rollup";
import { cashDayStatus } from "@/lib/ops/finance-rules";
import { meanMinutes, num, rate, sumKeys, type Built, type ReportRow } from "@/lib/reports/payload";

const CANCELLED_NOTE = "Cancelled orders are excluded from net sales; see the Cancellation report.";
const REFUND_NOTE = "Each refund appears once; a correction recovers a refund from a paid vendor and is not a second refund.";

const whole = (rows: ReportRow[], totals: ReportRow | null, extra: Partial<Built> = {}): Built => ({
  rows, totalRows: rows.length, totals, highlights: [], notes: [], paged: false, ...extra,
});

// ── day-based, from ops_finance_rollup ──────────────────────────────────

export function buildSales(r: FinanceRollup, range: DateRange): Built {
  const days = dailyFromFinanceRollup(r, range);
  const rows = days.map((d) => ({
    date: d.date, orders: d.orders, customerPaid: d.customerPaid, grossSales: d.grossSales,
    discounts: d.discountsVendor + d.discountsPlatform, refunds: d.refunds, netSales: d.netSales,
    deliveryFees: d.deliveryFees, aov: d.orders > 0 ? Math.round(d.customerPaid / d.orders) : 0,
  }));
  const s = salesFromRollup(r.summary);
  const totals: ReportRow = {
    date: "Total", orders: s.orders, customerPaid: s.customerPaid, grossSales: s.grossSales, discounts: s.discounts.total,
    refunds: s.refunds.total, netSales: s.netSales, deliveryFees: s.deliveryFees, aov: s.orders > 0 ? Math.round(s.customerPaid / s.orders) : 0,
  };
  return whole(rows, totals, {
    highlights: [
      { key: "customerPaid", label: "Customer paid", value: s.customerPaid, type: "money" },
      { key: "netSales", label: "Net sales", value: s.netSales, type: "money" },
      { key: "orders", label: "Orders", value: s.orders, type: "int" },
      { key: "cancelled", label: "Cancelled (apart)", value: s.cancelled.value, type: "money" },
    ],
    notes: [CANCELLED_NOTE],
  });
}

export function buildAverageOrder(r: FinanceRollup, range: DateRange): Built {
  const days = dailyFromFinanceRollup(r, range);
  const rows = days.map((d) => ({ date: d.date, orders: d.orders, aov: d.orders > 0 ? Math.round(d.customerPaid / d.orders) : 0 }));
  const s = salesFromRollup(r.summary);
  return whole(rows, { date: "Total", orders: s.orders, aov: s.orders > 0 ? Math.round(s.customerPaid / s.orders) : 0 }, {
    highlights: [{ key: "aov", label: "Average order", value: s.orders > 0 ? Math.round(s.customerPaid / s.orders) : 0, type: "money" }],
  });
}

/** `paidOut`: vendor settlements paid (net payable) and rider payouts, per IST day. */
export function buildFinanceDaily(
  r: FinanceRollup,
  range: DateRange,
  paidOut: { vendor: Map<string, number>; rider: Map<string, number> }
): Built {
  const days = dailyFromFinanceRollup(r, range);
  const rows = days.map((d) => ({
    date: d.date, customerPaid: d.customerPaid, grossSales: d.grossSales, discountsVendor: d.discountsVendor,
    discountsPlatform: d.discountsPlatform, refunds: d.refunds, netSales: d.netSales, deliveryFees: d.deliveryFees,
    commission: d.commission + d.otherCharges, commissionGst: d.commissionGst,
    vendorPaidOut: paidOut.vendor.get(d.date) ?? 0, riderPaidOut: Math.round((paidOut.rider.get(d.date) ?? 0) * 100) / 100,
  }));
  const s = salesFromRollup(r.summary);
  const sums = sumKeys(rows, ["vendorPaidOut", "riderPaidOut"], ["riderPaidOut"]);
  const totals: ReportRow = {
    date: "Total", customerPaid: s.customerPaid, grossSales: s.grossSales, discountsVendor: s.discounts.vendor, discountsPlatform: s.discounts.platform,
    refunds: s.refunds.total, netSales: s.netSales, deliveryFees: s.deliveryFees,
    commission: s.platformCommission.commission + s.platformCommission.otherCharges, commissionGst: s.platformCommission.commissionGst, ...sums,
  };
  return whole(rows, totals, {
    highlights: [
      { key: "netSales", label: "Net sales", value: s.netSales, type: "money" },
      { key: "platformCommission", label: "Platform commission", value: s.platformCommission.total, type: "money" },
      { key: "vendorPaidOut", label: "Paid to vendors", value: sums.vendorPaidOut, type: "money" },
      { key: "riderPaidOut", label: "Paid to riders", value: sums.riderPaidOut, type: "money2" },
    ],
    notes: [CANCELLED_NOTE],
  });
}

// ── per shop ─────────────────────────────────────────────────────────────

export function buildCommission(r: FinanceRollup, shopName: (id: string) => string): Built {
  const rows = r.byVendor
    .map((v) => ({
      vendor: shopName(v.restaurantId), orders: num(v.orders), foodGross: num(v.foodGross), commission: num(v.commission),
      commissionGst: num(v.commissionGst), otherCharges: num(v.otherCharges),
      platformTotal: num(v.commission) + num(v.commissionGst) + num(v.otherCharges), vendorNet: num(v.vendorNet),
    }))
    .sort((a, b) => b.platformTotal - a.platformTotal || a.vendor.localeCompare(b.vendor));
  const totals: ReportRow = { vendor: "Total", ...sumKeys(rows, ["orders", "foodGross", "commission", "commissionGst", "otherCharges", "platformTotal", "vendorNet"]) };
  return whole(rows, totals, {
    highlights: [{ key: "platformTotal", label: "Platform commission", value: totals.platformTotal, type: "money" }],
  });
}

export interface VendorOpsRow {
  restaurantId: string; vendor: string | null; zoneId: string | null; orders: number; delivered: number; cancelled: number; rejected: number;
  acceptMinutesSum: number; acceptCount: number; prepMinutesSum: number; prepCount: number; rating: number | string | null; ratingCount: number;
}

export function buildVendorPerformance(ops: VendorOpsRow[], r: FinanceRollup, zoneName: (id: string | null) => string): Built {
  const money = new Map(r.byVendor.map((v) => [v.restaurantId, v]));
  const rows = ops.map((o) => {
    const m = money.get(o.restaurantId);
    const nonCancelled = num(m?.orders);
    const paid = num(m?.customerPaid);
    return {
      vendor: o.vendor?.trim() || "Shop", zone: zoneName(o.zoneId), orders: num(o.orders), delivered: num(o.delivered), cancelled: num(o.cancelled),
      cancellationRate: rate(num(o.cancelled), num(o.orders)), rejectionRate: rate(num(o.rejected), num(o.orders)),
      avgAcceptMinutes: meanMinutes(num(o.acceptMinutesSum), num(o.acceptCount)), avgPrepMinutes: meanMinutes(num(o.prepMinutesSum), num(o.prepCount)),
      customerPaid: paid, netSales: num(m?.grossSales) - num(m?.discounts) - num(m?.refunds),
      aov: nonCancelled > 0 ? Math.round(paid / nonCancelled) : 0,
      rating: o.rating === null ? null : Number(o.rating).toFixed(1), ratingCount: num(o.ratingCount),
      commission: num(m?.commission) + num(m?.commissionGst) + num(m?.otherCharges), payable: num(m?.vendorNet),
      _rejected: num(o.rejected), _acceptSum: num(o.acceptMinutesSum), _acceptN: num(o.acceptCount), _prepSum: num(o.prepMinutesSum), _prepN: num(o.prepCount),
      _nonCancelled: nonCancelled,
    };
  }).sort((a, b) => b.orders - a.orders || a.vendor.localeCompare(b.vendor));
  const s = sumKeys(rows, ["orders", "delivered", "cancelled", "customerPaid", "netSales", "ratingCount", "commission", "payable",
    "_rejected", "_acceptSum", "_acceptN", "_prepSum", "_prepN", "_nonCancelled"]);
  const totals: ReportRow = {
    vendor: "Total", zone: null, orders: s.orders, delivered: s.delivered, cancelled: s.cancelled,
    cancellationRate: rate(num(s.cancelled), num(s.orders)), rejectionRate: rate(num(s._rejected), num(s.orders)),
    avgAcceptMinutes: meanMinutes(num(s._acceptSum), num(s._acceptN)), avgPrepMinutes: meanMinutes(num(s._prepSum), num(s._prepN)),
    customerPaid: s.customerPaid, netSales: s.netSales, aov: num(s._nonCancelled) > 0 ? Math.round(num(s.customerPaid) / num(s._nonCancelled)) : 0,
    rating: null, ratingCount: s.ratingCount, commission: s.commission, payable: s.payable,
  };
  return whole(rows.map(stripPrivate), totals, {
    highlights: [
      { key: "orders", label: "Orders", value: s.orders, type: "int" },
      { key: "cancellationRate", label: "Cancellation rate", value: totals.cancellationRate, type: "percent" },
    ],
  });
}

// ── per rider ────────────────────────────────────────────────────────────

export interface RiderPerfRow {
  riderId: string; rider: string | null; code: string | null; delivered: number; failed: number; offers: number; accepted: number;
  deliverMinutesSum: number; deliverCount: number; onlineHours: number | string; rating: number | string | null; ratingCount: number; codCollected: number;
}

export function buildRiderPerformance(rp: RiderPerfRow[]): Built {
  const rows = rp.map((r) => ({
    rider: r.rider?.trim() || "Rider", code: r.code, delivered: num(r.delivered), failed: num(r.failed),
    failedRate: rate(num(r.failed), num(r.delivered) + num(r.failed)), acceptanceRate: rate(num(r.accepted), num(r.offers)),
    avgDeliverMinutes: meanMinutes(num(r.deliverMinutesSum), num(r.deliverCount)), onlineHours: Math.round(num(r.onlineHours) * 100) / 100,
    rating: r.rating === null ? null : Number(r.rating).toFixed(1), ratingCount: num(r.ratingCount), codCollected: num(r.codCollected),
    _offers: num(r.offers), _accepted: num(r.accepted), _minSum: num(r.deliverMinutesSum), _minN: num(r.deliverCount),
  })).sort((a, b) => b.delivered - a.delivered || a.rider.localeCompare(b.rider));
  const s = sumKeys(rows, ["delivered", "failed", "onlineHours", "ratingCount", "codCollected", "_offers", "_accepted", "_minSum", "_minN"], ["onlineHours"]);
  const totals: ReportRow = {
    rider: "Total", code: null, delivered: s.delivered, failed: s.failed,
    failedRate: rate(num(s.failed), num(s.delivered) + num(s.failed)), acceptanceRate: rate(num(s._accepted), num(s._offers)),
    avgDeliverMinutes: meanMinutes(num(s._minSum), num(s._minN)), onlineHours: s.onlineHours, rating: null, ratingCount: s.ratingCount,
    codCollected: s.codCollected,
  };
  return whole(rows.map(stripPrivate), totals, {
    highlights: [
      { key: "delivered", label: "Delivered", value: s.delivered, type: "int" },
      { key: "acceptanceRate", label: "Acceptance rate", value: totals.acceptanceRate, type: "percent" },
    ],
  });
}

// ── SQL-paged lists (0158) ───────────────────────────────────────────────

interface Paged<T> { totalRows: number; totals: Record<string, unknown>; rows: T[] }

export interface OrderReportRow {
  code: string | null; placedAt: string; cancelledAt: string | null; vendor: string | null; rider: string | null; status: string;
  paymentMethod: string | null; paymentStatus: string | null; items: number; total: number; discount: number; deliveryFee: number;
  cancelledBy: string | null; cancellationReason: string | null; refunded: number;
}

export function buildOrders(p: Paged<OrderReportRow>): Built {
  const rows = p.rows.map((o) => ({
    code: o.code, placedAt: o.placedAt, vendor: o.vendor, rider: o.rider, status: o.status, paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus, items: num(o.items), total: num(o.total), discount: num(o.discount), deliveryFee: num(o.deliveryFee),
    cancelledBy: o.cancelledBy, cancellationReason: o.cancellationReason,
  }));
  const t = p.totals;
  return {
    rows, totalRows: num(p.totalRows), paged: true, notes: [],
    totals: { code: "Total", items: num(t.items), total: num(t.total), discount: num(t.discount), deliveryFee: num(t.deliveryFee) },
    highlights: [{ key: "orders", label: "Orders", value: num(t.orders), type: "int" }, { key: "total", label: "Order value", value: num(t.total), type: "money" }],
  };
}

export function buildCancellation(p: Paged<OrderReportRow>): Built {
  const rows = p.rows.map((o) => ({
    code: o.code, placedAt: o.placedAt, cancelledAt: o.cancelledAt, vendor: o.vendor, cancelledBy: o.cancelledBy,
    reason: o.cancellationReason, value: num(o.total), refunded: num(o.refunded),
  }));
  const t = p.totals;
  return {
    rows, totalRows: num(p.totalRows), paged: true, notes: [],
    totals: { code: "Total", value: num(t.total), refunded: num(t.refunded) },
    highlights: [{ key: "count", label: "Cancelled orders", value: num(t.orders), type: "int" }, { key: "value", label: "Value", value: num(t.total), type: "money" }],
  };
}

export interface RefundReportRow {
  at: string; type: string; orderCode: string | null; vendor: string | null; amount: number; status: string; origin: string | null;
  reason: string | null; settlementEffect: string | null; decidedBy: string | null;
}

export function buildRefundsAdjustments(p: Paged<RefundReportRow>): Built {
  const rows = p.rows.map((r) => ({
    date: r.at, type: r.type, orderCode: r.orderCode, vendor: r.vendor, amount: num(r.amount), status: r.status, origin: r.origin,
    reason: r.reason, settlementEffect: r.settlementEffect, decidedBy: r.decidedBy,
  }));
  const t = p.totals;
  return {
    rows, totalRows: num(p.totalRows), paged: true, notes: [REFUND_NOTE],
    totals: { date: "Total approved refunds", amount: num(t.refundsApproved) },
    highlights: [
      { key: "refundsApproved", label: "Refunds approved", value: num(t.refundsApproved), type: "money" },
      { key: "refundsPending", label: "Refunds pending", value: num(t.refundsPending), type: "money" },
      { key: "corrections", label: "Corrections", value: num(t.corrections), type: "money" },
    ],
  };
}

export interface TicketReportRow {
  number: number; createdAt: string; requesterRole: string; category: string; priority: string; status: string; escalationLevel: number;
  assignedTo: string | null; firstResponseMinutes: number | null; resolutionMinutes: number | null; orderCode: string | null; vendor: string | null;
}

export function buildSupportTickets(p: Paged<TicketReportRow>): Built {
  const rows = p.rows.map((t) => ({
    number: num(t.number), createdAt: t.createdAt, requesterRole: t.requesterRole, category: t.category, priority: t.priority, status: t.status,
    escalationLevel: num(t.escalationLevel), assignedTo: t.assignedTo,
    firstResponseMinutes: t.firstResponseMinutes === null ? null : num(t.firstResponseMinutes),
    resolutionMinutes: t.resolutionMinutes === null ? null : num(t.resolutionMinutes), orderCode: t.orderCode, vendor: t.vendor,
  }));
  const t = p.totals;
  const top = (t.topCategories as { category: string; count: number }[] | undefined) ?? [];
  const avgFirst = meanMinutes(num(t.firstResponseMinutesSum), num(t.firstResponseCount));
  const avgResolve = meanMinutes(num(t.resolutionMinutesSum), num(t.resolutionCount));
  return {
    rows, totalRows: num(p.totalRows), paged: true, notes: [],
    totals: { number: num(t.count), firstResponseMinutes: avgFirst, resolutionMinutes: avgResolve },
    highlights: [
      { key: "count", label: "Tickets", value: num(t.count), type: "int" },
      { key: "avgFirstResponse", label: "Avg first response (min)", value: avgFirst, type: "minutes" },
      { key: "avgResolution", label: "Avg resolution (min)", value: avgResolve, type: "minutes" },
      { key: "topCategories", label: "Top categories", value: top.map((c) => `${c.category} (${c.count})`).join(", ") || null, type: "text" },
    ],
  };
}

// ── marketing (0158) ─────────────────────────────────────────────────────

export interface MarketingRollup {
  banners: { campaign: string; type: string; vendor: string | null; start: string | null; end: string | null; status: string; fundedBy: string;
    impressions: number; clicks: number; attributedOrders: number }[];
  codes: { campaign: string; vendor: string | null; start: string | null; end: string | null; status: string; fundedBy: string;
    redemptions: number; discountGiven: number; attributedOrders: number; attributedSales: number }[];
  /** 0163: campaigns (a campaign-owned banner is listed here, not under banners). Absent before 0163. */
  campaigns?: { campaign: string; type: string; vendor: string | null; start: string | null; end: string | null; status: string;
    budget: number | null; fundedBy: string; impressions: number; clicks: number; attributedOrders: number; attributedSales: number }[];
}

/**
 * Campaigns, banners and promo codes in one table (§8.10–8.11). Campaigns
 * carry their budget, funding and attributed sales (0163's one attribution
 * rule); plain banners and codes keep 0158's figures.
 */
export function buildMarketing(m: MarketingRollup): Built {
  const rows: ReportRow[] = [
    ...(m.campaigns ?? []).map((c) => ({
      campaign: c.campaign, type: c.type, vendor: c.vendor, start: c.start, end: c.end, status: c.status,
      budget: c.budget == null ? null : num(c.budget), fundedBy: c.fundedBy,
      impressions: num(c.impressions), clicks: num(c.clicks), redemptions: null, discountGiven: null,
      attributedOrders: num(c.attributedOrders), attributedSales: num(c.attributedSales),
    })),
    ...m.banners.map((b) => ({
      campaign: b.campaign, type: b.type, vendor: b.vendor, start: b.start, end: b.end, status: b.status, budget: null, fundedBy: b.fundedBy,
      impressions: num(b.impressions), clicks: num(b.clicks), redemptions: null, discountGiven: null,
      attributedOrders: num(b.attributedOrders), attributedSales: null,
    })),
    ...m.codes.map((c) => ({
      campaign: c.campaign, type: "promo_code", vendor: c.vendor, start: c.start, end: c.end, status: c.status, budget: null, fundedBy: c.fundedBy,
      impressions: null, clicks: null, redemptions: num(c.redemptions), discountGiven: num(c.discountGiven),
      attributedOrders: num(c.attributedOrders), attributedSales: num(c.attributedSales),
    })),
  ];
  const totals: ReportRow = { campaign: "Total", ...sumKeys(rows, ["impressions", "clicks", "redemptions", "discountGiven", "attributedOrders", "attributedSales"]) };
  return whole(rows, totals, {
    highlights: [
      { key: "redemptions", label: "Redemptions", value: totals.redemptions, type: "int" },
      { key: "attributedSales", label: "Attributed sales", value: totals.attributedSales, type: "money" },
    ],
  });
}

// ── money lists ──────────────────────────────────────────────────────────

export function buildCashReconciliation(
  riders: { day: string; riderId: string; codOrders: number; collected: number; deposited: number; disputed: boolean }[],
  person: (id: string) => { name: string; code: string | null }
): Built {
  const rows = riders.map((r) => {
    const collected = num(r.collected);
    const deposited = num(r.deposited);
    const who = person(r.riderId);
    return {
      date: r.day, rider: who.name, code: who.code, codOrders: num(r.codOrders), collected, deposited,
      pending: Math.max(0, collected - deposited), status: cashDayStatus(collected, deposited, !!r.disputed),
    };
  });
  const totals: ReportRow = { date: "Total", ...sumKeys(rows, ["codOrders", "collected", "deposited", "pending"]) };
  return whole(rows, totals, {
    highlights: [
      { key: "collected", label: "Collected", value: totals.collected, type: "money" },
      { key: "pending", label: "Pending deposit", value: totals.pending, type: "money" },
    ],
  });
}

function stripPrivate<T extends Record<string, unknown>>(row: T): ReportRow {
  const out: ReportRow = {};
  for (const [k, v] of Object.entries(row)) if (!k.startsWith("_")) out[k] = v as ReportRow[string];
  return out;
}
