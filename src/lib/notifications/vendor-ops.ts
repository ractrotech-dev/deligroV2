import "server-only";
import { notifyShop } from "./notify-user";

/**
 * What Deligro operations tells a shop when it acts on the shop: a status
 * decision, a document review, a listing moderation or a stock change. Inbox
 * row plus push (notify-user.ts); never throws into the caller. Call through
 * deferNotify, after the change is committed. `url` is a path in the Partner
 * app (apps/vendor/lib/router.dart): `/more/store`, `/more/products[/<id>]`.
 */
export type VendorOpsKind = "status" | "document" | "listing" | "stock";

const CATEGORY = {
  status: "support",
  document: "support",
  listing: "support",
  stock: "low_stock",
} as const;

export async function notifyVendorOps(
  restaurantId: string,
  kind: VendorOpsKind,
  text: { title: string; body: string },
  url: string
): Promise<void> {
  await notifyShop(restaurantId, {
    category: CATEGORY[kind],
    title: text.title,
    body: text.body,
    url,
    data: { kind: `ops_${kind}` },
  });
}

const STATUS_TEXT: Record<string, { title: string; body: (reason: string) => string }> = {
  reactivate: { title: "Your shop is active again", body: (r) => `Deligro reactivated your shop. ${r}` },
  suspend: { title: "Your shop is suspended", body: (r) => `Deligro suspended your shop: ${r}` },
};

export function vendorStatusText(action: string, reason: string): { title: string; body: string } {
  const t = STATUS_TEXT[action] ?? { title: "Your shop status changed", body: (r: string) => r };
  return { title: t.title, body: t.body(reason).slice(0, 300) };
}

