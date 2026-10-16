import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formString } from "@/lib/utils/form-data";
import {
  addVendorDocument,
  type VendorDocType,
} from "@/lib/data-access/vendor-documents";

/**
 * Upload a legal document for a vendor.
 *   POST multipart/form-data { file, docType } → store in the private bucket
 *
 * A route handler (not a server action) so it isn't bound by the 1 MB action
 * body limit — certificates can be larger. Admin-gated; the storage path is
 * derived server-side from the restaurant id, never trusted from the client.
 */

const DOC_TYPES = new Set<VendorDocType>([
  "fssai",
  "gst",
  "pan",
  "bank_proof",
  "shop_license",
  "other",
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const profile = await requireRole("admin");
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  const { id: restaurantId } = await params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const file = form.get("file");
  const docTypeRaw = formString(form, "docType", "other");
  const docType: VendorDocType = DOC_TYPES.has(docTypeRaw as VendorDocType)
    ? (docTypeRaw as VendorDocType)
    : "other";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    await addVendorDocument(restaurantId, docType, file, profile.id);
    revalidatePath(`/admin/vendors/${restaurantId}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "server_error";
    if (message === "invalid_type" || message === "too_large") {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
