import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { notifyUsers, type NotificationRole } from "@/lib/notifications/notify-user";
import type { AnnouncementAudience, AnnouncementInput } from "@/lib/support/rules";

/**
 * Announcements (`announcements`, 0064 / 0087): an admin's message to every
 * rider, shop or manager (or all of them), pinned at the top of their inbox
 * while it runs. English only.
 *
 * Publishing one that starts now (with "push" ticked) also fans out through
 * `notifyUsers` — category `announcements`, so each person gets an inbox row
 * and riders who muted announcements get no push. A scheduled one is not
 * pushed; it simply appears pinned from its start time.
 *
 * Service role. `listLiveAnnouncements` serves `/api/rider/announcements`
 * behind `requireRiderApi()`; the rest serve the admin composer behind
 * `requireRole("admin")`.
 */

export interface Announcement {
  id: string;
  audience: AnnouncementAudience;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
}

export interface AdminAnnouncement extends Announcement {
  createdAt: string;
  state: "live" | "scheduled" | "ended";
}

interface Row {
  id: string;
  audience: AnnouncementAudience;
  title: string;
  body: string;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
}

const map = (a: Row): Announcement => ({
  id: a.id,
  audience: a.audience,
  title: a.title,
  body: a.body,
  startsAt: a.starts_at,
  endsAt: a.ends_at,
});

/** What one audience sees right now: its own announcements and the `all` ones. */
export async function listLiveAnnouncements(
  audience: Exclude<AnnouncementAudience, "all">,
  now = Date.now()
): Promise<Announcement[]> {
  const at = new Date(now).toISOString();
  const { data, error } = await createAdminClient()
    .from("announcements")
    .select("id, audience, title, body, starts_at, ends_at, created_at")
    .in("audience", [audience, "all"])
    .lte("starts_at", at)
    .order("starts_at", { ascending: false })
    .limit(50)
    .overrideTypes<Row[]>();
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []).filter((a) => !a.ends_at || a.ends_at > at).map(map);
}

/** Every announcement, newest first, with its state — the admin list. */
export async function listAnnouncements(now = Date.now()): Promise<AdminAnnouncement[]> {
  const { data, error } = await createAdminClient()
    .from("announcements")
    .select("id, audience, title, body, starts_at, ends_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100)
    .overrideTypes<Row[]>();
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []).map((a) => ({
    ...map(a),
    createdAt: a.created_at,
    state: Date.parse(a.starts_at) > now ? "scheduled" : a.ends_at && Date.parse(a.ends_at) <= now ? "ended" : "live",
  }));
}

/** Who an announcement reaches: riders, shop owners, managers. */
async function audiencePeople(audience: AnnouncementAudience): Promise<{ userId: string; role: NotificationRole }[]> {
  const supabase = createAdminClient();
  const out = new Map<string, NotificationRole>();
  if (audience === "vendor" || audience === "all") {
    const { data } = await supabase.from("restaurants").select("owner_id").not("owner_id", "is", null).limit(5000);
    for (const r of (data ?? []) as { owner_id: string }[]) out.set(r.owner_id, "vendor");
  }
  for (const [aud, role, as] of [
    ["rider", "driver", "rider"],
    ["manager", "manager", "manager"],
  ] as const) {
    if (audience === aud || audience === "all") {
      const { data } = await supabase.from("profiles").select("id").eq("role", role).limit(5000);
      for (const p of (data ?? []) as { id: string }[]) if (!out.has(p.id)) out.set(p.id, as);
    }
  }
  return [...out].map(([userId, role]) => ({ userId, role }));
}

const INBOX_URL: Record<string, string> = { rider: "/notifications", vendor: "/more/notifications", manager: "/notifications" };

/** Publish; when it starts now and `push` is set, fan out to the audience. */
export async function createAnnouncement(
  adminId: string,
  input: AnnouncementInput
): Promise<{ id: string; reached: number }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
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
    .single()
    .overrideTypes<{ id: string }>();
  if (error) throw error;
  const startsNow = !input.startsAt || Date.parse(input.startsAt) <= Date.now() + 60_000;
  if (!startsNow || !input.push) return { id: data.id, reached: 0 };

  const people = await audiencePeople(input.audience);
  const body = input.body.length > 180 ? `${input.body.slice(0, 177)}…` : input.body;
  // One fan-out per role, so each role's tap opens its own app's inbox.
  for (const role of ["rider", "vendor", "manager"] as const) {
    const group = people.filter((p) => p.role === role);
    if (group.length === 0) continue;
    await notifyUsers(group, {
      category: "announcements",
      title: input.title,
      body,
      url: INBOX_URL[role],
      data: { announcementId: data.id },
    });
  }
  return { id: data.id, reached: people.length };
}

/**
 * End one now. A live one gets `ends_at = now` (its history stays); a
 * scheduled one never ran, so it is withdrawn (deleted) — `ends_at` may not
 * come before `starts_at` (0064's check).
 */
export async function endAnnouncement(id: string): Promise<void> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("announcements")
    .select("id, starts_at, ends_at")
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<{ id: string; starts_at: string; ends_at: string | null }>();
  if (error) throw error;
  if (!data) return;
  const now = new Date().toISOString();
  if (data.ends_at && data.ends_at <= now) return;
  const { error: writeError } =
    data.starts_at > now
      ? await supabase.from("announcements").delete().eq("id", id)
      : await supabase.from("announcements").update({ ends_at: now }).eq("id", id);
  if (writeError) throw writeError;
}
