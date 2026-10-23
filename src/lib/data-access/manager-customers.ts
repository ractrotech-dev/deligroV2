import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_ZONE, narrowScope, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { applyAuthBan, currentCustomerStatus } from "@/lib/auth/account-status.server";
import { alreadyThere } from "@/lib/auth/account-status";
import { loadNameBook } from "@/lib/data-access/ops-names";
import { retentionSummary, type RetentionCohort, type RetentionSummary } from "@/lib/metrics/customers";
import { rangeBounds } from "@/lib/metrics/ist";
import type { DateRange } from "@/lib/metrics/types";
import { mapMarketingRpcError } from "@/lib/ops/marketing-contract";
import { OPEN_TICKET_STATUSES, TICKET_COLUMNS, toTicketSummary, type TicketRow, type TicketSummary } from "@/lib/ops/vendor-contract";
import {
  customerAllowed, displayName, encodeCustomerCursor, localityOf, serializeCustomer, shortIdOf,
  type CustomerDetail, type CustomerListRow, type CustomerQuery, type CustomerSummary,
} from "@/lib/ops/customer-contract";
import { maskPhone } from "@/lib/ops/offer-rules";
import type { OpsResult } from "@/lib/ops/order-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

/**
 * Manager customers (§10): the customers who ordered in a manager's zones,
 * one customer's figures, their complaints and feedback, retention, contact
 * reveal and suspension. Reads are service-role and always zone-scoped (0162's
 * SQL takes the zones); writes are 0162's audited RPCs. Callers authorise first.
 */

const db = () => createAdminClient();
type Fail = Extract<OpsResult, { ok: false }>;
const NOT_FOUND: Fail = { ok: false, status: 404, error: "not_found" };

const zonesArg = (scope: ManagerScope) => {
  const z = scopeZoneIds(scope);
  return z === null ? null : z.length ? [...z] : [NO_ZONE];
};

async function zoneNames(rows: { zone_ids: string[] | null }[]) {
  const book = await loadNameBook({ zones: rows.flatMap((r) => r.zone_ids ?? []) });
  return book.zoneName;
}

export async function listCustomers(scope: ManagerScope, q: CustomerQuery, ids: string[] | null = null): Promise<{
  items: CustomerSummary[]; nextCursor: string | null;
}> {
  const { data, error } = await db().rpc("ops_customer_list", {
    p_zones: zonesArg(narrowScope(scope, q.zoneId)), p_q: q.q, p_status: q.status, p_sort: q.sort,
    p_after_key: q.cursor?.key ?? null, p_after_id: q.cursor?.id ?? null, p_limit: q.limit + 1, p_ids: ids,
  });
  if (error) throw error;
  const rows = (data ?? []) as CustomerListRow[];
  const page = rows.slice(0, q.limit);
  const zone = await zoneNames(page);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => serializeCustomer(r, zone)),
    nextCursor: rows.length > q.limit && last ? encodeCustomerCursor(last.sort_key, last.id) : null,
  };
}

/** Phone search: audited (last four digits only), then the in-scope matches. */
export async function searchCustomersByPhone(actor: OpsActor, scope: ManagerScope, q: CustomerQuery, phone: string, clientActionId: string) {
  const { data, error } = await db().rpc("ops_search_customer_by_phone", { p_actor: actor.id, p_phone: phone, p_client_action_id: clientActionId });
  if (error) throw error;
  const ids = (data ?? []) as string[];
  if (ids.length === 0) return { items: [] as CustomerSummary[], nextCursor: null };
  return listCustomers(scope, { ...q, q: null }, ids);
}

interface Facts { orders: number; spent: number; cancelled: number; firstOrderAt: string | null; lastOrderAt: string | null;
  zoneIds: string[]; addressLines: string[] }

async function facts(scope: ManagerScope, id: string): Promise<Facts> {
  const { data, error } = await db().rpc("ops_customer_facts", { p_customer: id, p_zones: zonesArg(scope) });
  if (error) throw error;
  return data as Facts;
}

/** Is this customer visible to the scope (an order in one of its zones)? */
export async function customerVisible(scope: ManagerScope, id: string): Promise<boolean> {
  const { data } = await db().from("profiles").select("role").eq("id", id).maybeSingle();
  if (!data || (data as { role: string }).role !== "customer") return false;
  // An admin may act on any customer, including one who never ordered; a manager only on
  // one who ordered in their zones (0162's _ops_require_customer is the same rule).
  if (scope.all) return true;
  return (await facts(scope, id)).zoneIds.length > 0;
}

export async function getCustomer(scope: ManagerScope, id: string, permissions: Record<string, boolean>): Promise<CustomerDetail | null> {
  const { data, error } = await db().from("profiles")
    .select("id, full_name, phone, role, account_status, status_reason, status_changed_by, status_changed_at, created_at")
    .eq("id", id).maybeSingle();
  if (error) throw error;
  const p = data as { id: string; full_name: string | null; phone: string | null; role: string; account_status: string | null;
    status_reason: string | null; status_changed_by: string | null; status_changed_at: string | null; created_at: string } | null;
  if (!p || p.role !== "customer") return null;
  const f = await facts(scope, id);
  if (f.zoneIds.length === 0 && !scope.all) return null;
  const zones = zonesArg(scope);
  let reviewsQ = db().from("reviews").select("rating, restaurants!inner(zone_id)").eq("user_id", id).limit(1000);
  if (zones) reviewsQ = reviewsQ.in("restaurants.zone_id", zones);
  let ticketsQ = db().from("support_tickets").select("id", { count: "exact", head: true }).eq("requester_id", id)
    .in("status", [...OPEN_TICKET_STATUSES]);
  if (zones) ticketsQ = ticketsQ.in("zone_id", zones);
  let refundsQ = db().from("refunds").select("id, orders!inner(customer_id, zone_id)", { count: "exact", head: true })
    .eq("status", "pending").eq("orders.customer_id", id);
  if (zones) refundsQ = refundsQ.in("orders.zone_id", zones);
  const [reviews, tickets, refunds] = await Promise.all([reviewsQ, ticketsQ, refundsQ]);
  const ratings = ((reviews.data ?? []) as { rating: number }[]).map((r) => r.rating);
  const book = await loadNameBook({ zones: f.zoneIds, people: [p.status_changed_by] });
  const status = (p.account_status ?? "active") as CustomerDetail["status"];
  return {
    id: p.id,
    shortId: shortIdOf(p.id),
    name: displayName(p.full_name),
    phoneMasked: maskPhone(p.phone),
    status,
    memberSince: new Date(p.created_at).toISOString(),
    orders: f.orders,
    spent: f.spent,
    lastOrderAt: f.lastOrderAt ? new Date(f.lastOrderAt).toISOString() : null,
    zones: f.zoneIds.map((z) => ({ id: z, name: book.zoneName(z) })),
    statusReason: p.status_reason,
    statusChangedAt: p.status_changed_at,
    statusChangedBy: p.status_changed_by ? { id: p.status_changed_by, name: book.personName(p.status_changed_by) } : null,
    localities: [...new Set(f.addressLines.map(localityOf).filter((x): x is string => !!x))].slice(0, 5),
    cancelledOrders: f.cancelled,
    aov: f.orders > 0 ? Math.round(f.spent / f.orders) : 0,
    firstOrderAt: f.firstOrderAt ? new Date(f.firstOrderAt).toISOString() : null,
    ratingsGiven: ratings.length,
    avgRatingGiven: ratings.length ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10 : null,
    openComplaints: tickets.count ?? 0,
    pendingRefunds: refunds.count ?? 0,
    allowed: customerAllowed(status, permissions),
  };
}

const PAGE = 50;
const keyCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
export function decodeKeyCursor(s: string | null): { at: string; id: string } | null {
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const raw = Buffer.from(s, "base64url").toString("utf8");
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  const at = raw.slice(0, bar), id = raw.slice(bar + 1);
  return Number.isNaN(Date.parse(at)) ? null : { at, id };
}

/** Tickets this customer raised, in scope, newest first. */
export async function listCustomerComplaints(scope: ManagerScope, id: string, cursor: { at: string; id: string } | null): Promise<{
  items: TicketSummary[]; nextCursor: string | null;
}> {
  const zones = zonesArg(scope);
  let q = db().from("support_tickets").select(TICKET_COLUMNS).eq("requester_id", id);
  if (zones) q = q.in("zone_id", zones);
  if (cursor) q = q.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE + 1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as TicketRow[];
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  return { items: page.map(toTicketSummary), nextCursor: rows.length > PAGE && last ? keyCursor(last.created_at, last.id) : null };
}

export interface FeedbackPage {
  reviews: { id: string; vendor: { id: string; name: string }; orderCode: string | null; rating: number; comment: string | null;
    createdAt: string; flagged: boolean; reply: string | null }[];
  riderRatings: { id: string; rider: { id: string; name: string; code: string | null }; orderCode: string | null; rating: number;
    comment: string | null; createdAt: string }[];
  nextCursor: string | null;
}

/** Restaurant reviews and rider ratings this customer left, in scope. */
export async function listCustomerFeedback(scope: ManagerScope, id: string, cursor: { at: string; id: string } | null): Promise<FeedbackPage> {
  const zones = zonesArg(scope);
  let rq = db().from("reviews")
    .select("id, rating, comment, created_at, restaurant_id, status, orders!inner(short_code, zone_id), review_replies(reply_text), review_flags(id)")
    .eq("user_id", id);
  if (zones) rq = rq.in("orders.zone_id", zones);
  if (cursor) rq = rq.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await rq.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE + 1);
  if (error) throw error;
  type ReviewRow = { id: string; rating: number; comment: string | null; created_at: string; restaurant_id: string; status: string | null;
    orders: { short_code: string | null } | { short_code: string | null }[] | null; review_replies: { reply_text: string }[] | { reply_text: string } | null;
    review_flags: { id: string }[] | null };
  const rows = (data ?? []) as unknown as ReviewRow[];
  const page = rows.slice(0, PAGE);

  // Rider ratings (Rider 0084) — absent tables leave the list empty.
  let ratings: { id: string; driver_id: string; rating: number; comment: string | null; created_at: string; order_id: string }[] = [];
  if (!cursor) {
    let k = db().from("rider_ratings").select("id, driver_id, rating, comment, created_at, order_id, orders!inner(zone_id)").eq("customer_id", id);
    if (zones) k = k.in("orders.zone_id", zones);
    const { data: rd } = await k.order("created_at", { ascending: false }).limit(PAGE);
    ratings = (rd ?? []) as unknown as typeof ratings;
  }
  const [codes, riderCodes] = await Promise.all([
    ratings.length ? db().from("orders").select("id, short_code").in("id", ratings.map((r) => r.order_id)) : Promise.resolve({ data: [] }),
    ratings.length ? db().from("rider_profiles").select("driver_id, rider_code").in("driver_id", ratings.map((r) => r.driver_id)) : Promise.resolve({ data: [] }),
  ]);
  const codeOf = new Map(((codes.data ?? []) as { id: string; short_code: string | null }[]).map((o) => [o.id, o.short_code]));
  const riderCodeOf = new Map(((riderCodes.data ?? []) as { driver_id: string; rider_code: string | null }[]).map((r) => [r.driver_id, r.rider_code]));
  const book = await loadNameBook({ shops: page.map((r) => r.restaurant_id), people: ratings.map((r) => r.driver_id) });
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);
  const last = page[page.length - 1];
  return {
    reviews: page.map((r) => ({
      id: r.id, vendor: { id: r.restaurant_id, name: book.shop(r.restaurant_id) }, orderCode: one(r.orders)?.short_code ?? null,
      rating: r.rating, comment: r.comment, createdAt: new Date(r.created_at).toISOString(),
      flagged: (r.review_flags ?? []).length > 0 || r.status === "hidden", reply: one(r.review_replies)?.reply_text ?? null,
    })),
    riderRatings: ratings.map((r) => ({
      id: r.id, rider: { id: r.driver_id, name: book.personName(r.driver_id), code: riderCodeOf.get(r.driver_id) ?? null },
      orderCode: codeOf.get(r.order_id) ?? null, rating: r.rating, comment: r.comment, createdAt: new Date(r.created_at).toISOString(),
    })),
    nextCursor: rows.length > PAGE && last ? keyCursor(last.created_at, last.id) : null,
  };
}

/**
 * Retention for the scope over the range (§10.6). 0162's ops_retention computes
 * the summary and the cohorts in SQL — one row, exact however many customers
 * there are; src/lib/metrics/customers.ts is the reference it is held to.
 */
export async function getRetention(scope: ManagerScope, range: DateRange): Promise<{ summary: RetentionSummary; cohorts: RetentionCohort[] }> {
  const { start, endExclusive } = rangeBounds(range);
  const { data, error } = await db().rpc("ops_retention", {
    p_zones: zonesArg(scope), p_from: start.toISOString(), p_to: endExclusive.toISOString(), p_months: 6,
  });
  if (error) throw error;
  const r = (data ?? {}) as { summary?: RetentionSummary; cohorts?: RetentionCohort[] };
  return { summary: r.summary ?? retentionSummary([], range), cohorts: r.cohorts ?? [] };
}

// ── writes ───────────────────────────────────────────────────────────────

export async function revealContact(actor: OpsActor, scope: ManagerScope, id: string, reason: string, note: string | null,
  clientActionId: string): Promise<{ ok: true; phone: string | null; email: string | null } | Fail> {
  if (!(await customerVisible(scope, id))) return NOT_FOUND;
  const { data, error } = await db().rpc("ops_reveal_customer_contact", {
    p_actor: actor.id, p_customer: id, p_reason: reason, p_note: note, p_client_action_id: clientActionId,
  });
  if (error) return mapMarketingRpcError(error) as Fail;
  const c = (data ?? {}) as { phone?: string | null; email?: string | null };
  return { ok: true, phone: c.phone ?? null, email: c.email ?? null };
}

/**
 * Suspend, restrict or reactivate (0162's RPC), then the Supabase Auth ban.
 * The status is saved first; a failed ban answers 502 effect_failed and a
 * retry with the same clientActionId re-applies only the ban.
 */
export async function setCustomerAccount(actor: OpsActor, scope: ManagerScope, id: string, body: {
  action: "suspend" | "restrict" | "reactivate"; expected: string; reason: string; clientActionId: string;
}): Promise<OpsResult> {
  if (!(await customerVisible(scope, id))) return NOT_FOUND;
  const { data, error } = await db().rpc("ops_set_customer_account", {
    p_actor: actor.id, p_customer: id, p_action: body.action, p_expected: body.expected, p_reason: body.reason,
    p_client_action_id: body.clientActionId,
  });
  if (error) {
    // A retry under a new action id after a ban that never landed finds the status already
    // saved (stale). If it is the state that was asked for, only the ban is left to do.
    if (error.message === "stale" && alreadyThere(body.action, await currentCustomerStatus(id))) {
      try {
        await applyAuthBan(id, body.action, actor.id);
      } catch {
        return { ok: false, status: 500, error: "effect_failed", extra: { httpStatus: 502 } };
      }
      return { ok: true };
    }
    return mapMarketingRpcError(error);
  }
  const status = (data as { status?: string } | null)?.status;
  const effective = status === "suspended" ? "suspend" : status === "restricted" ? "restrict" : "reactivate";
  try {
    await applyAuthBan(id, effective, actor.id);
  } catch {
    return { ok: false, status: 500, error: "effect_failed", extra: { httpStatus: 502 } };
  }
  return { ok: true };
}
