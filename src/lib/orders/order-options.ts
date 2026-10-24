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
import { byCodeUnit } from "@/lib/utils/compare";

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

// ---- The customer's side: choosing sizes and add-ons -----------------------

export interface OptionChoiceItem {
  price: number;
  discountPrice?: number | null;
  variants?: { id: string; name: string; price: number; available: boolean }[];
  addonGroups?: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    addons: { id: string; name: string; price: number; available: boolean }[];
  }[];
}

/** What the customer picked: one size (when the dish has sizes) and add-ons. */
export interface OptionChoice {
  variantId: string | null;
  addonIds: string[];
}

export const NO_CHOICE: OptionChoice = { variantId: null, addonIds: [] };

export function hasOptions(item: OptionChoiceItem): boolean {
  return (item.variants?.length ?? 0) > 0 || (item.addonGroups?.length ?? 0) > 0;
}

/**
 * Why this choice can't be ordered, or null when it can — the same rules the
 * order-line guard enforces: a size is required when any is available, every
 * add-on must be available and the dish's, and each group's min/max holds.
 */
export function choiceProblem(
  item: OptionChoiceItem,
  choice: OptionChoice
): { code: "choose_size" | "invalid_size" | "invalid_addon" | "group_min" | "group_max"; group?: string; n?: number } | null {
  const liveVariants = (item.variants ?? []).filter((v) => v.available);
  if (choice.variantId === null) {
    if (liveVariants.length > 0) return { code: "choose_size" };
  } else if (!liveVariants.some((v) => v.id === choice.variantId)) {
    return { code: "invalid_size" };
  }
  const groups = item.addonGroups ?? [];
  const known = new Map(groups.flatMap((g) => g.addons.filter((a) => a.available).map((a) => [a.id, g.id] as const)));
  if (choice.addonIds.some((id) => !known.has(id)) || new Set(choice.addonIds).size !== choice.addonIds.length) {
    return { code: "invalid_addon" };
  }
  for (const g of groups) {
    const n = choice.addonIds.filter((id) => known.get(id) === g.id).length;
    if (n < g.minSelect) return { code: "group_min", group: g.name, n: g.minSelect };
    if (n > g.maxSelect) return { code: "group_max", group: g.name, n: g.maxSelect };
  }
  return null;
}

/** Unit price for this choice: the size's price (or the dish's), plus add-ons. */
export function choicePrice(item: OptionChoiceItem, choice: OptionChoice): number {
  const variant = item.variants?.find((v) => v.id === choice.variantId) ?? null;
  const addons = (item.addonGroups ?? []).flatMap((g) => g.addons).filter((a) => choice.addonIds.includes(a.id));
  return linePrice({ price: item.price, discount_price: item.discountPrice ?? null }, variant, addons);
}

/** "Full · Extra cheese, Mayo" — empty for a dish ordered as it is. */
export function choiceLabel(item: OptionChoiceItem, choice: OptionChoice): string {
  const variant = item.variants?.find((v) => v.id === choice.variantId)?.name;
  const addons = (item.addonGroups ?? [])
    .flatMap((g) => g.addons)
    .filter((a) => choice.addonIds.includes(a.id))
    .map((a) => a.name);
  return [variant, addons.join(", ")].filter(Boolean).join(" · ");
}

/**
 * The add-on names on an order line's `options` snapshot (0062; written by the
 * order-line guard as {variant, addons: [{name, …}]}). The size is already in
 * the line's name ("Biryani (Full)"), so only add-ons need showing.
 */
export function chosenAddons(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const addons = (options as { addons?: unknown }).addons;
  if (!Array.isArray(addons)) return [];
  return addons
    .map((a) => (a && typeof a === "object" ? (a as { name?: unknown }).name : null))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** One basket line per dish per choice: the same dish in two sizes is two lines. */
export function lineKey(itemId: string, choice: OptionChoice = NO_CHOICE): string {
  if (choice.variantId === null && choice.addonIds.length === 0) return itemId;
  return `${itemId}|${choice.variantId ?? ""}|${[...choice.addonIds].sort(byCodeUnit).join(",")}`;
}

/** Minutes since IST midnight and the IST weekday (0 = Sunday) at `at`. */
function istClock(at: Date): { day: number; minutes: number } {
  const ist = new Date(at.getTime() + 330 * 60_000);
  return { day: ist.getUTCDay(), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
}

const toMinutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Is the dish offered at `at` by its own schedule (0062 available_days /
 * available_from / available_to)? Same rule as the guard; a window that
 * closes before it opens runs past midnight.
 */
export function offeredNow(
  item: { availableDays?: number[] | null; availableFrom?: string | null; availableTo?: string | null },
  at: Date = new Date()
): boolean {
  const { day, minutes } = istClock(at);
  if (item.availableDays && item.availableDays.length > 0 && !item.availableDays.includes(day)) return false;
  if (item.availableFrom && item.availableTo && item.availableFrom !== item.availableTo) {
    const from = toMinutes(item.availableFrom), to = toMinutes(item.availableTo);
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  }
  return true;
}
