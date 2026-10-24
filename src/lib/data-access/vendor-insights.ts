import "server-only";
import { createClient } from "@/lib/supabase/server";
import { customerInsights, type CustomerInsights } from "@/lib/vendor/insights";
import { orderFoodValue } from "@/lib/settlements/math";
import { SALE_STATUSES } from "@/lib/data-access/vendor-sales";
import { stripTrailingParenthetical } from "@/lib/utils/text-shape";

/**
 * Who orders, how often they come back and what they spend, over the last
 * [days] (requirements §10). Read with the vendor's own client (RLS: their
 * orders). Only the customer's name is read — never a phone number.
 */
export async function getCustomerInsights(
  restaurantId: string,
  days = 90
): Promise<CustomerInsights & { topProducts: { name: string; qty: number; orders: number }[] }> {
  const supabase = await createClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("orders")
    .select("customer_id, created_at, total, delivery_fee, tax_amount, tip, discount, discount_funded_by, customer:profiles!orders_customer_id_fkey(full_name)")
    .eq("restaurant_id", restaurantId)
    .in("status", [...SALE_STATUSES])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw error;

  // What customers buy most (requirements §10.5): units per dish name.
  const { data: lines } = await supabase
    .from("order_items")
    .select("name, qty, order_id, orders!inner(restaurant_id, status, created_at)")
    .eq("orders.restaurant_id", restaurantId)
    .in("orders.status", [...SALE_STATUSES])
    .gte("orders.created_at", since)
    .limit(10000);
  const products = new Map<string, { qty: number; orders: Set<string> }>();
  for (const l of lines ?? []) {
    const name = stripTrailingParenthetical(String(l.name));
    const p = products.get(name) ?? { qty: 0, orders: new Set<string>() };
    p.qty += Number(l.qty) || 0;
    p.orders.add(String(l.order_id));
    products.set(name, p);
  }
  const topProducts = [...products]
    .map(([name, p]) => ({ name, qty: p.qty, orders: p.orders.size }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  const base = customerInsights(
    (data ?? []).map((r) => {
      const c = Array.isArray(r.customer) ? r.customer[0] : r.customer;
      return {
        customerId: (r.customer_id as string | null) ?? null,
        customerName: (c as { full_name?: string | null } | null)?.full_name ?? null,
        createdAt: r.created_at as string,
        sale: orderFoodValue({
          total: Number(r.total) || 0,
          deliveryFee: Number(r.delivery_fee) || 0,
          taxAmount: Number(r.tax_amount) || 0,
          tip: Number(r.tip) || 0,
          discount: Number(r.discount) || 0,
          discountFundedBy: r.discount_funded_by === "platform" ? "platform" : "vendor",
        }),
      };
    })
  );
  return { ...base, topProducts };
}
