/**
 * Supabase rows onto the ops-metrics row shapes (`src/lib/metrics/types.ts`).
 *
 * Pure and browser-safe so it can be tested offline; the loaders that fetch
 * the rows live in `ops-metrics.ts`. Everything is coerced exactly once here —
 * PostgREST returns `numeric` as a string — so no figure downstream ever adds
 * "249.00" to a number.
 */
import type {
  CancelledBy,
  MetricOrder,
  MetricOrderItem,
  OrderStatus,
} from "@/lib/metrics/types";
import type {
  SettlementPaymentMethod,
  SettlementPaymentStatus,
} from "@/lib/settlements/math";

/** The `orders` columns the loaders select — never `*` (AGENTS.md rule 1). */
export const METRIC_ORDER_COLUMNS =
  "id, restaurant_id, zone_id, customer_id, status, created_at, total, delivery_fee, tax_amount, tip, payment_method, payment_status, cancelled_by, cancellation_reason";
/** 0031 / 0041, asked for separately: absent on an older database. */
export const METRIC_DISCOUNT_COLUMNS = "discount, discount_funded_by";

type Num = number | string | null | undefined;

export interface OrderRow {
  id: string;
  restaurant_id: string;
  zone_id?: string | null;
  customer_id?: string | null;
  status: string;
  created_at: string;
  total: Num;
  delivery_fee?: Num;
  tax_amount?: Num;
  tip?: Num;
  discount?: Num;
  discount_funded_by?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  cancelled_by?: string | null;
  cancellation_reason?: string | null;
}

export interface ItemRow {
  order_id: string;
  name: string;
  qty: Num;
  price: Num;
  menu_item_id?: string | null;
  menu_items?: { category: string | null } | { category: string | null }[] | null;
}

const num = (v: Num): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const STATUSES: readonly OrderStatus[] = ["placed", "kitchen", "ready", "on_the_way", "delivered", "cancelled"];
const CANCELLERS: readonly CancelledBy[] = ["customer", "vendor", "manager", "admin", "system"];
const PAYMENT_STATUSES: readonly Exclude<SettlementPaymentStatus, null>[] = [
  "pending",
  "authorized",
  "paid",
  "failed",
  "refunded",
];

function paymentMethod(v: string | null | undefined): SettlementPaymentMethod {
  return v === "online" || v === "cod" ? v : null;
}

/**
 * Passed through unchanged when it is a status the settlement math knows —
 * 'refunded' included: `platformHeldPayment` counts a refunded online order as
 * money the platform held, and the refund itself is carried separately.
 */
export function toSettlementPaymentStatus(v: string | null | undefined): SettlementPaymentStatus {
  return PAYMENT_STATUSES.includes(v as Exclude<SettlementPaymentStatus, null>)
    ? (v as SettlementPaymentStatus)
    : null;
}

export function toMetricItem(row: ItemRow): MetricOrderItem {
  const menu = Array.isArray(row.menu_items) ? row.menu_items[0] : row.menu_items;
  return {
    name: row.name,
    qty: num(row.qty),
    price: num(row.price),
    category: menu?.category ?? null,
    menuItemId: row.menu_item_id ?? null,
  };
}

/** One order row (and, when loaded, its item rows). */
export function toMetricOrder(row: OrderRow, items?: ItemRow[]): MetricOrder {
  const status = STATUSES.includes(row.status as OrderStatus) ? (row.status as OrderStatus) : "placed";
  const cancelledBy = CANCELLERS.includes(row.cancelled_by as CancelledBy)
    ? (row.cancelled_by as CancelledBy)
    : null;
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    zoneId: row.zone_id ?? null,
    customerId: row.customer_id ?? null,
    status,
    createdAt: row.created_at,
    total: num(row.total),
    deliveryFee: num(row.delivery_fee),
    taxAmount: num(row.tax_amount),
    tip: num(row.tip),
    discount: num(row.discount),
    // Null stays null: the settlement math reads an unrecorded funder as the
    // vendor's, and this layer must not decide that for it.
    discountFundedBy:
      row.discount_funded_by === "platform" || row.discount_funded_by === "vendor"
        ? row.discount_funded_by
        : null,
    paymentMethod: paymentMethod(row.payment_method),
    paymentStatus: toSettlementPaymentStatus(row.payment_status),
    cancelledBy,
    cancellationReason: row.cancellation_reason ?? null,
    ...(items ? { items: items.map(toMetricItem) } : {}),
  };
}
