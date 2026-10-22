import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth/cron";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { sendDocumentExpiryReminders } from "@/lib/data-access/rider-profile";

/**
 * Daily: push riders whose documents expire in 30, 7 or 1 days, or have
 * expired (each stage once), and mark expired documents `expired` so the admin
 * Riders list flags them. See `sendDocumentExpiryReminders`.
 *
 * Authenticated by `CRON_SECRET` (`cronAuthorized`, fails closed). Once a day
 * is enough and fits Vercel Hobby's daily-only cron; no `vercel.json` entry
 * ships with it (scheduling is the owner's step, as for the dispatch sweep).
 *
 *   200 { ok: true, sent }
 *   401 unauthorized · 503 not_configured | migration_pending (no 0086) · 500
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!isSupabaseConfigured) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }
  try {
    const sent = await sendDocumentExpiryReminders();
    return NextResponse.json({ ok: true, sent }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const pending = isRiderSchemaPending(e);
    if (!pending) captureError(e, { source: "/api/cron/rider-documents", attrs: { event: "reminders_failed" } });
    return NextResponse.json(
      { ok: false, error: pending ? "migration_pending" : "server_error" },
      { status: pending ? 503 : 500 }
    );
  }
}
