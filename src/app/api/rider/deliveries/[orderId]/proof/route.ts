import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { uploadDeliveryProof } from "@/lib/data-access/rider-delivery-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 5 MB of photo plus the multipart envelope; anything larger is refused unread. */
const MAX_BODY_BYTES = 5 * 1024 * 1024 + 64 * 1024;

/**
 * POST /api/rider/deliveries/:orderId/proof   multipart/form-data { file }
 *
 * The proof-of-delivery photo for the delivery the rider is carrying (status
 * `picked_up`). JPEG or PNG, at most 5 MB, checked by its bytes. Stored in the
 * private `delivery-proofs` bucket at a path the server builds
 * (`<deliveryId>/<uuid>.<ext>`) and recorded on the delivery; the app then
 * sends that `path` as `photoPath` with its `deliver` step.
 *
 *   200 { ok: true, path }
 *   400 invalid_order | invalid_body | bad_type | too_large
 *   404 not_found           not this rider's delivery
 *   409 bad_state           not at picked_up (not collected yet, or finished)
 *   503 migration_pending   no `pod_photo_path` column or bucket (0082)
 *
 * Rate limit: 12 a minute per rider — a retake or two, never a stream of 5 MB
 * writes into storage.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-proof:${profile.id}`, 12, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "invalid_order" }, { status: 400 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "too_large" }, { status: 400 });

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!(file instanceof File)) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const result = await uploadDeliveryProof(profile.id, orderId, file);
    if (!result.ok) {
      if (result.error === "not_yours") {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const status = result.error === "bad_state" ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ ok: true, path: result.path });
  } catch (e) {
    return riderRouteError(e, {
      route: "/api/rider/deliveries/[orderId]/proof",
      method: "POST",
      riderId: profile.id,
      event: "proof_upload",
    });
  }
}
