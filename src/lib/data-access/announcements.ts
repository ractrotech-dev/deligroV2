import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { rateLimit } from "@/lib/rate-limit";
import { notifyUsers, type NotificationRole } from "@/lib/notifications/notify-user";
import type { AnnouncementAudience, AnnouncementInput } from "@/lib/support/rules";

/**
 * Announcements (`announcements`, 0064 / 0087): an admin's message to every
 * rider, shop or manager (or all of them), pinned at the top of their inbox
 * while it runs. English only.
 *
 * Publishing one that starts now (with "push" ticked) also fans out through
 * `notifyUsers` — category `announcements`, so each person gets an inbox row
 * and riders who muted announcements get no push. A scheduled one with
 * "push" ticked is fanned out by the dispatch sweep once its start has passed
 * (`pushStartedAnnouncements`) — exactly once, by a per-announcement latch in
 * the shared rate-limit store (`announcement-push:<id>`), so the shared table
 * needs no "pushed" column. Publishing without "push" claims that latch at
 * once, for longer than the announcement can be waiting, so the sweep never
 * pushes it either.
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

/** How long a fan-out latch holds once claimed: far beyond the sweep's look-back. */
const PUSH_LATCH_MS = 30 * 24 * 60 * 60_000;
/** The sweep only fans out announcements that started this recently. */
const SWEEP_LOOKBACK_MS = 24 * 60 * 60_000;
/** A publish counts as "starting now" up to this far ahead. */
const STARTS_NOW_MS = 60_000;

/** First caller wins; true when this caller may fan the announcement out. */
async function claimFanOut(id: string, windowMs = PUSH_LATCH_MS): Promise<boolean> {
  return (await rateLimit(`announcement-push:${id}`, 1, Math.max(windowMs, 60_000))).ok;
}

/** Inbox row + push for everyone in the audience, one fan-out per role. Returns how many people. */
async function fanOut(a: { id: string; audience: AnnouncementAudience; title: string; body: string }): Promise<number> {
  const people = await audiencePeople(a.audience);
  const body = a.body.length > 180 ? `${a.body.slice(0, 177)}…` : a.body;
  // One fan-out per role, so each role's tap opens its own app's inbox.
  for (const role of ["rider", "vendor", "manager"] as const) {
    const group = people.filter((p) => p.role === role);
    if (group.length === 0) continue;
    await notifyUsers(group, {
      category: "announcements",
      title: a.title,
      body,
      url: INBOX_URL[role],
      data: { announcementId: a.id },
    });
  }
  return people.length;
}

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
  const startMs = input.startsAt ? Date.parse(input.startsAt) : Date.now();
  const startsNow = startMs <= Date.now() + STARTS_NOW_MS;
  if (!input.push) {
    // Never pushed: hold the sweep's latch until well after it could look.
    await claimFanOut(data.id, startMs - Date.now() + PUSH_LATCH_MS);
    return { id: data.id, reached: 0 };
  }
  // Scheduled: the sweep fans it out once its start has passed.
  if (!startsNow) return { id: data.id, reached: 0 };
  if (!(await claimFanOut(data.id))) return { id: data.id, reached: 0 };
  return { id: data.id, reached: await fanOut({ id: data.id, audience: input.audience, title: input.title, body: input.body }) };
}

/**
 * The dispatch sweep's step: announcements whose start has passed in the last
 * day and whose end has not, fanned out once each (inbox + push). Returns how
 * many announcements were sent. Ended ones are never sent.
 */
export async function pushStartedAnnouncements(now = Date.now()): Promise<number> {
  const at = new Date(now).toISOString();
  const { data, error } = await createAdminClient()
    .from("announcements")
    .select("id, audience, title, body, starts_at, ends_at, created_at")
    .lte("starts_at", at)
    .gt("starts_at", new Date(now - SWEEP_LOOKBACK_MS).toISOString())
    .order("starts_at", { ascending: true })
    .limit(20)
    .overrideTypes<Row[]>();
  if (error || !data?.length) return 0;
  let sent = 0;
  for (const a of data) {
    if (a.ends_at && a.ends_at <= at) continue;
    if (!(await claimFanOut(a.id))) continue;
    await fanOut({ id: a.id, audience: a.audience, title: a.title, body: a.body });
    sent++;
  }
  return sent;
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
