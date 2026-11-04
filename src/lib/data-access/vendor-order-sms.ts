import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { toE164 } from "@/lib/auth/phone";
import { orderSmsConfigured, sendOrderSms } from "@/lib/sms/order-sms";
import { shortOrderId } from "@/lib/utils/order-map";
import { captureError } from "@/lib/obs/emit";
import { rateLimit } from "@/lib/rate-limit";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";
import {
  DEFAULT_ORDER_SMS_TEMPLATE,
  OLD_DEFAULT_ORDER_SMS_TEMPLATE,
  fillOrderSms,
  orderDishes,
  orderInstructions,
  registeredShopNumber,
} from "@/lib/sms/order-sms-text";

/**
 * New-order SMS to shops (migration 0175): the admin's global switch and
 * template, and per shop whether it gets one and on which number.
 *
 * Every function here uses the service role: the two tables are revoked from
 * anon/authenticated. The admin functions are called only from
 * src/app/admin/settings/sms/actions.ts and page.tsx behind
 * requireRole("admin"); `smsVendorNewOrder` only from notifyVendorNewOrder,
 * after an order was placed (or its payment settled), with no request input.
 */

export interface OrderSmsSettings {
  enabled: boolean;
  template: string;
  /** False when migration 0175 is not applied: the page says so and saves nothing. */
  installed: boolean;
  /** ORDER_SMS_URL is set on the server. */
  gatewayConfigured: boolean;
}

export interface VendorSmsRow {
  restaurantId: string;
  name: string;
  /** The number it registered with, from `registeredShopNumber`. */
  registeredNumber: string | null;
  enabled: boolean;
  /** The number typed on the SMS page, or null = the registered one. */
  phone: string | null;
}

export async function getOrderSmsSettings(): Promise<OrderSmsSettings> {
  const gatewayConfigured = orderSmsConfigured();
  const { data, error } = await createAdminClient()
    .from("order_sms_settings")
    .select("enabled, template")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return { enabled: false, template: DEFAULT_ORDER_SMS_TEMPLATE, installed: false, gatewayConfigured };
    throw error;
  }
  const saved = (data?.template as string | undefined) ?? DEFAULT_ORDER_SMS_TEMPLATE;
  return {
    enabled: data?.enabled === true,
    template: saved === OLD_DEFAULT_ORDER_SMS_TEMPLATE ? DEFAULT_ORDER_SMS_TEMPLATE : saved,
    installed: true,
    gatewayConfigured,
  };
}

export async function saveOrderSmsSettings(actorId: string, enabled: boolean, template: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("order_sms_settings")
    .upsert({ id: true, enabled, template, updated_at: new Date().toISOString(), updated_by: actorId });
  if (error) throw error;
}

type ShopNumberRow = {
  id: string;
  name: string | null;
  owner_id: string | null;
  owner_mobile: string | null;
  shop_phone: string | null;
};

/** Every shop with its SMS setting (a shop with no row gets one by default, to its registered number). */
async function listVendorSms(): Promise<VendorSmsRow[]> {
  const supabase = createAdminClient();
  const [shops, settings] = await Promise.all([
    readAllRows<ShopNumberRow>((from, to) =>
      supabase
        .from("restaurants")
        .select("id, name, owner_id, owner_mobile, shop_phone")
        .order("name")
        .order("id")
        .range(from, to) as unknown as PromiseLike<{ data: ShopNumberRow[] | null; error: unknown }>
    ),
    supabase.from("vendor_order_sms").select("restaurant_id, enabled, phone"),
  ]);
  if (shops.error) throw shops.error;
  if (settings.error && !isMissingTable(settings.error)) throw settings.error;

  const ownerIds = [...new Set(shops.data.map((s) => s.owner_id).filter((id): id is string => Boolean(id)))];
  const owners = await readInChunks<{ id: string; phone: string | null }>(ownerIds, (chunk) =>
    supabase.from("profiles").select("id, phone").in("id", chunk) as unknown as PromiseLike<{
      data: { id: string; phone: string | null }[] | null;
      error: unknown;
    }>
  );
  if (owners.error) throw owners.error;
  const ownerPhone = new Map(owners.data.map((o) => [o.id, o.phone]));

  const byShop = new Map(
    ((settings.data ?? []) as { restaurant_id: string; enabled: boolean; phone: string | null }[]).map((r) => [
      r.restaurant_id,
      r,
    ])
  );
  return shops.data.map((s) => {
    const row = byShop.get(s.id);
    return {
      restaurantId: s.id,
      name: s.name?.trim() || "Unnamed shop",
      registeredNumber: registeredShopNumber({
        ownerMobile: s.owner_mobile,
        ownerAccountPhone: s.owner_id ? ownerPhone.get(s.owner_id) : null,
        shopPhone: s.shop_phone,
      }),
      enabled: row ? row.enabled : true,
      phone: row?.phone ?? null,
    };
  });
}

export type VendorSmsFilter = "all" | "missing" | "off";

/** One page of shops, searched and filtered, with a true count for each filter. */
export async function listVendorSmsPage(input: {
  q: string;
  show: VendorSmsFilter;
  page: number;
  pageSize: number;
}): Promise<{
  rows: VendorSmsRow[];
  page: number;
  total: number;
  counts: Record<VendorSmsFilter, number>;
}> {
  const needle = input.q.toLowerCase();
  const found = (await listVendorSms()).filter((s) => !needle || s.name.toLowerCase().includes(needle));
  const isMissing = (s: VendorSmsRow) => !(s.phone ?? s.registeredNumber);
  const counts = {
    all: found.length,
    missing: found.filter(isMissing).length,
    off: found.filter((s) => !s.enabled).length,
  };
  let shown = found;
  if (input.show === "missing") shown = found.filter(isMissing);
  else if (input.show === "off") shown = found.filter((s) => !s.enabled);

  const page = Math.min(Math.max(1, input.page), Math.max(1, Math.ceil(shown.length / input.pageSize)));
  const from = (page - 1) * input.pageSize;
  return { rows: shown.slice(from, from + input.pageSize), page, total: shown.length, counts };
}

/** `phone` is what the admin typed; null/empty = use the registered number. Throws "bad_phone". */
export async function saveVendorSms(
  actorId: string,
  restaurantId: string,
  enabled: boolean,
  phone: string | null
): Promise<{ enabled: boolean; phone: string | null }> {
  let e164: string | null = null;
  if (phone && phone.trim()) {
    e164 = toE164(phone.trim());
    if (!e164) throw new Error("bad_phone");
  }
  const { error } = await createAdminClient()
    .from("vendor_order_sms")
    .upsert({
      restaurant_id: restaurantId,
      enabled,
      phone: e164,
      updated_at: new Date().toISOString(),
      updated_by: actorId,
    });
  if (error) throw error;
  return { enabled, phone: e164 };
}

/** Paid-SMS caps for new-order texts; see smsVendorNewOrder. */
const SMS_PER_SHOP = 30;
const SMS_PER_CUSTOMER = 5;
const HOUR_MS = 60 * 60_000;

/**
 * Text the shop about a new order, when the admin has switched new-order SMS
 * on, the gateway is configured, and this shop has not been switched off.
 * Best effort: never throws, and a missing migration simply sends nothing.
 *
 * Capped (2026-10-28 audit): each message is paid for, and any signed-in
 * customer can place cash orders, so without a cap one account could have the
 * platform text a shop twenty times a minute. Past SMS_PER_SHOP an hour for a
 * shop, or SMS_PER_CUSTOMER an hour from one customer, the text is skipped;
 * the kitchen push and the board still announce the order.
 */
export async function smsVendorNewOrder(orderId: string, itemCount?: number): Promise<void> {
  try {
    if (!orderSmsConfigured()) return;
    const settings = await getOrderSmsSettings();
    if (!settings.installed || !settings.enabled) return;

    const supabase = createAdminClient();
    const { data: order, error } = await supabase
      .from("orders")
      .select("total, delivery_instructions, restaurant_id, customer_id, restaurants(name, owner_id, owner_mobile, shop_phone), order_items(name, qty)")
      .eq("id", orderId)
      .maybeSingle();
    if (error) throw error;
    if (!order) return;

    // The customer's own budget first, so a customer over it does not also use
    // up the shop's — which every genuine order that hour shares.
    const perCustomer = await rateLimit(`order-sms:customer:${order.customer_id}`, SMS_PER_CUSTOMER, HOUR_MS);
    if (!perCustomer.ok) return;
    const perShop = await rateLimit(`order-sms:shop:${order.restaurant_id}`, SMS_PER_SHOP, HOUR_MS);
    if (!perShop.ok) return;

    const { data: pref, error: prefError } = await supabase
      .from("vendor_order_sms")
      .select("enabled, phone")
      .eq("restaurant_id", order.restaurant_id)
      .maybeSingle();
    if (prefError) throw prefError;
    if (pref && pref.enabled === false) return;

    const shop = (Array.isArray(order.restaurants) ? order.restaurants[0] : order.restaurants) as
      | { name: string | null; owner_id: string | null; owner_mobile: string | null; shop_phone: string | null }
      | null;
    let to = (pref?.phone as string | null | undefined) || null;
    if (!to) {
      let ownerAccountPhone: string | null = null;
      if (shop?.owner_id) {
        const { data: owner, error: ownerError } = await supabase
          .from("profiles")
          .select("phone")
          .eq("id", shop.owner_id)
          .maybeSingle();
        if (ownerError) throw ownerError;
        ownerAccountPhone = (owner?.phone as string | null | undefined) ?? null;
      }
      to = registeredShopNumber({
        ownerMobile: shop?.owner_mobile,
        ownerAccountPhone,
        shopPhone: shop?.shop_phone,
      });
    }
    if (!to) return;

    const lines = (order.order_items ?? []) as { name: string | null; qty: number | null }[];
    const items =
      typeof itemCount === "number" && itemCount > 0
        ? itemCount
        : lines.reduce((n, i) => n + (i.qty ?? 1), 0);
    const message = fillOrderSms(settings.template, {
      order: shortOrderId(orderId),
      shop: shop?.name?.trim() || "your shop",
      items: String(items || 1),
      dishes: orderDishes(lines),
      instructions: orderInstructions(order.delivery_instructions as string | null),
      total: String(Math.round(Number(order.total ?? 0))),
    });
    await sendOrderSms(to, message);
  } catch (e) {
    captureError(e, { source: "vendor-order-sms", orderId, attrs: { event: "order_sms_not_sent" } });
  }
}
