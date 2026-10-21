/**
 * Bodies of the product action and restricted-category routes, and the
 * permission each action needs (Phase 4 plan, Global Constraints). Pure.
 */
import { isUuid } from "@/lib/auth/manager-scope";

export type ProductActionName = "flag" | "hide" | "unhide" | "approve" | "reject" | "resolve_flag" | "dismiss_flag" | "adjust_stock";

export const PRODUCT_ACTION_PERMISSION: Record<ProductActionName, string> = {
  flag: "manager.products.view",
  hide: "manager.products.moderate",
  unhide: "manager.products.moderate",
  approve: "manager.products.moderate",
  reject: "manager.products.moderate",
  resolve_flag: "manager.products.moderate",
  dismiss_flag: "manager.products.moderate",
  adjust_stock: "manager.products.adjust_stock",
};

export const FLAG_REASONS = ["inaccurate", "inappropriate", "wrong_image", "wrong_price", "wrong_category", "other"] as const;

export type ParsedProductAction =
  | { action: "flag"; flagReason: (typeof FLAG_REASONS)[number]; note: string | null; clientActionId: string }
  | { action: "hide" | "unhide"; reason: string; clientActionId: string }
  | { action: "approve"; reason: string | null; clientActionId: string }
  | { action: "reject"; reason: string; clientActionId: string }
  | { action: "resolve_flag" | "dismiss_flag"; flagId: string; reason: string; clientActionId: string }
  | { action: "adjust_stock"; stockQty: number | null; reason: string; clientActionId: string };

type Fail = { ok: false; status: 400; error: "bad_request" | "reason_required"; field?: string };
const bad = (field: string): Fail => ({ ok: false, status: 400, error: "bad_request", field });
const needReason: Fail = { ok: false, status: 400, error: "reason_required" };
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const reasonOf = (v: unknown, max = 300): string | null => {
  const t = text(v);
  return t && t.length >= 3 && t.length <= max ? t : null;
};

export function parseProductActionBody(body: Record<string, unknown> | null): { ok: true; action: ParsedProductAction } | Fail {
  if (!body) return bad("body");
  const action = body.action;
  if (typeof action !== "string" || !(action in PRODUCT_ACTION_PERMISSION)) return bad("action");
  const clientActionId = body.clientActionId;
  if (typeof clientActionId !== "string" || !isUuid(clientActionId)) return bad("clientActionId");

  switch (action as ProductActionName) {
    case "flag": {
      const flagReason = body.flagReason;
      if (typeof flagReason !== "string" || !FLAG_REASONS.includes(flagReason as (typeof FLAG_REASONS)[number])) return bad("flagReason");
      // `note` is the description; `reason` is accepted from older clients.
      const note = text(body.note ?? body.reason);
      if (note && note.length > 500) return needReason;
      return { ok: true, action: { action: "flag", flagReason: flagReason as (typeof FLAG_REASONS)[number], note, clientActionId } };
    }
    case "hide":
    case "unhide": {
      const reason = reasonOf(body.reason);
      if (!reason) return needReason;
      return { ok: true, action: { action: action as "hide" | "unhide", reason, clientActionId } };
    }
    case "approve": {
      const note = text(body.reason);
      if (note && note.length > 300) return needReason;
      return { ok: true, action: { action: "approve", reason: note, clientActionId } };
    }
    case "reject": {
      const reason = reasonOf(body.reason);
      if (!reason) return needReason;
      return { ok: true, action: { action: "reject", reason, clientActionId } };
    }
    case "resolve_flag":
    case "dismiss_flag": {
      if (typeof body.flagId !== "string" || !isUuid(body.flagId)) return bad("flagId");
      const reason = reasonOf(body.reason, 500);
      if (!reason) return needReason;
      return { ok: true, action: { action: action as "resolve_flag" | "dismiss_flag", flagId: body.flagId.toLowerCase(), reason, clientActionId } };
    }
    case "adjust_stock": {
      const qty = body.stockQty;
      if (qty !== null && (typeof qty !== "number" || !Number.isInteger(qty) || qty < 0 || qty > 100_000)) return bad("stockQty");
      const reason = reasonOf(body.reason);
      if (!reason) return needReason;
      return { ok: true, action: { action: "adjust_stock", stockQty: qty as number | null, reason, clientActionId } };
    }
  }
}

export function parseRestrictedCategoryBody(
  body: Record<string, unknown> | null
): { ok: true; body: { name: string; restricted: boolean; reason: string; clientActionId: string } } | Fail {
  if (!body) return bad("body");
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) return bad("clientActionId");
  const name = text(body.name);
  if (!name || name.length > 60) return bad("name");
  if (typeof body.restricted !== "boolean") return bad("restricted");
  const reason = reasonOf(body.reason);
  if (!reason) return needReason;
  return { ok: true, body: { name, restricted: body.restricted, reason, clientActionId: body.clientActionId } };
}
