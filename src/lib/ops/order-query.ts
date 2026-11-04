/**
 * `GET /api/manager/orders` query parameters → a validated `OrderQuery`, and
 * the keyset cursor. Pure. A bad parameter is named (`field`) so the route can
 * answer 400 `bad_request` with it.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { addDays, istDayKey, istDayStart } from "@/lib/metrics/ist";
import { phoneE164 } from "./customer-contract";
import type { DbOrderStatus } from "./order-contract";

export type OrderQueue = "delayed" | "unassigned" | "cancelled";

/**
 * What the search box asked for. `text` looks in customer and shop names;
 * `codePrefix` is set when the word could also be an order code ("cafe" is a
 * shop and hex). `phone` is a whole number, and needs the contact permission.
 */
export type OrderSearch =
  | { kind: "id"; id: string }
  | { kind: "code"; prefix: string }
  | { kind: "phone"; phone: string }
  | { kind: "text"; text: string; codePrefix?: string };

export interface OrderQuery {
  q?: OrderSearch;
  /** Filled in by the data layer: who a `text` or `phone` search found, in scope. */
  match?: OrderSearchMatch;
  from?: string;
  to?: string;
  vendor?: string;
  rider?: string;
  /** Phase 7: one customer's orders (the route checks the customer is in scope). */
  customer?: string;
  statuses?: DbOrderStatus[];
  paymentMethods?: string[];
  paymentStatuses?: string[];
  zone?: string;
  queue?: OrderQueue;
  cursor?: { createdAt: string; id: string };
  limit: number;
}

const DB_STATUSES: readonly DbOrderStatus[] = ["placed", "kitchen", "ready", "on_the_way", "delivered", "cancelled"];
const ALIASES: Record<string, DbOrderStatus[]> = {
  pending: ["placed", "kitchen", "ready", "on_the_way"],
  completed: ["delivered"],
};
const PAYMENT_METHODS = ["cod", "online"];
const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"];
const QUEUES: readonly OrderQueue[] = ["delayed", "unassigned", "cancelled"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(s: string): { createdAt: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let raw: string;
  try {
    raw = Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  const createdAt = raw.slice(0, bar);
  const id = raw.slice(bar + 1);
  if (!isUuid(id) || !ISO.test(createdAt.replace(" ", "T")) || !Number.isFinite(Date.parse(createdAt))) return null;
  return { createdAt, id };
}

const list = (v: string | null) =>
  (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

export const SEARCH_TEXT_MIN = 2;
export const SEARCH_TEXT_MAX = 60;

/**
 * The search text with everything a pattern would read as syntax taken out:
 * `%` and `_` (LIKE), `\` (LIKE's escape: a trailing one is an SQL error), and
 * `*` (PostgREST reads it as `%`, so "*" alone would match every name).
 * The rest reaches the database as one bound value, so commas and brackets are
 * only characters.
 */
export function cleanSearchText(raw: string): string {
  return raw.replace(/[\\%_*\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

/** The box's text → what to look for, or null when it cannot be searched as typed. */
export function parseOrderSearch(rawQ: string): OrderSearch | null {
  // Narrow a copy: isUuid is a type guard, and narrowing rawQ would make the else branch never.
  if (isUuid(String(rawQ))) return { kind: "id", id: rawQ.toLowerCase() };
  const typedAsCode = rawQ.startsWith("#");
  const code = rawQ.replace(/^#/, "").replace(/\s+/g, "");
  if (/^[0-9a-fA-F]{4,8}$/.test(code)) {
    // A word of hex letters alone may be a name as well: "Cafe", "Dada".
    if (typedAsCode || /\d/.test(code)) return { kind: "code", prefix: code.toUpperCase() };
    return { kind: "text", text: code, codePrefix: code.toUpperCase() };
  }
  const phone = phoneE164(rawQ);
  if (phone) return { kind: "phone", phone };
  // Only digits, and neither a code nor a whole phone number: no name looks like that.
  if (/^[+\d\s-]+$/.test(rawQ)) return null;
  const text = cleanSearchText(rawQ);
  if (text.length < SEARCH_TEXT_MIN || text.length > SEARCH_TEXT_MAX) return null;
  return { kind: "text", text };
}

/** Who a `text` or `phone` search found. Ids come from the database, never from the box. */
export interface OrderSearchMatch {
  customerIds: string[];
  shopIds: string[];
}

/**
 * The PostgREST `or` for a search match, or null when nothing can match. Every
 * id is checked so nothing the box held can reach this string as syntax.
 */
export function orderSearchFilter(match: OrderSearchMatch, codePrefix?: string): string | null {
  const customers = match.customerIds.filter((id) => isUuid(id));
  const shops = match.shopIds.filter((id) => isUuid(id));
  const parts: string[] = [];
  if (customers.length) parts.push(`customer_id.in.(${customers.join(",")})`);
  if (shops.length) parts.push(`restaurant_id.in.(${shops.join(",")})`);
  if (codePrefix && /^[0-9A-F]{4,8}$/.test(codePrefix)) parts.push(`short_code.like.${codePrefix}*`);
  return parts.length ? parts.join(",") : null;
}

export function parseOrderQuery(
  params: URLSearchParams,
  now: Date
): { ok: true; query: OrderQuery } | { ok: false; field: string } {
  const query: OrderQuery = { limit: DEFAULT_LIMIT };

  const rawQ = params.get("q")?.trim();
  if (rawQ) {
    const search = parseOrderSearch(rawQ);
    if (!search) return { ok: false, field: "q" };
    query.q = search;
  }

  const statuses = list(params.get("status"));
  if (statuses.length > 0) {
    const out = new Set<DbOrderStatus>();
    for (const s of statuses) {
      if (s === "today") {
        const day = istDayKey(now);
        query.from = istDayStart(day).toISOString();
        query.to = istDayStart(addDays(day, 1)).toISOString();
      } else if (ALIASES[s]) ALIASES[s].forEach((x) => out.add(x));
      else if ((DB_STATUSES as readonly string[]).includes(s)) out.add(s as DbOrderStatus);
      else return { ok: false, field: "status" };
    }
    if (out.size > 0) query.statuses = [...out];
  }

  for (const key of ["from", "to"] as const) {
    const v = params.get(key)?.trim();
    if (!v) continue;
    if (!ISO.test(v) || !Number.isFinite(Date.parse(v))) return { ok: false, field: key };
    query[key] = new Date(v).toISOString();
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) return { ok: false, field: "from" };

  for (const key of ["vendor", "rider", "zone", "customer"] as const) {
    const v = params.get(key)?.trim();
    if (!v) continue;
    if (!isUuid(v)) return { ok: false, field: key };
    query[key] = v.toLowerCase();
  }

  const payment = list(params.get("payment"));
  if (payment.length > 0) {
    const methods = payment.filter((p) => PAYMENT_METHODS.includes(p));
    const pstatuses = payment.filter((p) => PAYMENT_STATUSES.includes(p));
    if (methods.length + pstatuses.length !== payment.length) return { ok: false, field: "payment" };
    if (methods.length) query.paymentMethods = methods;
    if (pstatuses.length) query.paymentStatuses = pstatuses;
  }

  const queue = params.get("queue")?.trim();
  if (queue) {
    if (!(QUEUES as readonly string[]).includes(queue)) return { ok: false, field: "queue" };
    query.queue = queue as OrderQueue;
  }

  const cursor = params.get("cursor")?.trim();
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) return { ok: false, field: "cursor" };
    query.cursor = c;
  }

  const limit = params.get("limit")?.trim();
  if (limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { ok: false, field: "limit" };
    query.limit = n;
  }

  return { ok: true, query };
}
