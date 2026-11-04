import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureError } from "@/lib/obs/emit";
import { orderShortCode } from "@/lib/ops/order-contract";
import { raiseEventAlert } from "./engine";
import { alertFor } from "./evaluate";

/**
 * A shop rejected a new order. Rule book: a manager or admin contacts the customer
 * and decides each time, so this tells them straight away, on the alert kind that
 * means "an order needs a person". The sweep keeps it open from the same facts
 * (`rejected`, facts.ts). Service role: runs after updateKitchenOrderStatus has
 * checked the caller owns the shop, and it raises an alert and nothing else.
 */
export async function alertOrderRejected(orderId: string): Promise<void> {
  try {
    const { data } = await createAdminClient()
      .from("orders")
      .select("zone_id, restaurants(name)")
      .eq("id", orderId)
      .maybeSingle();
    const o = data as {
      zone_id: string | null;
      restaurants: { name: string | null } | { name: string | null }[] | null;
    } | null;
    const shop = Array.isArray(o?.restaurants) ? o?.restaurants[0] : o?.restaurants;
    await raiseEventAlert(
      alertFor.orderRejected({
        orderId,
        orderCode: orderShortCode(orderId),
        zoneId: o?.zone_id ?? null,
        vendorName: shop?.name?.trim() || "The shop",
      })
    );
  } catch (e) {
    captureError(e, { source: "alerts/order-rejected", orderId });
  }
}
