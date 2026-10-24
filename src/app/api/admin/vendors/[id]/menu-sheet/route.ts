import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isUuid } from "@/lib/auth/manager-scope";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { exportOwnerSheet, runOwnerSheet } from "@/lib/data-access/bulk-menu";
import { formatOf, readSheetUpload, sheetResponse } from "@/lib/bulk/upload";

export const dynamic = "force-dynamic";

async function guard(id: string): Promise<Response | null> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return null;
}

/**
 * GET /api/admin/vendors/[id]/menu-sheet?format=csv|xlsx[&template=1] — the
 * shop's menu as a sheet to edit and send back, or an empty template. Admin only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const refused = await guard(id);
  if (refused) return refused;
  try {
    const template = new URL(request.url).searchParams.get("template") === "1";
    return sheetResponse(await exportOwnerSheet(await createClient(), id, formatOf(request.url), template));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/admin/vendors/[id]/menu-sheet — multipart `file` and `mode`
 * (preview | apply); the same answer as the vendor's /api/vendor/menu/bulk.
 * A route handler, not a server action, so it isn't held to the 1 MB action
 * body limit. Admin only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const refused = await guard(id);
  if (refused) return refused;

  const upload = await readSheetUpload(request);
  if (upload instanceof Response) return upload;

  try {
    const result = await runOwnerSheet({ db: await createClient(), restaurantId: id, bytes: upload.bytes, filename: upload.filename, mode: upload.mode });
    if (upload.mode === "apply") {
      revalidatePath(`/admin/vendors/${id}`);
      revalidatePath("/", "layout");
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
