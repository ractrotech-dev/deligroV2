import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { listRidersForManager } from "@/lib/data-access/manager-riders";
import { onboardRider } from "@/lib/data-access/manager-rider-actions";
import { parseRiderQuery } from "@/lib/ops/rider-contract";
import { parseOnboardRiderBody } from "@/lib/ops/rider-actions";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/riders — every rider who shares one of the manager's zones
 * (§5.1), with live state (§5.4–§5.6), by name, keyset-paged.
 *
 * Query: q (name, rider ID, or 4+ phone digits), state (comma list of
 * online | available | on_delivery | break | stale | offline), verification,
 * account, zone, filter (needs_review | expiring), cursor, limit (1–100, 50).
 *
 * → 200 { items: RiderListItem[], nextCursor, counts }
 * → 400 { error: "bad_request", field }   → 500 { error: "load_failed" }
 * Contract: docs/superpowers/plans/2026-10-21-manager-app-phase-5-riders.md.
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.riders.view");
  if (ctx instanceof Response) return ctx;

  const parsed = parseRiderQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  try {
    return NextResponse.json(await listRidersForManager(ctx.scope, parsed.query, new Date()));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/manager/riders — onboard a rider into one of the manager's zones
 * (§5.2). Creates the login, then the pending rider (role, zone, profile) and
 * its audit row in one RPC (0151). Body: the plan's onboarding fields; a
 * password is generated when none is given and returned once in `credentials`.
 * Without an email the login uses the phone-only account address, so a rider
 * who later orders food uses the same account.
 *
 * Needs manager.riders.onboard. 10 an hour per manager.
 * → 201 { riderId, riderCode, credentials }   → 400 { error: "bad_request", field }
 * → 403 permission_denied   → 404 not_found (zone out of scope)
 * → 409 phone_taken | email_taken | stale
 */
export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.riders.onboard");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "rider-writes");
  if (limited) return limited;
  const hourly = await rateLimit(`rider-onboard:${ctx.profile.id}`, 10, 3_600_000);
  if (!hourly.ok) return tooManyRequests(hourly);

  const parsed = parseOnboardRiderBody(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  try {
    const result = await onboardRider(ctx, parsed.input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(
      { riderId: result.riderId, riderCode: result.riderCode, credentials: result.credentials },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
