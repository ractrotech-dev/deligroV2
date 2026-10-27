import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { exportManagerMenuSheet, managerShop, runManagerMenuSheet } from "@/lib/data-access/bulk-menu";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { formatOf, readSheetUpload, sheetResponse } from "@/lib/bulk/upload";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/vendors/[id]/menu-sheet?format=csv|xlsx[&template=1] — the
 * shop's whole menu as a sheet to edit and send back (or an empty template).
 * Stock columns only with manager.products.adjust_stock.
 * → the file   → 404 not_found (not a shop in the manager's zones)
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const template = new URL(request.url).searchParams.get("template") === "1";
  try {
    if (!(await managerShop(ctx.scope, id.toLowerCase()))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const canAdjustStock = ctx.permissions["manager.products.adjust_stock"] === true;
    return sheetResponse(await exportManagerMenuSheet(id.toLowerCase(), formatOf(request.url), template, canAdjustStock));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/manager/vendors/[id]/menu-sheet — multipart: `file` (.csv or
 * .xlsx), `mode` (preview | apply) and `clientActionId` (a uuid, kept across
 * retries of one apply). Adds and changes dishes, live at once except what the
 * restricted-category rules hold for approval. Preview needs
 * manager.products.view; apply needs manager.products.bulk_menu. Stock columns
 * are read only with manager.products.adjust_stock (else listed in
 * ignoredColumns). Up to 500 rows; 10 uploads a minute.
 *
 * → 200 { mode, counts, items, moreItems, issues, columns, unknownColumns,
 *         ignoredColumns, applied? }
 * → 400 bad_request   → 403 permission_denied   → 404 not_found   → 413   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const limited = await managerWriteLimit(ctx, "menu-sheet", 10);
  if (limited) return limited;

  const upload = await readSheetUpload(request);
  if (upload instanceof Response) return upload;

  const clientActionId = upload.fields.clientActionId;
  if (upload.mode === "apply" && !isUuid(clientActionId)) {
    return NextResponse.json({ error: "bad_request", field: "clientActionId" }, { status: 400 });
  }
  if (upload.mode === "apply" && ctx.permissions["manager.products.bulk_menu"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.products.bulk_menu" }, { status: 403 });
  }

  try {
    if (!(await managerShop(ctx.scope, id.toLowerCase()))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
    const result = await runManagerMenuSheet({
      actor,
      scope: ctx.scope,
      restaurantId: id.toLowerCase(),
      bytes: upload.bytes,
      filename: upload.filename,
      mode: upload.mode,
      canAdjustStock: ctx.permissions["manager.products.adjust_stock"] === true,
      clientActionId: (clientActionId ?? "").toLowerCase(),
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
