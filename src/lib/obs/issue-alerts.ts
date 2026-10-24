import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Pushes "new error" and "came back after being fixed" alerts to every
 * developer (OBSERVABILITY_V2.md, phase 4). The alerts themselves are queued by
 * a trigger on obs_issues (0170), one per issue, never one per event; this only
 * takes the unsent production ones and sends them.
 *
 * Called after an ingest that carried an error. Never throws: an alert that
 * could not be sent stays in the console's list either way.
 */
export async function sendIssueAlerts(): Promise<number> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("obs_take_alerts", { p_limit: 20 });
    if (error || !Array.isArray(data) || data.length === 0) return 0;
    const alerts = data as { short_id: string; title: string; reason: "new" | "regressed" }[];

    const { data: devs } = await supabase.from("profiles").select("id").eq("role", "developer").limit(50);
    const ids = ((devs ?? []) as { id: string }[]).map((d) => d.id);
    if (ids.length === 0) return 0;

    const { sendPush } = await import("@/lib/notifications/onesignal");
    let sent = 0;
    for (const a of alerts) {
      const heading = a.reason === "new" ? `New error (${a.short_id})` : `Came back after being fixed (${a.short_id})`;
      const ok = await sendPush({ userIds: ids }, heading, a.title.slice(0, 180), {
        url: `/developer/observability/issues/${a.short_id}`,
        collapseId: `obs-${a.short_id}`,
      });
      if (ok) sent += 1;
    }
    return sent;
  } catch {
    return 0;
  }
}
