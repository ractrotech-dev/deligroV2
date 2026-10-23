import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_ZONE, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { loadNameBook, type NameBook } from "@/lib/data-access/ops-names";
import { addDays, istDayKey, rangeBounds } from "@/lib/metrics/ist";
import type { DateRange } from "@/lib/metrics/types";
import { offerUsage, type OfferTerms } from "@/lib/ops/offer-rules";
import { mapMarketingRpcError } from "@/lib/ops/marketing-contract";
import {
  encodeOfferCursor, serializeChange, serializeOffer, serializeOfferDetail, termsJson,
  type OfferChange, type OfferDetail, type OfferNames, type OfferQuery, type OfferRow, type OfferSummary, type OfferUsage,
} from "@/lib/ops/offer-contract";
import type { OpsResult } from "@/lib/ops/order-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

/**
 * Manager offers (§9): the codes a manager may see (0164's ops_offer_rows —
 * platform-wide, or touching their shops/zones), their use, their change
 * history, and the audited writes (0161's ops_upsert_offer / ops_offer_action).
 * Callers authorise first (managerApiContext("manager.offers.manage")).
 */

const db = () => createAdminClient();
type Fail = Extract<OpsResult, { ok: false }>;
const NOT_FOUND: Fail = { ok: false, status: 404, error: "not_found" };

const zonesArg = (scope: ManagerScope) => {
  const z = scopeZoneIds(scope);
  return z === null ? null : z.length ? [...z] : [NO_ZONE];
};

async function offerRows(scope: ManagerScope, codes: string[] | null): Promise<OfferRow[]> {
  const { data, error } = await db().rpc("ops_offer_rows", { p_zones: zonesArg(scope), p_codes: codes });
  if (error) throw error;
  return (data ?? []) as OfferRow[];
}

function offerNames(book: NameBook): OfferNames {
  return { shop: book.shop, zone: book.zoneName, person: book.personName, item: book.item };
}

async function bookFor(rows: OfferRow[], extraPeople: string[] = []): Promise<NameBook> {
  return loadNameBook({
    shops: rows.flatMap((r) => r.vendor_ids), zones: rows.flatMap((r) => r.zone_ids),
    people: [...rows.map((r) => r.created_by), ...extraPeople], items: rows.flatMap((r) => r.item_ids),
  });
}

export async function getOfferSummaries(scope: ManagerScope, codes: string[], now: Date): Promise<OfferSummary[]> {
  const rows = await offerRows(scope, codes);
  const book = await bookFor(rows);
  return rows.map((r) => serializeOffer(r, offerNames(book), now));
}

export async function listOffers(scope: ManagerScope, q: OfferQuery, now: Date): Promise<{
  items: OfferSummary[]; nextCursor: string | null; counts: Record<"scheduled" | "active" | "expired" | "inactive" | "exhausted", number>;
}> {
  // 0164's ops_offer_page filters, counts by state and pages in SQL: one page and the
  // counts come back however many offers there are (limit + 1 rows say there is more).
  const { data, error } = await db().rpc("ops_offer_page", {
    p_zones: zonesArg(scope), p_state: q.state, p_vendor: q.vendorId ?? null, p_zone: q.zoneId ?? null, p_q: q.q ?? null,
    p_after_updated: q.cursor?.updatedAt ?? null, p_after_code: q.cursor?.code ?? null, p_limit: q.limit, p_now: now.toISOString(),
  });
  if (error) throw error;
  const r = (data ?? {}) as { counts?: Record<"scheduled" | "active" | "expired" | "inactive" | "exhausted", number>; rows?: OfferRow[] };
  const rows = r.rows ?? [];
  const page = rows.slice(0, q.limit);
  const book = await bookFor(page);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => serializeOffer(row, offerNames(book), now)),
    nextCursor: rows.length > q.limit && last ? encodeOfferCursor(new Date(last.updated_at).toISOString(), last.code) : null,
    counts: r.counts ?? { scheduled: 0, active: 0, expired: 0, inactive: 0, exhausted: 0 },
  };
}

export function defaultOfferRange(now: Date): DateRange {
  const to = istDayKey(now);
  return { from: addDays(to, -29), to };
}

export async function getOffer(scope: ManagerScope, code: string, range: DateRange | null, now: Date, admin: boolean): Promise<{
  offer: OfferDetail; usage: OfferUsage; changes: OfferChange[];
} | null> {
  const [row] = await offerRows(scope, [code]);
  if (!row) return null;
  const r = range ?? defaultOfferRange(now);
  const { start, endExclusive } = rangeBounds(r);
  const [red, changesRes, reqRes, campRes] = await Promise.all([
    db().rpc("ops_offer_redemption_rows", { p_code: code, p_from: start.toISOString(), p_to: endExclusive.toISOString() }),
    db().from("coupon_changes").select("id, created_at, actor_id, op, target, before, after, reason").eq("code", code)
      .order("id", { ascending: false }).limit(100),
    db().from("marketing_requests").select("id").eq("offer_code", code).limit(1),
    db().from("campaigns").select("id").eq("offer_code", code).limit(50),
  ]);
  if (red.error) throw red.error;
  if (changesRes.error) throw changesRes.error;
  const changeRows = (changesRes.data ?? []) as Parameters<typeof serializeChange>[0][];
  const book = await bookFor([row], changeRows.map((c) => c.actor_id ?? "").filter(Boolean));
  const redemptions = ((red.data ?? []) as { order_id: string; customer_id: string; discount: number; created_at: string; restaurant_id: string;
    cancelled: boolean; order_total: number; funded_by: "platform" | "vendor" | null; first_order: boolean }[]).map((x) => ({
    orderId: x.order_id, customerId: x.customer_id, discount: x.discount, createdAt: x.created_at, restaurantId: x.restaurant_id,
    cancelled: x.cancelled, orderTotal: x.order_total, fundedBy: x.funded_by, firstOrder: x.first_order,
  }));
  const usage = offerUsage(redemptions, r, { maxRedemptions: row.max_redemptions, totalRedemptions: row.redemptions });
  const vendorBook = await loadNameBook({ shops: usage.byVendor.map((v) => v.vendorId) });
  return {
    offer: serializeOfferDetail(row, offerNames(book), now, admin, ((reqRes.data ?? []) as { id: string }[])[0]?.id ?? null,
      ((campRes.data ?? []) as { id: string }[]).map((c) => c.id)),
    // The contract names vendors, never customers.
    usage: { ...usage, byVendor: usage.byVendor.map((v) => ({ vendor: { id: v.vendorId, name: vendorBook.shop(v.vendorId) },
      redemptions: v.redemptions, discountGiven: v.discountGiven })) },
    changes: changeRows.map((c) => serializeChange(c, book.person)),
  };
}

export async function updatedAtOf(code: string): Promise<string | null> {
  const { data } = await db().from("coupons").select("updated_at").eq("code", code).maybeSingle();
  return (data as { updated_at: string } | null)?.updated_at ?? null;
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { error } = await db().rpc(name, args);
  return error as { code?: string; message?: string; details?: string | null } | null;
}

export async function createOfferOps(actor: OpsActor, terms: OfferTerms, clientActionId: string): Promise<OpsResult> {
  const { code, ...rest } = terms;
  const error = await rpc("ops_upsert_offer", { p_actor: actor.id, p_code: code, p_terms: termsJson(rest), p_expected_updated_at: null,
    p_reason: null, p_client_action_id: clientActionId });
  return error ? mapMarketingRpcError(error) : { ok: true };
}

export async function updateOfferOps(actor: OpsActor, scope: ManagerScope, code: string, body: {
  changes: Partial<OfferTerms>; expectedUpdatedAt: string; reason: string; clientActionId: string;
}): Promise<OpsResult> {
  const [row] = await offerRows(scope, [code]);
  if (!row) return NOT_FOUND;
  const error = await rpc("ops_upsert_offer", { p_actor: actor.id, p_code: code, p_terms: termsJson(body.changes),
    p_expected_updated_at: body.expectedUpdatedAt, p_reason: body.reason, p_client_action_id: body.clientActionId });
  return error ? mapMarketingRpcError(error) : { ok: true };
}

export async function offerActionOps(actor: OpsActor, scope: ManagerScope, code: string, action: "activate" | "deactivate", reason: string,
  clientActionId: string): Promise<OpsResult> {
  const [row] = await offerRows(scope, [code]);
  if (!row) return NOT_FOUND;
  const error = await rpc("ops_offer_action", { p_actor: actor.id, p_code: code, p_action: action, p_reason: reason,
    p_client_action_id: clientActionId });
  return error ? mapMarketingRpcError(error) : { ok: true };
}
