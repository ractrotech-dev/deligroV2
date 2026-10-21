import "server-only";
import { createClient } from "@/lib/supabase/server";
import { orderFoodValue } from "@/lib/settlements/math";

/**
 * A shop's orders as sales: each with its food value (lib/settlements/math —
 * the same figure a settlement calls foodGross). Read with the vendor's own
 * client, so RLS scopes it to their orders. Shared by the dashboard, analytics
 * and reports.
 */
export interface SaleOrder {
  id: string;
  status: string;
  createdAt: string;
  /** What the customer paid in full. */
  total: number;
  /** The shop's sale (food value). */
  sale: number;
  /** Vendor-funded part of the discount — what the shop gave away. */
  vendorDiscount: number;
  paymentMethod: string | null;
  paymentStatus: string | null;
}

/** Statuses at which the kitchen has taken the order on: counted as sales. */
export const SALE_STATUSES = ["kitchen", "ready", "on_the_way", "delivered"] as const;

const PAGE = 1000;
const MAX_PAGES = 50;

interface Row {
  id: string;
  status: string;
  created_at: string;
  total: number;
  delivery_fee: number | null;
  tax_amount: number | null;
  tip: number | null;
  discount: number | null;
  discount_funded_by: string | null;
  payment_method: string | null;
  payment_status: string | null;
}

export async function loadSaleOrders(
  restaurantId: string,
  opts: { from?: Date; to?: Date; statuses?: readonly string[] } = {}
): Promise<SaleOrder[]> {
  const supabase = await createClient();
  const out: SaleOrder[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = supabase
      .from("orders")
      .select(
        "id, status, created_at, total, delivery_fee, tax_amount, tip, discount, discount_funded_by, payment_method, payment_status"
      )
      .eq("restaurant_id", restaurantId);
    if (opts.statuses) q = q.in("status", [...opts.statuses]);
    if (opts.from) q = q.gte("created_at", opts.from.toISOString());
    if (opts.to) q = q.lt("created_at", opts.to.toISOString());
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    for (const r of rows) {
      const funded = r.discount_funded_by === "platform" ? "platform" : "vendor";
      out.push({
        id: r.id,
        status: r.status,
        createdAt: r.created_at,
        total: Number(r.total) || 0,
        sale: orderFoodValue({
          total: Number(r.total) || 0,
          deliveryFee: Number(r.delivery_fee) || 0,
          taxAmount: Number(r.tax_amount) || 0,
          tip: Number(r.tip) || 0,
          discount: Number(r.discount) || 0,
          discountFundedBy: funded,
        }),
        vendorDiscount: funded === "vendor" ? Math.max(0, Math.round(Number(r.discount) || 0)) : 0,
        paymentMethod: r.payment_method,
        paymentStatus: r.payment_status,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}
