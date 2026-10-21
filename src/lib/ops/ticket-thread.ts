import { toTicketSummary, type TicketRow, type TicketSummary } from "@/lib/ops/vendor-contract";

/**
 * The ticket-thread answer (`GET /api/manager/tickets/[id]`), built from rows
 * so the route and the contract check run the same code.
 */
export interface TicketThread {
  ticket: TicketSummary & {
    restaurant: { id: string; name: string } | null;
    zoneId: string | null;
    escalationLevel: number;
    resolution: string | null;
    firstResponseAt: string | null;
    resolvedAt: string | null;
  };
  messages: {
    id: string;
    author: { id: string; name: string; role: string };
    body: string;
    internal: boolean;
    attachments: { name: string; url: string }[];
    at: string;
  }[];
}

type One<T> = T | T[] | null;
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export type ThreadRow = TicketRow & {
  requester_id: string;
  restaurant_id: string | null;
  zone_id: string | null;
  escalation_level: number | null;
  resolution: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  restaurants: One<{ name: string | null }>;
};

export interface ThreadMessageRow {
  id: string;
  author_id: string;
  author_role: string;
  body: string;
  internal: boolean;
  attachments: string[] | null;
  created_at: string;
  profiles: One<{ full_name: string | null }>;
}

/** [urls] maps an attachment's storage path to its short-lived signed URL; unsigned paths are left out. */
export function buildTicketThread(t: ThreadRow, rows: ThreadMessageRow[], urls: Map<string, string>): TicketThread {
  const shop = one(t.restaurants);
  return {
    ticket: {
      ...toTicketSummary(t),
      restaurant: t.restaurant_id ? { id: t.restaurant_id, name: shop?.name?.trim() || "Shop" } : null,
      zoneId: t.zone_id,
      escalationLevel: t.escalation_level ?? 0,
      resolution: t.resolution,
      firstResponseAt: t.first_response_at,
      resolvedAt: t.resolved_at,
    },
    messages: rows.map((m) => ({
      id: m.id,
      author: { id: m.author_id, name: one(m.profiles)?.full_name?.trim() || "User", role: m.author_role },
      body: m.body,
      internal: m.internal === true,
      attachments: (m.attachments ?? [])
        .filter((p) => urls.has(p))
        .map((p) => ({ name: p.split("/").pop() ?? "attachment", url: urls.get(p)! })),
      at: m.created_at,
    })),
  };
}
