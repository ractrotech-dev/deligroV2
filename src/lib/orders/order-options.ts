/**
 * Order placement's view of migration 0062: what a line costs with its chosen
 * variant and add-ons, what to tell a customer when the shop is closed, and
 * what a refusal from the order-line guard means. Pure; tested by
 * scripts/qa/order-options.ts.
 *
 * The database (guard_order_item_insert) is the authority — it prices every
 * line itself and refuses an invalid one. This mirrors its arithmetic so the
 * server's minimum-order and coupon pre-checks see the same subtotal, and
 * turns its refusals into sentences.
 */
import type { Lang } from "@/lib/i18n/lang";
import { effectivePrice } from "@/lib/utils/cart";

export interface PricedItem {
  price: number;
  discount_price: number | null;
}

/** A variant's price replaces the dish's; add-ons add on. Same as the guard. */
export function linePrice(
  item: PricedItem,
  variant: { price: number } | null,
  addons: { price: number }[]
): number {
  const unit = variant ? variant.price : effectivePrice(item.price, item.discount_price);
  return unit + addons.reduce((sum, a) => sum + a.price, 0);
}

export type ShopStatus = "open" | "closed" | "temporarily_closed" | "holiday" | "weekly_off" | "outside_hours";

export function isShopStatus(v: unknown): v is ShopStatus {
  return (
    v === "open" ||
    v === "closed" ||
    v === "temporarily_closed" ||
    v === "holiday" ||
    v === "weekly_off" ||
    v === "outside_hours"
  );
}

/** "09:30:00" → "9:30 AM". */
export function clockLabel(time: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/** What a customer reads when the shop can't take their order right now. */
export function closedMessage(status: ShopStatus, openingTime: string | null, lang: Lang): string {
  const opens = clockLabel(openingTime);
  const hi = lang === "hi";
  switch (status) {
    case "temporarily_closed":
      return hi
        ? "यह दुकान थोड़ी देर के लिए ऑर्डर नहीं ले रही है। कुछ देर बाद कोशिश करें।"
        : "This shop has paused orders for a short while. Try again a little later.";
    case "holiday":
      return hi ? "यह दुकान आज छुट्टी पर बंद है।" : "This shop is closed today for a holiday.";
    case "weekly_off":
      return hi ? "यह दुकान आज बंद रहती है।" : "This shop is closed today.";
    case "outside_hours":
      if (opens) return hi ? `यह दुकान अभी बंद है। ${opens} पर खुलेगी।` : `This shop is closed right now. It opens at ${opens}.`;
      return hi ? "यह दुकान अभी बंद है।" : "This shop is closed right now.";
    default:
      return hi ? "यह दुकान अभी ऑर्डर नहीं ले रही है।" : "This shop isn't taking orders right now.";
  }
}

export type ItemRefusal = {
  code: "restaurant_closed" | "out_of_stock" | "item_unavailable" | "invalid_options";
  message: string;
};

/**
 * The order-line guard's exception text → a refusal the customer can act on,
 * or null when it isn't one of these (a real fault).
 */
export function refusalFromItemError(text: string, lang: Lang): ItemRefusal | null {
  const hi = lang === "hi";
  const closed = /restaurant_closed \((\w+)\)/.exec(text);
  if (closed) {
    const status = isShopStatus(closed[1]) ? closed[1] : "closed";
    return { code: "restaurant_closed", message: closedMessage(status, null, lang) };
  }
  const stock = /only (\d+) left of (.+)$/.exec(text);
  if (stock) {
    return {
      code: "out_of_stock",
      message: hi
        ? `${stock[2]} के सिर्फ़ ${stock[1]} बचे हैं। मात्रा कम करें।`
        : `Only ${stock[1]} left of ${stock[2]}. Lower the quantity.`,
    };
  }
  const schedule = /order_items: (.+) is not available right now/.exec(text);
  if (schedule) {
    return {
      code: "item_unavailable",
      message: hi ? `${schedule[1]} अभी उपलब्ध नहीं है।` : `${schedule[1]} isn't available right now.`,
    };
  }
  if (/order_items: item is sold out/.test(text)) {
    return {
      code: "item_unavailable",
      message: hi ? "आपकी टोकरी का एक आइटम अभी-अभी खत्म हो गया।" : "An item in your basket has just sold out.",
    };
  }
  const choose = /order_items: (choose .+|that variant of .+ is not available|an add-on you chose is not available for .+)$/.exec(text);
  if (choose) {
    return {
      code: "invalid_options",
      message: hi ? "डिश के विकल्प फिर से चुनें — कुछ बदल गया है।" : `Please choose again — ${choose[1]}.`,
    };
  }
  return null;
}
