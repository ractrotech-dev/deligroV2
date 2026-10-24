import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth/cron";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { sweepDispatch } from "@/lib/dispatch/sweep";
import { withCronObservability } from "@/lib/obs/cron";

/**
 * Scheduled dispatch sweep — see lib/dispatch/sweep.ts for what it does.
 *
 * Authenticated by `CRON_SECRET`, sent as `Authorization: Bearer <secret>`,
 * which is the header Vercel Cron attaches on its own. Fails closed: with no
 * secret configured the route refuses everyone (AGENTS.md rule 2) rather than
 * becoming a public "push every admin" button.
 *
 * Scheduling it is optional. The vendor and rider boards already trigger a
 * throttled sweep after their polls (`maybeSweepDispatch`), so this matters
 * for the hours when no board is open. Every-minute schedules need Vercel Pro
 * (Hobby allows daily only — a per-minute entry fails the deployment), which
 * is why no `vercel.json` entry ships with it. Alternatives: Supabase
 * `pg_cron` + `pg_net`, or any external pinger hitting this URL each minute.
 *
 * The answer carries every part's count, including `proofPhotosRemoved`: the
 * 90-day proof-photo retention (`lib/data-access/proof-retention.ts`, ruling
 * P8-R4), which the sweep runs at most once an hour, 100 photos at a time.
 * Even a daily schedule of this route keeps the retention rule.
 */

export const dynamic = "force-dynamic";

async function sweep(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!isSupabaseConfigured) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }
  const result = await sweepDispatch();
  return NextResponse.json(
    { ok: true, ...result },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export const GET = withCronObservability("dispatch-sweep", sweep);
