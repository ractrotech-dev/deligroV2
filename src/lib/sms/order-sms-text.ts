/**
 * The words of the new-order text to a shop. Pure, so
 * scripts/qa/vendor-order-sms-text.ts can check it without a gateway.
 *
 * Each SMS is paid for by length, so the dishes and the note are capped. The note
 * is typed by the customer and goes out under Deligro's sender, so a link in it is
 * removed: this must not be a way to text a shop a link from us.
 */

import { toE164 } from "@/lib/auth/phone";

export const DEFAULT_ORDER_SMS_TEMPLATE =
  "Deligro: You have received a new order #{order}: {dishes}.{instructions} Open the Partner app to accept.";

/** The message before dishes were added. A shop still on it gets the new one. */
export const OLD_DEFAULT_ORDER_SMS_TEMPLATE =
  "Deligro: new order #{order} for {shop} ({items} items, Rs {total}). Open the Deligro Partner app to accept.";

const MAX_DISHES = 100;
const MAX_NOTE = 80;

/**
 * The number a shop registered with, wherever onboarding put it: the owner's mobile
 * on the shop, then the phone on the owner's account (most imported shops only have
 * this one), then the shop's public number. One rule, so the Vendor SMS page shows
 * exactly the number a text goes to. Anything that is not a phone number is skipped.
 */
export function registeredShopNumber(shop: {
  ownerMobile?: string | null;
  ownerAccountPhone?: string | null;
  shopPhone?: string | null;
}): string | null {
  for (const raw of [shop.ownerMobile, shop.ownerAccountPhone, shop.shopPhone]) {
    const e164 = raw?.trim() ? toE164(raw) : null;
    if (e164) return e164;
  }
  return null;
}

export function cap(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** "2x Paneer Butter Masala, 1x Naan", then "+3 more" once it runs long. */
export function orderDishes(lines: { name: string | null; qty: number | null }[]): string {
  const dishes = lines
    .map((l) => ({ name: (l.name ?? "").replace(/\s+/g, " ").trim(), qty: l.qty ?? 1 }))
    .filter((l) => l.name)
    .map((l) => `${l.qty}x ${l.name}`);
  if (dishes.length === 0) return "see the Partner app";

  let text = "";
  for (let i = 0; i < dishes.length; i++) {
    const next = text ? `${text}, ${dishes[i]}` : dishes[i];
    const left = dishes.length - i - 1;
    const tail = left > 0 ? ` +${left} more` : "";
    if (Array.from(next + tail).length > MAX_DISHES) {
      if (!text) return `${cap(dishes[i], MAX_DISHES - tail.length)}${tail}`;
      return `${text} +${dishes.length - i} more`;
    }
    text = next;
  }
  return text;
}

/** " Instructions: less spicy." with its leading space, or nothing when there are none. */
export function orderInstructions(note: string | null | undefined): string {
  const clean = (note ?? "")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return ` Instructions: ${cap(clean, MAX_NOTE).replace(/[.!]+$/, "")}.`;
}

export function fillOrderSms(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{(order|shop|items|total|dishes|instructions)\}/g, (_, k: string) => values[k] ?? "")
    .replace(/ {2,}/g, " ")
    .trim();
}
