import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";

/**
 * The in-app inbox (`user_notifications`, 0064 / 0087): every push a person
 * was sent — and every one they muted — as a row they can read again.
 *
 * Service-role reads, filtered by the session's user id (the rider routes
 * derive it behind `requireRiderApi()`; nothing in a request names a user).
 * RLS gives the same answer to a direct read: own rows only, `read_at` the
 * only writable column.
 *
 * Before 0087 the inbox is empty and `available` is false — a read degrades,
 * it does not fail. Marking read on a missing table marks nothing.
 *
 * Announcements live in `announcements.ts`. The Partner app keeps both in one
 * `user-notifications.ts` (feat/vendor-app); merge deliberately.
 */

export interface InboxItem {
  id: string;
  category: string;
  title: string;
  body: string;
  /** `url` (the app route a tap opens), `orderId`, `ticketId`, … */
  data: Record<string, unknown>;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface Inbox {
  available: boolean;
  items: InboxItem[];
  unread: number;
  hasMore: boolean;
  /** Pass back as `before` for the next page; null on the last. */
  nextBefore: string | null;
}

interface Row {
  id: string;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

const MAX_PAGE = 100;

export async function getInbox(userId: string, opts: { before?: string | null; limit?: number } = {}): Promise<Inbox> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 30), 1), MAX_PAGE);
  const supabase = createAdminClient();
  let q = supabase
    .from("user_notifications")
    .select("id, category, title, body, data, read_at, created_at")
    .eq("user_id", userId);
  if (opts.before) q = q.lt("created_at", opts.before);
  const [page, unread] = await Promise.all([
    q.order("created_at", { ascending: false }).limit(limit + 1).overrideTypes<Row[]>(),
    supabase
      .from("user_notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null),
  ]);
  if (page.error) {
    if (isMissingTable(page.error)) return { available: false, items: [], unread: 0, hasMore: false, nextBefore: null };
    throw page.error;
  }
  const rows = page.data ?? [];
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    category: r.category,
    title: r.title,
    body: r.body,
    data: r.data ?? {},
    read: r.read_at !== null,
    readAt: r.read_at,
    createdAt: r.created_at,
  }));
  const hasMore = rows.length > limit;
  return {
    available: true,
    items,
    unread: unread.count ?? 0,
    hasMore,
    nextBefore: hasMore ? (items[items.length - 1]?.createdAt ?? null) : null,
  };
}

/** Mark some (or all) of the user's unread notifications read. Returns how many changed. */
export async function markRead(userId: string, ids: string[] | "all"): Promise<number> {
  if (ids !== "all" && ids.length === 0) return 0;
  let q = createAdminClient()
    .from("user_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null);
  if (ids !== "all") q = q.in("id", ids);
  const { data, error } = await q.select("id");
  if (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  return data?.length ?? 0;
}
