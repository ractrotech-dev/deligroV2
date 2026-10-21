import "server-only";
import { notifyShop } from "./notify-user";

/**
 * What Deligro operations tells a shop when it acts on the shop: a status
 * decision, a document review, a listing moderation or a stock change. Inbox
 * row plus push (notify-user.ts); never throws into the caller. Call through
 * deferNotify, after the change is committed.
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
  approve: { title: "Your shop is approved", body: () => "Your shop is live on Deligro. Open the app to start taking orders." },
  reactivate: { title: "Your shop is active again", body: (r) => `Deligro reactivated your shop. ${r}` },
  suspend: { title: "Your shop is suspended", body: (r) => `Deligro suspended your shop: ${r}` },
  reject: { title: "Your registration was not approved", body: (r) => `Deligro could not approve your shop: ${r}` },
};

export function vendorStatusText(action: string, reason: string): { title: string; body: string } {
  const t = STATUS_TEXT[action] ?? { title: "Your shop status changed", body: (r: string) => r };
  return { title: t.title, body: t.body(reason).slice(0, 300) };
}

const DOC_NAMES: Record<string, string> = {
  fssai: "FSSAI licence",
  gst: "GST certificate",
  pan: "PAN card",
  bank_proof: "Bank proof",
  shop_license: "Shop licence",
  other: "Document",
};

export function documentDecisionText(type: string, decision: "verified" | "rejected", remarks: string | null): { title: string; body: string } {
  const name = DOC_NAMES[type] ?? "Document";
  return decision === "verified"
    ? { title: `${name} verified`, body: `Deligro verified your ${name.toLowerCase()}.` }
    : { title: `${name} needs another look`, body: `Deligro could not verify your ${name.toLowerCase()}: ${remarks ?? ""}`.slice(0, 300) };
}
