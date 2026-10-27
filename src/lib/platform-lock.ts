import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { lockBlocksConsole, type PlatformLock, type PlatformLockLevel } from "@/lib/platform-lock-rules";

export type { PlatformLock, PlatformLockLevel };
export { lockBlocksConsole };

/**
 * The developer's platform lock (0177), read once per request.
 *
 * Fails open: a database without 0177, or a read that fails, is "off". The lock
 * already holds in the database (ordering off, an order insert guard); this
 * read only decides whether the Admin console and the Manager app show the
 * paused screen, and an outage must not lock the business out of its tools.
 */
export const getPlatformLock = cache(async (): Promise<PlatformLock> => {
  if (!isSupabaseConfigured) return { level: "off", message: "" };
  try {
    const { data, error } = await createAdminClient()
      .from("platform_settings")
      .select("dev_lock_level, dev_lock_message, dev_lock_at")
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return { level: "off", message: "" };
    const row = data as { dev_lock_level: string | null; dev_lock_message: string | null; dev_lock_at: string | null };
    const level: PlatformLockLevel = row.dev_lock_level === "orders" || row.dev_lock_level === "full" ? row.dev_lock_level : "off";
    return { level, message: row.dev_lock_message ?? "", since: row.dev_lock_at };
  } catch {
    return { level: "off", message: "" };
  }
});

export interface PlatformLockEvent {
  level: PlatformLockLevel;
  message: string;
  actor: string | null;
  at: string;
}

/** The last changes, newest first, for the Developer panel. */
export async function listPlatformLockEvents(limit = 20): Promise<PlatformLockEvent[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("platform_lock_events")
    .select("level, message, created_at, actor_id")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) return [];
  const rows = (data ?? []) as { level: PlatformLockLevel; message: string; created_at: string; actor_id: string | null }[];
  const ids = [...new Set(rows.map((r) => r.actor_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: people } = await db.from("profiles").select("id, full_name").in("id", ids);
    for (const p of (people ?? []) as { id: string; full_name: string | null }[]) names.set(p.id, p.full_name?.trim() || "Developer");
  }
  return rows.map((r) => ({ level: r.level, message: r.message, actor: r.actor_id ? names.get(r.actor_id) ?? "Developer" : null, at: r.created_at }));
}

/** The developer's switch (0177's set_platform_lock). The caller has checked requireRole("developer"). */
export async function setPlatformLock(actorId: string, level: PlatformLockLevel, message: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await createAdminClient().rpc("set_platform_lock", { p_actor: actorId, p_level: level, p_message: message });
  if (!error) return { ok: true };
  const msg = (error.message ?? "").trim();
  if (msg.includes("set_platform_lock") || error.code === "PGRST202") return { ok: false, error: "Migration 0177 is not applied yet." };
  if (msg === "forbidden") return { ok: false, error: "Only a developer account can change this." };
  return { ok: false, error: "Could not change the lock. Try again." };
}
