import { NextResponse } from "next/server";
import {
  managerApiContext,
  managerWriteLimit,
  readJsonObject,
} from "@/lib/auth/manager-api.server";
import { OPS_ALERT_KINDS, isOpsAlertKind } from "@/lib/ops-alerts/kinds";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * The signed-in person's push switches, one per alert kind (§15.7),
 * stored server-side (notification_preferences, migration 0141) so the alert
 * engine honours them whichever device is signed in. No row = on.
 *
 * GET → { prefs: { [kind]: boolean } }   (every kind present)
 * PUT { kind, push } → { ok: true }
 */
export async function GET() {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;

  const { data, error } = await createAdminClient()
    .from("notification_preferences")
    .select("kind, push")
    .eq("user_id", ctx.profile.id);
  if (error) return NextResponse.json({ error: "load_failed" }, { status: 500 });

  const stored = new Map(((data ?? []) as { kind: string; push: boolean }[]).map((r) => [r.kind, r.push]));
  return NextResponse.json({
    prefs: Object.fromEntries(OPS_ALERT_KINDS.map((k) => [k.kind, stored.get(k.kind) ?? true])),
  });
}

export async function PUT(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "notif-prefs", 60);
  if (limited) return limited;

  const body = await readJsonObject(request);
  if (!body || !isOpsAlertKind(body.kind) || typeof body.push !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { error } = await createAdminClient()
    .from("notification_preferences")
    .upsert(
      { user_id: ctx.profile.id, kind: body.kind, push: body.push, updated_at: new Date().toISOString() },
      { onConflict: "user_id,kind" }
    );
  if (error) return NextResponse.json({ error: "save_failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
