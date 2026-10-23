import { readFormLimited } from "@/lib/http/limited-body";
import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { uploadRiderDocumentAsOps } from "@/lib/data-access/manager-rider-actions";
import { RIDER_DOC_MAX_BYTES } from "@/lib/ops/rider-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/riders/[id]/documents — upload one of a rider's documents
 * (§5.2), multipart: `type` (aadhaar | pan | driving_licence | vehicle_rc |
 * insurance | puc | photo), `number?`, `expiresOn?` (YYYY-MM-DD; required for
 * driving_licence, insurance, puc), `clientActionId`, `file` (PDF, JPEG or PNG,
 * ≤ 10 MB — the bytes are checked, not just the declared type). The file goes
 * to the private rider-documents bucket; the row (pending review, replacing an
 * earlier one of the same type) and its audit row are one RPC (0151).
 *
 * Needs manager.riders.onboard. 60 writes a minute per manager. A body larger
 * than the limit is refused from Content-Length before it is read.
 *
 * → 201 { document: RiderDocument }   → 400 bad_type | too_large | invalid_number | expiry_required | bad_request
 * → 403 permission_denied   → 404 not_found
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.riders.onboard");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "rider-writes");
  if (limited) return limited;

  const { id: rawId } = await params;
  if (!isUuid(rawId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Multipart overhead is small; the limit holds while the body streams in.
  const read = await readFormLimited(request, RIDER_DOC_MAX_BYTES + 64 * 1024);
  if (read === "too_large") return NextResponse.json({ error: "too_large" }, { status: 400 });
  if (read === "bad") return NextResponse.json({ error: "bad_request", field: "body" }, { status: 400 });
  const form = read;
  const file = form.get("file");
  const type = form.get("type");
  const clientActionId = form.get("clientActionId");
  if (!(file instanceof File)) return NextResponse.json({ error: "bad_request", field: "file" }, { status: 400 });
  if (typeof type !== "string") return NextResponse.json({ error: "bad_type" }, { status: 400 });
  if (typeof clientActionId !== "string" || !isUuid(clientActionId)) {
    return NextResponse.json({ error: "bad_request", field: "clientActionId" }, { status: 400 });
  }
  const text = (v: FormDataEntryValue | null) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

  try {
    const result = await uploadRiderDocumentAsOps(ctx, rawId.toLowerCase(), {
      type,
      number: text(form.get("number")),
      expiresOn: text(form.get("expiresOn")),
      file,
      clientActionId,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ document: result.document }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
