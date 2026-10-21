/**
 * The row shapes the ops metrics are computed from.
 *
 * Plain objects, camelCased, already coerced to numbers — the data layer maps
 * Supabase rows onto these once (orders, order_items, refunds,
 * vendor_settlements), and nothing in this module ever sees a client or a
 * query. That is what lets the manager dashboard, the statistics screens,
 * finance and every report share one arithmetic (design §18.4).
 */
import type {
  SettlementDiscountFunding,
  SettlementPaymentMethod,
  SettlementPaymentStatus,
} from "@/lib/settlements/math";

/** `order_status` (0001). */
export type OrderStatus =
  | "placed"
  | "kitchen"
  | "ready"
  | "on_the_way"
  | "delivered"
  | "cancelled";

/** `orders.cancelled_by` (0051). */
export type CancelledBy = "customer" | "vendor" | "manager" | "admin" | "system";

/** One `order_items` line, with the dish's category when it is known. */
export interface MetricOrderItem {
  name: string;
  qty: number;
  /** Unit price snapshot, whole rupees. */
  price: number;
  /** `menu_items.category` (0002). Null or absent = uncategorised. */
  category?: string | null;
  menuItemId?: string | null;
}

export interface MetricOrder {
  id: string;
  restaurantId: string;
  /** `orders.zone_id` (0141). Null on a database that predates zones. */
  zoneId?: string | null;
  customerId?: string | null;
  status: OrderStatus;
  /** ISO instant, `orders.created_at`. Every period is attributed by this. */
  createdAt: string;
  /** What the customer paid, net of any discount (0031). */
  total: number;
  deliveryFee: number;
  taxAmount: number;
  tip: number;
  /** Rupees the customer did not pay (0031). */
  discount: number;
  /** `orders.discount_funded_by` (0041). Null = vendor, as in settlement math. */
  discountFundedBy: SettlementDiscountFunding;
  paymentMethod: SettlementPaymentMethod;
  paymentStatus: SettlementPaymentStatus;
  cancelledBy?: CancelledBy | null;
  cancellationReason?: string | null;
  /** Item lines. When absent, gross sales fall back to the order's food value. */
  items?: MetricOrderItem[];
}

/** One `refunds` row. */
export interface MetricRefund {
  id: string;
  orderId: string;
  amount: number;
  status: "pending" | "approved" | "denied";
}

/** One `vendor_settlements` header. */
export interface MetricSettlement {
  id: string;
  restaurantId: string;
  status: string;
  /** Whole rupees; negative when the vendor owes the platform. */
  netPayable: number;
  paidAt: string | null;
}

/**
 * The per-shop terms the settlement arithmetic needs. `commissionPct` holds the
 * *effective* rate (shop override, else the platform default) — resolved by the
 * data layer with `effectiveCommissionPct`, exactly as the reports do.
 */
export interface PricingContext {
  commissionPct: Map<string, number>;
  otherCharges: Map<string, number>;
  commissionGstPct: number;
}

/** Inclusive IST calendar dates, "YYYY-MM-DD". */
export interface DateRange {
  from: string;
  to: string;
}

export type Granularity = "day" | "week" | "month" | "year";

export interface Growth {
  current: number;
  previous: number;
  change: number;
  /**
   * Percent change, rounded to one decimal. Null when the previous period was
   * zero and this one is not: "+∞%" is not a figure anyone can act on, and the
   * screen says "new" instead.
   */
  pct: number | null;
}
