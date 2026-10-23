/**
 * `GET /api/manager/orders` query parameters → a validated `OrderQuery`, and
 * the keyset cursor. Pure. A bad parameter is named (`field`) so the route can
 * answer 400 `bad_request` with it.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { addDays, istDayKey, istDayStart } from "@/lib/metrics/ist";
import type { DbOrderStatus } from "./order-contract";

export type OrderQueue = "delayed" | "unassigned" | "cancelled";

export interface OrderQuery {
  q?: { kind: "id"; id: string } | { kind: "code"; prefix: string };
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

export function parseOrderQuery(
  params: URLSearchParams,
  now: Date
): { ok: true; query: OrderQuery } | { ok: false; field: string } {
  const query: OrderQuery = { limit: DEFAULT_LIMIT };

  const rawQ = params.get("q")?.trim();
  if (rawQ) {
    // Narrow a copy: isUuid is a type guard, and narrowing rawQ would make the else branch never.
    if (isUuid(String(rawQ))) query.q = { kind: "id", id: rawQ.toLowerCase() };
    else {
      const code = rawQ.replace(/^#/, "").replace(/\s+/g, "");
      if (!/^[0-9a-fA-F]{4,8}$/.test(code)) return { ok: false, field: "q" };
      query.q = { kind: "code", prefix: code.toUpperCase() };
    }
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
