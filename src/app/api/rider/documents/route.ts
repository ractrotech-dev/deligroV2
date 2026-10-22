import { profileJson, profileRouteError, riderProfileGate } from "@/lib/auth/rider-profile-route";
import { listRiderDocuments, uploadRiderDocument } from "@/lib/data-access/rider-profile";
import { DOC_MAX_BYTES } from "@/lib/rider/profile-rules";

const ROUTE = "/api/rider/documents";
/** 10 MB of file plus the multipart envelope; a larger request is refused unread. */
const MAX_BODY_BYTES = DOC_MAX_BYTES + 64 * 1024;

/**
 * GET /api/rider/documents — the rider's live documents (replaced ones are
 * history and not listed), newest first. Numbers are masked.
 *
 *   200 { documents: { id, type, numberMasked, expiresOn, daysLeft, status, remarks, uploadedAt }[] }
 *   401 · 403 not_rider · 429 · 503 migration_pending · 500
 */
export async function GET() {
  const gate = await riderProfileGate(ROUTE, { write: false, perMinute: 30 });
  if (!gate.ok) return gate.response;
  try {
    return profileJson({ documents: await listRiderDocuments(gate.driverId) });
  } catch (e) {
    return profileRouteError(e, ROUTE, "GET", gate.driverId);
  }
}

const field = (form: FormData, key: string): string | undefined => {
  const v = form.get(key);
  return typeof v === "string" ? v : undefined;
};

/**
 * POST /api/rider/documents   multipart/form-data { type, number?, expiresOn?, file }
 *
 * Upload (or replace) one document: PDF, JPEG or PNG, at most 10 MB, checked
 * by its bytes. Stored in the private `rider-documents` bucket at a path the
 * server builds; the previous document of that type becomes history; the
 * rider's verification goes to `pending`. An Aadhaar number is kept as its
 * last four digits only.
 *
 *   201 { ok: true, id }
 *   400 invalid_body | bad_type | too_large | invalid_number | expiry_required | invalid_expiry
 *   411 length_required        no Content-Length: the size must be known before reading
 *   401 · 403 not_rider | feature_disabled · 429 · 503 migration_pending · 500
 *
 * `number` is required for aadhaar (12 digits), pan and driving_licence;
 * `expiresOn` (YYYY-MM-DD, today or later) for driving_licence, insurance and
 * puc. Rate limit: 10 a minute per rider.
 */
export async function POST(request: Request) {
  const gate = await riderProfileGate(ROUTE, { write: true, perMinute: 10 });
  if (!gate.ok) return gate.response;

  const length = request.headers.get("content-length");
  if (length === null || !/^\d+$/.test(length)) return profileJson({ error: "length_required" }, 411);
  if (Number(length) > MAX_BODY_BYTES) return profileJson({ error: "too_large" }, 400);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return profileJson({ error: "invalid_body" }, 400);
  }
  const file = form.get("file");
  const type = field(form, "type");
  if (!(file instanceof File) || type === undefined) return profileJson({ error: "invalid_body" }, 400);

  try {
    const result = await uploadRiderDocument(gate.driverId, {
      type,
      number: field(form, "number"),
      expiresOn: field(form, "expiresOn"),
      file,
    });
    if (!result.ok) return profileJson({ error: result.error }, 400);
    return profileJson({ ok: true, id: result.id }, 201);
  } catch (e) {
    return profileRouteError(e, ROUTE, "POST", gate.driverId);
  }
}
