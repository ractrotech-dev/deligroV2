import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ManagerScope } from "@/lib/auth/manager-scope";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyVendorOps } from "@/lib/notifications/vendor-ops";
import { imageChangeProduct, scopedProductRow } from "@/lib/data-access/manager-products";
import type { OpsResult } from "@/lib/ops/order-actions";
import { mapProductRpcError, staleStockExtra, type ParsedProductAction } from "@/lib/ops/product-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export { listRestrictedCategories } from "@/lib/data-access/manager-products";

/**
 * Manager product actions (§12.8, §12.9, stock): flag, hide / unhide,
 * approve / reject a restricted listing, resolve / dismiss a flag, adjust
 * stock. Each is one 0146 RPC that changes the dish and writes its audit row,
 * with the zone checked in the database. The shop owner is told after the
 * response. Callers authorise first (managerApiContext + the action's switch).
 */

const NOT_FOUND: OpsResult = { ok: false, status: 404, error: "not_found" };

async function alreadyDone(actorId: string, clientActionId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("ops_audit_log")
    .select("actor_id")
    .eq("client_action_id", clientActionId)
    .maybeSingle();
  return !!data && (data as { actor_id: string }).actor_id === actorId;
}

const FLAG_TEXT: Record<string, string> = {
  inaccurate: "is inaccurate",
  inappropriate: "is not appropriate",
  wrong_image: "has the wrong photo",
  wrong_price: "has the wrong price",
  wrong_category: "is in the wrong category",
  other: "needs a look",
};

export async function opsProductAction(
  actor: OpsActor,
  scope: ManagerScope,
  id: string,
  a: ParsedProductAction
): Promise<OpsResult> {
  const row = await scopedProductRow(scope, id);
  if (!row) return NOT_FOUND;
  // A flag must belong to this dish; resolving someone else's dish's flag is a 404.
  if (a.action === "resolve_flag" || a.action === "dismiss_flag") {
    const { data } = await createAdminClient().from("listing_flags").select("id").eq("id", a.flagId).eq("menu_item_id", id).maybeSingle();
    if (!data) return NOT_FOUND;
  }
  const replay = await alreadyDone(actor.id, a.clientActionId);
  const supabase = createAdminClient();
  const call = (() => {
    switch (a.action) {
      case "flag":
        return supabase.rpc("ops_flag_listing", { p_actor: actor.id, p_item: id, p_reason: a.flagReason, p_note: a.note, p_client_action_id: a.clientActionId });
      case "hide":
      case "unhide":
        return supabase.rpc("ops_set_listing_hidden", { p_actor: actor.id, p_item: id, p_hidden: a.action === "hide", p_reason: a.reason, p_client_action_id: a.clientActionId });
      case "approve":
      case "reject":
        return supabase.rpc("ops_decide_listing", { p_actor: actor.id, p_item: id, p_decision: a.action, p_reason: a.reason, p_client_action_id: a.clientActionId });
      case "resolve_flag":
      case "dismiss_flag":
        return supabase.rpc("ops_resolve_listing_flag", {
          p_actor: actor.id, p_flag: a.flagId, p_status: a.action === "resolve_flag" ? "resolved" : "dismissed",
          p_resolution: a.reason, p_client_action_id: a.clientActionId,
        });
      case "adjust_stock":
        return supabase.rpc("ops_adjust_stock", {
          p_actor: actor.id, p_item: id, p_stock_qty: a.stockQty, p_expected_stock: a.expectedStockQty,
          p_reason: a.reason, p_client_action_id: a.clientActionId,
        });
    }
  })();
  const { error } = await call;
  if (error) {
    const e = error as { code?: string; message?: string; details?: string | null };
    // Stock moved since the manager looked: say what it is now, so the app can ask again.
    if (a.action === "adjust_stock" && (e.message ?? "").trim() === "stale") {
      return { ok: false, status: 409, error: "stale", extra: staleStockExtra(e.details) };
    }
    return mapProductRpcError(e);
  }

  if (!replay) {
    const dish = row.name;
    const url = `/menu/${id}`;
    if (a.action === "flag") {
      deferNotify(() => notifyVendorOps(row.restaurant_id, "listing", { title: `${dish} was flagged`, body: `Deligro thinks ${dish} ${FLAG_TEXT[a.flagReason]}. Please check the listing.` }, url));
    } else if (a.action === "hide") {
      deferNotify(() => notifyVendorOps(row.restaurant_id, "listing", { title: `${dish} is hidden`, body: `Deligro hid ${dish} from customers: ${a.reason}` }, url));
    } else if (a.action === "unhide") {
      deferNotify(() => notifyVendorOps(row.restaurant_id, "listing", { title: `${dish} is visible again`, body: `Deligro made ${dish} visible to customers again.` }, url));
    } else if (a.action === "approve") {
      deferNotify(() => notifyVendorOps(row.restaurant_id, "listing", { title: `${dish} approved`, body: `Deligro approved your change to ${dish}.` }, url));
    } else if (a.action === "reject") {
      deferNotify(() => notifyVendorOps(row.restaurant_id, "listing", { title: `${dish} not approved`, body: `Deligro did not approve your change to ${dish}: ${a.reason}` }, url));
    } else if (a.action === "adjust_stock") {
      const what = a.stockQty === null ? `stopped tracking stock for ${dish}` : `set the stock of ${dish} to ${a.stockQty}`;
      deferNotify(() => notifyVendorOps(row.restaurant_id, "stock", { title: `Stock for ${dish} changed`, body: `Deligro ${what}: ${a.reason}` }, url));
    }
  }
  return { ok: true };
}

export async function opsSetRestrictedCategory(
  actor: OpsActor,
  name: string,
  restricted: boolean,
  reason: string,
  clientActionId: string
): Promise<OpsResult> {
  const { error } = await createAdminClient().rpc("ops_set_restricted_category", {
    p_actor: actor.id,
    p_name: name,
    p_restricted: restricted,
    p_reason: reason,
    p_client_action_id: clientActionId,
  });
  if (error) return mapProductRpcError(error as { code?: string; message?: string; details?: string | null });
  return { ok: true };
}

/** §12.7: mark a queued vendor photo fine, or flag it (opens a listing flag). One audited RPC (0146). */
export async function opsReviewImage(
  actor: OpsActor,
  scope: ManagerScope,
  changeId: number,
  b: { outcome: "ok" | "flag"; flagReason: string | null; note: string | null; clientActionId: string }
): Promise<OpsResult> {
  const dish = await imageChangeProduct(scope, changeId);
  if (!dish) return NOT_FOUND;
  const replay = await alreadyDone(actor.id, b.clientActionId);
  const { error } = await createAdminClient().rpc("ops_review_listing_image", {
    p_actor: actor.id,
    p_change: changeId,
    p_outcome: b.outcome,
    p_flag_reason: b.flagReason,
    p_note: b.note,
    p_client_action_id: b.clientActionId,
  });
  if (error) return mapProductRpcError(error as { code?: string; message?: string; details?: string | null });
  if (!replay && b.outcome === "flag") {
    const what = b.flagReason === "inappropriate" ? "is not appropriate" : "does not show the dish";
    deferNotify(() =>
      notifyVendorOps(dish.restaurant_id, "listing", { title: `Photo of ${dish.name} flagged`, body: `Deligro thinks the photo of ${dish.name} ${what}: ${b.note}` }, `/menu/${dish.id}`)
    );
  }
  return { ok: true };
}
