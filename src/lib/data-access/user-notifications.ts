import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { notifyUser, type NotificationRole } from "@/lib/notifications/notify-user";

/**
 * The in-app inbox and announcements (requirements §13, 0064). The inbox is
 * read and marked read with the user's own client (RLS: own rows; only
 * `read_at` is updatable). Announcements are read the same way (RLS: live, and
 * for the reader's audience); admins create them with the service role.
 */
export interface InboxItem {
  id: string;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface Announcement {
  id: string;
  audience: string;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
}

export interface Inbox {
  available: boolean;
  items: InboxItem[];
  unread: number;
  announcements: Announcement[];
  hasMore: boolean;
}

export async function getInbox(userId: string, opts: { before?: string; limit?: number } = {}): Promise<Inbox> {
  const supabase = await createClient();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  let q = supabase
    .from("user_notifications")
    .select("id, category, title, body, data, read_at, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (opts.before) q = q.lt("created_at", opts.before);
  const [items, unread, ann] = await Promise.all([
    q,
    supabase.from("user_notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null),
    supabase.from("announcements").select("id, audience, title, body, starts_at, ends_at").order("starts_at", { ascending: false }).limit(10),
  ]);
  if (items.error) {
    if (isMissingTable(items.error)) return { available: false, items: [], unread: 0, announcements: [], hasMore: false };
    throw items.error;
  }
  const rows = items.data ?? [];
  return {
    available: true,
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      body: r.body,
      data: (r.data as Record<string, unknown>) ?? {},
      read: r.read_at !== null,
      createdAt: r.created_at,
    })),
    unread: unread.count ?? 0,
    announcements: (ann.data ?? []).map((a) => ({
      id: a.id,
      audience: a.audience,
      title: a.title,
      body: a.body,
      startsAt: a.starts_at,
      endsAt: a.ends_at,
    })),
    hasMore: rows.length > limit,
  };
}

/** Mark some (or all) of the user's notifications read. */
export async function markRead(userId: string, ids: string[] | "all"): Promise<number> {
  const supabase = await createClient();
  let q = supabase.from("user_notifications").update({ read_at: new Date().toISOString() }).eq("user_id", userId).is("read_at", null);
  if (ids !== "all") q = q.in("id", ids);
  const { data, error } = await q.select("id");
  if (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  return data?.length ?? 0;
}

// ---- Admin ----

export async function listAnnouncements(): Promise<(Announcement & { createdAt: string; state: "live" | "scheduled" | "ended" })[]> {
  const now = Date.now();
  const { data, error } = await createAdminClient()
    .from("announcements")
    .select("id, audience, title, body, starts_at, ends_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []).map((a) => ({
    id: a.id,
    audience: a.audience,
    title: a.title,
    body: a.body,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    createdAt: a.created_at,
    state:
      Date.parse(a.starts_at) > now ? "scheduled" : a.ends_at && Date.parse(a.ends_at) <= now ? "ended" : "live",
  }));
}

const AUDIENCE_ROLE: Record<string, NotificationRole> = { vendor: "vendor", rider: "rider", manager: "manager" };

/** Who an announcement reaches: shop owners, drivers, managers. */
async function audienceUserIds(audience: string): Promise<{ id: string; role: NotificationRole }[]> {
  const admin = createAdminClient();
  const out = new Map<string, NotificationRole>();
  if (audience === "vendor" || audience === "all") {
    const { data } = await admin.from("restaurants").select("owner_id").not("owner_id", "is", null);
    for (const r of data ?? []) out.set(r.owner_id as string, "vendor");
  }
  for (const [aud, role] of [["rider", "driver"], ["manager", "manager"]] as const) {
    if (audience === aud || audience === "all") {
      const { data } = await admin.from("profiles").select("id").eq("role", role).limit(5000);
      for (const p of data ?? []) if (!out.has(p.id)) out.set(p.id, AUDIENCE_ROLE[aud]);
    }
  }
  return [...out].map(([id, role]) => ({ id, role }));
}

/**
 * Publish an announcement. When it starts now (and `push`), every person in
 * the audience also gets an inbox entry and a push; a scheduled one shows in
 * the inbox's pinned list from its start time.
 */
export async function createAnnouncement(
  adminId: string,
  input: { audience: string; title: string; body: string; startsAt: string | null; endsAt: string | null; push: boolean }
): Promise<{ id: string; reached: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("announcements")
    .insert({
      audience: input.audience,
      title: input.title,
      body: input.body,
      starts_at: input.startsAt ?? new Date().toISOString(),
      ends_at: input.endsAt,
      created_by: adminId,
    })
    .select("id")
    .single();
  if (error) throw error;
  const startsNow = !input.startsAt || Date.parse(input.startsAt) <= Date.now() + 60_000;
  if (!startsNow || !input.push) return { id: data.id, reached: 0 };
  const people = await audienceUserIds(input.audience);
  // Batches of 20 at a time: each is an insert and a push.
  for (let i = 0; i < people.length; i += 20) {
    await Promise.all(
      people.slice(i, i + 20).map((p) =>
        notifyUser({
          userId: p.id,
          role: p.role,
          category: "announcements",
          title: input.title,
          body: input.body.length > 180 ? `${input.body.slice(0, 177)}…` : input.body,
          url: p.role === "vendor" ? "/more/notifications" : "/notifications",
          data: { announcementId: data.id },
        })
      )
    );
  }
  return { id: data.id, reached: people.length };
}

export async function endAnnouncement(id: string): Promise<void> {
  await createAdminClient().from("announcements").update({ ends_at: new Date().toISOString() }).eq("id", id);
}
