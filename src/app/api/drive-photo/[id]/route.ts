import { NextResponse } from "next/server";
import { requireVendorAccess } from "@/lib/auth/vendor-access";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { drivePhotoPreview } from "@/lib/data-access/google-drive";

/**
 * A small preview of one Drive photo for the image picker, through our own address so
 * the owner's Google token stays on the server. Admins and shops, the two who use the
 * picker. `drivePhotoPreview` refuses anything outside the owner's chosen folder.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireVendorAccess();
  const limit = await rateLimit(`drive-preview:${access.id}`, 240, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  const image = await drivePhotoPreview(id).catch(() => null);
  if (!image) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return new NextResponse(image.bytes, {
    headers: {
      "content-type": image.type,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
    },
  });
}
