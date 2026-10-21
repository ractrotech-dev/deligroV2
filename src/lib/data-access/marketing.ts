import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { notifyShop } from "@/lib/notifications/notify-user";
import {
  canMoveMarketing,
  type MarketingRequestInput,
  type MarketingStatus,
} from "@/lib/vendor/growth-input";

/**
 * Marketing requests (requirements §6, 0064): a shop asks Deligro for a banner,
 * a featured slot, a discount campaign…; an admin approves, rejects or moves it
 * along with remarks; the shop is told at every step.
 *
 * Reads for the shop go through its own client (RLS: owner read). Writes use
 * the service role, only after the route has resolved the shop from the
 * session (vendor) or checked the admin role.
 */
export class MarketingNotMigratedError extends Error {
  constructor() {
    super("needs_migration");
  }
}

export interface MarketingUpdate {
  status: string;
  remarks: string | null;
  by: "you" | "deligro";
  at: string;
}

export interface MarketingRequest {
  id: string;
  number: number;
  restaurantId: string;
  restaurantName?: string;
  kind: string;
  title: string;
  details: string;
  budget: number | null;
  startsOn: string | null;
  endsOn: string | null;
  status: MarketingStatus;
  adminRemarks: string | null;
  createdAt: string;
  updatedAt: string;
  updates: MarketingUpdate[];
}

const COLUMNS =
  "id, number, restaurant_id, kind, title, details, budget, starts_on, ends_on, status, admin_remarks, created_at, updated_at, marketing_request_updates(status, remarks, actor_role, created_at)";

function map(r: Record<string, unknown>, restaurantName?: string): MarketingRequest {
  const updates = ((r.marketing_request_updates as Record<string, unknown>[] | null) ?? [])
    .map((u) => ({
      status: String(u.status),
      remarks: (u.remarks as string | null) ?? null,
      by: (u.actor_role === "admin" ? "deligro" : "you") as MarketingUpdate["by"],
      at: String(u.created_at),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return {
    id: String(r.id),
    number: Number(r.number),
    restaurantId: String(r.restaurant_id),
    restaurantName,
    kind: String(r.kind),
    title: String(r.title),
    details: String(r.details),
    budget: r.budget == null ? null : Number(r.budget),
    startsOn: (r.starts_on as string | null) ?? null,
    endsOn: (r.ends_on as string | null) ?? null,
    status: r.status as MarketingStatus,
    adminRemarks: (r.admin_remarks as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    updates,
  };
}

export async function listShopMarketing(restaurantId: string): Promise<MarketingRequest[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("marketing_requests")
    .select(COLUMNS)
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingTable(error)) throw new MarketingNotMigratedError();
    throw error;
  }
  return (data ?? []).map((r) => map(r as Record<string, unknown>));
}

export async function createMarketingRequest(
  restaurantId: string,
  userId: string,
  input: MarketingRequestInput
): Promise<MarketingRequest> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("marketing_requests")
    .insert({
      restaurant_id: restaurantId,
      requested_by: userId,
      kind: input.kind,
      title: input.title,
      details: input.details,
      budget: input.budget,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
    })
    .select("id")
    .single();
  if (error) {
    if (isMissingTable(error)) throw new MarketingNotMigratedError();
    throw error;
  }
  await admin
    .from("marketing_request_updates")
    .insert({ request_id: data.id, status: "pending", actor_id: userId, actor_role: "vendor" });
  const { data: row, error: readError } = await admin.from("marketing_requests").select(COLUMNS).eq("id", data.id).single();
  if (readError) throw readError;
  return map(row as Record<string, unknown>);
}

/** The shop withdraws a request Deligro hasn't acted on. False when it can't. */
export async function cancelMarketingRequest(restaurantId: string, userId: string, id: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("marketing_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  await admin.from("marketing_request_updates").insert({ request_id: id, status: "cancelled", actor_id: userId, actor_role: "vendor" });
  return true;
}

// ---- Admin ----

export async function listAllMarketing(status?: MarketingStatus): Promise<MarketingRequest[]> {
  const admin = createAdminClient();
  let q = admin.from("marketing_requests").select(`${COLUMNS}, restaurants(name)`).order("created_at", { ascending: false }).limit(300);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) {
    if (isMissingTable(error)) throw new MarketingNotMigratedError();
    throw error;
  }
  return (data ?? []).map((r) => {
    const rest = (r as Record<string, unknown>).restaurants as { name: string } | { name: string }[] | null;
    return map(r as Record<string, unknown>, (Array.isArray(rest) ? rest[0]?.name : rest?.name) ?? "Shop");
  });
}

const STATUS_WORDS: Record<MarketingStatus, string> = {
  pending: "is waiting for review",
  approved: "was approved",
  in_progress: "is now in progress",
  completed: "is complete",
  rejected: "was not approved",
  cancelled: "was cancelled",
};

/** An admin moves a request on. Returns the error code when it can't. */
export async function decideMarketingRequest(
  id: string,
  adminId: string,
  decision: { status: MarketingStatus; remarks: string | null }
): Promise<{ ok: true } | { ok: false; error: "not_found" | "invalid_transition" }> {
  const admin = createAdminClient();
  const { data: cur, error } = await admin.from("marketing_requests").select("status, restaurant_id, title").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!cur) return { ok: false, error: "not_found" };
  if (!canMoveMarketing(cur.status as MarketingStatus, decision.status)) return { ok: false, error: "invalid_transition" };

  const { error: upd } = await admin
    .from("marketing_requests")
    .update({
      status: decision.status,
      ...(decision.remarks ? { admin_remarks: decision.remarks } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", cur.status);
  if (upd) throw upd;
  await admin.from("marketing_request_updates").insert({
    request_id: id,
    status: decision.status,
    remarks: decision.remarks,
    actor_id: adminId,
    actor_role: "admin",
  });
  await notifyShop(cur.restaurant_id as string, {
    category: "marketing",
    title: "Marketing request update",
    body: `"${cur.title}" ${STATUS_WORDS[decision.status]}.${decision.remarks ? ` ${decision.remarks}` : ""}`,
    url: `/more/marketing/${id}`,
    data: { requestId: id, status: decision.status },
  });
  return { ok: true };
}
