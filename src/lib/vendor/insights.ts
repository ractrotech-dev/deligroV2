/**
 * Customer insights for the Partner app's Reviews screen (requirements §10):
 * how many people order, how many come back, how often, and what they spend.
 * Pure; tested by scripts/qa/vendor-growth.ts. Names only — the caller never
 * passes phone numbers in, so none can come out.
 */
export interface InsightOrder {
  customerId: string | null;
  customerName: string | null;
  createdAt: string;
  /** The order's food value (lib/settlements/math orderFoodValue). */
  sale: number;
}

export interface CustomerInsights {
  customers: number;
  /** Ordered two or more times in the window. */
  repeatCustomers: number;
  repeatRate: number;
  /** Orders per customer. */
  ordersPerCustomer: number;
  /** Average sale per order (rupees). */
  averageOrderValue: number;
  /** Average days between a repeat customer's orders; null with no repeats. */
  daysBetweenOrders: number | null;
  /** Up to ten best customers by orders, then spend. First names only. */
  topCustomers: { name: string; orders: number; spent: number; lastOrderAt: string }[];
}

/** "Asha Verma" → "Asha V." — enough to recognise a regular, not to find them. */
export function shortName(full: string | null): string {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Customer";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export function customerInsights(orders: InsightOrder[]): CustomerInsights {
  const by = new Map<string, InsightOrder[]>();
  let sales = 0;
  for (const o of orders) {
    sales += o.sale;
    if (!o.customerId) continue;
    const list = by.get(o.customerId) ?? [];
    list.push(o);
    by.set(o.customerId, list);
  }
  let repeat = 0;
  let gaps = 0, gapCount = 0;
  const top: CustomerInsights["topCustomers"] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (list.length >= 2) {
      repeat++;
      for (let i = 1; i < list.length; i++) {
        gaps += (Date.parse(list[i].createdAt) - Date.parse(list[i - 1].createdAt)) / 86_400_000;
        gapCount++;
      }
    }
    top.push({
      name: shortName(list[list.length - 1].customerName),
      orders: list.length,
      spent: list.reduce((s, o) => s + o.sale, 0),
      lastOrderAt: list[list.length - 1].createdAt,
    });
  }
  top.sort((a, b) => b.orders - a.orders || b.spent - a.spent);
  const customers = by.size;
  return {
    customers,
    repeatCustomers: repeat,
    repeatRate: customers === 0 ? 0 : Math.round((repeat / customers) * 1000) / 10,
    ordersPerCustomer: customers === 0 ? 0 : Math.round((orders.filter((o) => o.customerId).length / customers) * 10) / 10,
    averageOrderValue: orders.length === 0 ? 0 : Math.round(sales / orders.length),
    daysBetweenOrders: gapCount === 0 ? null : Math.round((gaps / gapCount) * 10) / 10,
    topCustomers: top.slice(0, 10),
  };
}
