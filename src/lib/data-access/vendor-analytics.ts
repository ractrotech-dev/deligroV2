import "server-only";
import { createClient } from "@/lib/supabase/server";
import { loadSaleOrders, SALE_STATUSES } from "@/lib/data-access/vendor-sales";
import { computeAnalytics, istMidnight, type Analytics, type AnalyticsLine, type AnalyticsWindow } from "@/lib/vendor/analytics";

/**
 * Sales statistics for one shop over a window and the period before it
 * (client requirements §2). Orders the kitchen accepted count as sales, valued
 * by food value (lib/vendor/analytics.ts, lib/settlements/math.ts).
 */
export async function getVendorAnalytics(restaurantId: string, window: AnalyticsWindow): Promise<Analytics> {
  const from = istMidnight(window.prevFrom);
  const to = new Date(istMidnight(window.to).getTime() + 24 * 60 * 60 * 1000);
  const supabase = await createClient();

  const [orders, menuRes] = await Promise.all([
    loadSaleOrders(restaurantId, { from, to, statuses: SALE_STATUSES }),
    supabase.from("menu_items").select("id, name").eq("restaurant_id", restaurantId).order("name"),
  ]);
  if (menuRes.error) throw menuRes.error;

  // Lines only for the current window's orders; in chunks to keep URLs short.
  const windowStart = istMidnight(window.from).getTime();
  const ids = orders.filter((o) => Date.parse(o.createdAt) >= windowStart).map((o) => o.id);
  const lines: AnalyticsLine[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase
      .from("order_items")
      .select("order_id, menu_item_id, name, qty, price")
      .in("order_id", ids.slice(i, i + 150));
    if (error) throw error;
    for (const r of data ?? []) {
      lines.push({
        orderId: r.order_id as string,
        menuItemId: (r.menu_item_id as string | null) ?? null,
        name: String(r.name ?? ""),
        qty: Number(r.qty) || 0,
        price: Number(r.price) || 0,
      });
    }
  }

  return computeAnalytics(
    window,
    orders.map((o) => ({ id: o.id, createdAt: o.createdAt, sale: o.sale })),
    lines,
    (menuRes.data ?? []).map((m) => ({ id: m.id as string, name: String(m.name ?? "") }))
  );
}
