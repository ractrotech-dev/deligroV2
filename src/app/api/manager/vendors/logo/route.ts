import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { uploadVendorLogo } from "@/lib/data-access/vendor-logo";
import { uploadTooLarge } from "@/lib/ops/vendor-actions";

export const dynamic = "force-dynamic";

const LOGO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/manager/vendors/logo — multipart `file` (jpeg/png/webp ≤ 5 MB, the
 * bytes checked against the claimed type): a shop logo uploaded before the
 * shop exists, as the admin registration wizard does (§4.2). The returned
 * URL goes into the onboarding body as `logoUrl`. manager.vendors.onboard.
 *
 * → 201 { logoUrl }   → 400 { error: "bad_file" | "bad_request", field? }
 * → 403 permission_denied   → 429   → 500 action_failed
 */
export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.vendors.onboard");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "vendor-logo", 20);
  if (limited) return limited;

  if (uploadTooLarge(request.headers.get("content-length"), LOGO_MAX_BYTES)) {
    return NextResponse.json({ error: "bad_file" }, { status: 400 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad_request", field: "body" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "bad_request", field: "file" }, { status: 400 });

  try {
    return NextResponse.json({ logoUrl: await uploadVendorLogo(file) }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message === "invalid_type" || message === "too_large") {
      return NextResponse.json({ error: "bad_file" }, { status: 400 });
    }
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
