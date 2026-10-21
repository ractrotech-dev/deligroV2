import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { addHoliday } from "@/lib/data-access/vendor-store";
import { parseHoliday } from "@/lib/vendor/store-input";

/**
 * POST /api/vendor/store/holidays — { startsOn, endsOn: "YYYY-MM-DD",
 * note? } (IST dates, inclusive). The shop takes no orders on those days.
 * → 201 { holiday }; 400 `in_the_past`; 409 `too_many_holidays` |
 * `needs_migration`.
 */
export async function POST(request: Request) {
  // Holidays are opening and closing on a calendar.
  const ctx = await vendorWriteContext("vendor.open_toggle", "vendor-store");
  if (ctx instanceof Response) return ctx;

  const input = parseHoliday(await readJsonBody(request));
  if ("error" in input) return badRequest(input.error);

  try {
    const holiday = await addHoliday(ctx.restaurant.id, input);
    return NextResponse.json({ holiday }, { status: 201 });
  } catch (e) {
    return vendorWriteError(e);
  }
}
