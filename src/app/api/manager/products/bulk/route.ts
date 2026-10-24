import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { exportManagerSheet, managerShop, runManagerStockSheet } from "@/lib/data-access/bulk-menu";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { formatOf, readSheetUpload, sheetResponse } from "@/lib/bulk/upload";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/products/bulk?vendor=<shop id>&format=csv|xlsx — one shop's
 * dishes with their current stock, as a sheet to fill in and send back.
 * → the file   → 404 not_found (not a shop in the manager's zones)
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;

  const vendor = new URL(request.url).searchParams.get("vendor");
  if (!isUuid(vendor)) return NextResponse.json({ error: "bad_request", field: "vendor" }, { status: 400 });
  try {
    if (!(await managerShop(ctx.scope, vendor.toLowerCase()))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return sheetResponse(await exportManagerSheet(vendor.toLowerCase(), formatOf(request.url)));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/manager/products/bulk — multipart: `file` (.csv or .xlsx), `vendor`
 * (the shop's id) and `mode` (preview | apply). A manager's sheet changes
 * stock counts only (price, availability and new dishes are the shop's), each
 * through the same audited step as the stock button, refused if the count moved
 * since the sheet was made. Preview needs manager.products.view; apply needs
 * manager.products.adjust_stock. Up to 200 dishes; 10 uploads a minute.
 *
 * → 200 { mode, counts, items, moreItems, issues, columns, unknownColumns,
 *         ignoredColumns, applied? }
 * → 400 bad_request   → 403 permission_denied   → 404 not_found   → 413   → 429
 */
export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "product-bulk", 10);
  if (limited) return limited;

  const upload = await readSheetUpload(request);
  if (upload instanceof Response) return upload;

  const vendor = upload.fields.vendor;
  if (!isUuid(vendor)) return NextResponse.json({ error: "bad_request", field: "vendor" }, { status: 400 });

  const canAdjust = ctx.permissions["manager.products.adjust_stock"] === true;
  if (upload.mode === "apply" && !canAdjust) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.products.adjust_stock" }, { status: 403 });
  }

  try {
    if (!(await managerShop(ctx.scope, vendor.toLowerCase()))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
    const result = await runManagerStockSheet({
      actor,
      scope: ctx.scope,
      restaurantId: vendor.toLowerCase(),
      bytes: upload.bytes,
      filename: upload.filename,
      mode: upload.mode,
      canAdjust,
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
