import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { getVendorPace, setVendorBusy } from "@/lib/data-access/vendor-restaurant";

/**
 * POST /api/vendor/store/busy — { minutes: 0..120, forMinutes?: 1..360 }:
 * add that many minutes to every quote for the next `forMinutes` (default
 * 60). `minutes: 0` ends it now. → 200 { ok, pace }.
 */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext("vendor.busy_mode", "vendor-store");
  if (ctx instanceof Response) return ctx;

  const body = (await readJsonBody(request)) as { minutes?: unknown; forMinutes?: unknown } | null;
  const int = (v: unknown, min: number, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  if (!body || !int(body.minutes, 0, 120)) return badRequest("invalid_minutes");
  if (body.forMinutes !== undefined && !int(body.forMinutes, 1, 360)) return badRequest("invalid_for_minutes");

  try {
    await setVendorBusy({ minutes: body.minutes as number, forMinutes: body.forMinutes as number | undefined });
    return NextResponse.json({ ok: true, pace: await getVendorPace(ctx.restaurant.id) });
  } catch (e) {
    return vendorWriteError(e);
  }
}
