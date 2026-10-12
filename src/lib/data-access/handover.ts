import "server-only";
import { createClient } from "@/lib/supabase/server";
import { preferRpc, type FallbackState } from "@/lib/data-access/rpc-fallback";

/**
 * The two handover codes, generated per order by column default in migration
 * 0006.
 *
 *   delivery_otp  belongs to the CUSTOMER, who reads it out at the door
 *   pickup_otp    belongs to the KITCHEN, who reads it out at the counter
 *
 * The rider holds neither: he types what he is told, and driver-orders.ts
 * compares it (service role) with the stored code. A code readable by anyone
 * else proves nothing, so from 0058 the columns are not readable through the
 * table at all and each side reads only its own through a function that checks
 * who is asking. Until 0058 is applied the functions do not exist and the
 * columns are readable, so each reader falls back to the column (rpc-fallback).
 *
 * They are read separately on purpose. A single helper returning both would
 * hand the caller a code its role has no business showing, and the only thing
 * stopping it reaching a screen would be everyone downstream remembering not to
 * render it.
 */

const deliveryFn: FallbackState = { missing: false };
const pickupFn: FallbackState = { missing: false };

/** The customer's delivery handover code. Null for anyone but the order's customer. */
export async function getDeliveryOtp(orderId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await preferRpc<string>(
    deliveryFn,
    () => supabase.rpc("my_delivery_otp", { oid: orderId }),
    async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("delivery_otp")
        .eq("id", orderId)
        .maybeSingle();
      return { data: (data?.delivery_otp as string | undefined) ?? null, error };
    }
  );
  return data ?? null;
}

/**
 * The pickup codes for a set of orders, for the owning restaurant's kitchen
 * board: order id to code. Orders the caller does not own are simply absent.
 */
export async function getKitchenPickupOtps(
  orderIds: string[]
): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  if (orderIds.length === 0) return codes;

  const supabase = await createClient();
  const { data } = await preferRpc<{ order_id: string; pickup_otp: string | null }[]>(
    pickupFn,
    () => supabase.rpc("kitchen_pickup_otps", { oids: orderIds }),
    async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("id, pickup_otp")
        .in("id", orderIds);
      return {
        data: (data ?? []).map((r) => ({
          order_id: r.id as string,
          pickup_otp: (r.pickup_otp as string | null) ?? null,
        })),
        error,
      };
    }
  );

  for (const row of data ?? []) {
    if (row.pickup_otp) codes.set(row.order_id, row.pickup_otp);
  }
  return codes;
}
