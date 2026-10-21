import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { setRestaurantOpen } from "@/lib/data-access/vendor-restaurant";
import { getVendorStore } from "@/lib/data-access/vendor-store";

/**
 * POST /api/vendor/store/open — { open: true } opens (and ends any timed
 * closing); { open: false } closes until reopened; { open: false,
 * closeForMinutes: 5..1440 } closes for that long and reopens by itself
 * (needs 0062; 409 `needs_migration` before). → 200 { ok, store }.
 */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext("vendor.open_toggle", "vendor-store");
  if (ctx instanceof Response) return ctx;

  const body = (await readJsonBody(request)) as { open?: unknown; closeForMinutes?: unknown } | null;
  if (!body || typeof body.open !== "boolean") return badRequest("invalid_open");
  const minutes = body.closeForMinutes;
  if (minutes !== undefined && minutes !== null) {
    if (body.open || typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
      return badRequest("invalid_close_for");
    }
  }

  try {
    await setRestaurantOpen(body.open, typeof minutes === "number" ? minutes : undefined);
    return NextResponse.json({ ok: true, store: await getVendorStore(ctx.restaurant) });
  } catch (e) {
    return vendorWriteError(e);
  }
}
