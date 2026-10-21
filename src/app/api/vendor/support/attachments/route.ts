import { NextResponse } from "next/server";
import { readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { attachmentUploadUrl } from "@/lib/data-access/support";

/**
 * POST /api/vendor/support/attachments — { type: "jpg" | "png" } → { path,
 * url, token }: a one-time signed upload URL for a photo in the caller's own
 * folder of the private `support-attachments` bucket (5 MB, jpeg/png, enforced
 * by the bucket). Cite `path` in a ticket or message afterwards.
 */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext(null, "vendor-support");
  if (ctx instanceof Response) return ctx;
  const body = (await readJsonBody(request)) as { type?: unknown } | null;
  const ext = body?.type === "png" ? "png" : body?.type === "jpg" || body?.type === "jpeg" ? "jpg" : null;
  if (!ext) return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  try {
    return NextResponse.json(await attachmentUploadUrl(ctx.profile.id, ext));
  } catch (e) {
    return vendorWriteError(e);
  }
}
