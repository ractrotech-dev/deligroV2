import { NextResponse } from "next/server";
import { vendorApiContext, vendorWriteContext } from "@/lib/auth/vendor-api.server";
import { exportOwnerSheet, runOwnerSheet } from "@/lib/data-access/bulk-menu";
import { formatOf, readSheetUpload, sheetResponse } from "@/lib/bulk/upload";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/menu/bulk?format=csv|xlsx[&template=1] — the shop's menu as a
 * sheet to edit (ids, prices, stock...) and send back, or an empty template.
 * → the file.
 */
export async function GET(request: Request) {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-menu-read:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    const template = new URL(request.url).searchParams.get("template") === "1";
    return sheetResponse(await exportOwnerSheet(await createClient(), ctx.restaurant.id, formatOf(request.url), template));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/vendor/menu/bulk — multipart: `file` (.csv or .xlsx, up to 2 MB and
 * 500 rows) and `mode`. `preview` says what the sheet would add and change;
 * `apply` does it. Only the columns the sheet has are applied; a blank cell
 * leaves the dish as it is. Needs the shop's menu-import switch.
 *
 * → 200 { mode, counts: {create, update, unchanged, error}, items, moreItems,
 *         issues, columns, unknownColumns, ignoredColumns, applied? }
 * → 400 bad_request   → 413 file_too_large   → 403 feature_off   → 429
 */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext("vendor.menu_import", "vendor-menu");
  if (ctx instanceof Response) return ctx;

  const upload = await readSheetUpload(request);
  if (upload instanceof Response) return upload;

  try {
    const result = await runOwnerSheet({
      db: await createClient(),
      restaurantId: ctx.restaurant.id,
      bytes: upload.bytes,
      filename: upload.filename,
      mode: upload.mode,
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
