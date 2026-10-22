import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";

/** The private bucket the rider's proof photos go to (0082). */
const PROOF_BUCKET = "delivery-proofs";
/** `deliveries.pod_photo_path` arrives with 0082 — the key rider-delivery-actions uses too. */
const POD_PHOTO_COLUMN = "deliveries.pod_photo_path";
/** `deliveries.pod_photo_removed_at` (0082, ruling P8-R4): the 90-day retention stamp. */
const POD_REMOVED_COLUMN = "deliveries.pod_photo_removed_at";

/** What the customer and ops are shown once the retention sweep deleted the photo. */
export const PHOTO_REMOVED_TEXT = "Photo removed after 90 days";
/** How long the customer's link to the photo works. */
export const PROOF_URL_TTL_SECONDS = 600;

/**
 * Whether `path` is inside this delivery's own folder - the shape
 * `uploadDeliveryProof` writes - so a corrupted row can never make the bucket
 * serve another delivery's file.
 */
export function isOwnProofPath(deliveryId: string, path: string | null | undefined): path is string {
  return Boolean(path) && (path as string).startsWith(`${deliveryId}/`);
}

export type ProofResult =
  | { ok: true; url: string; expiresIn: number }
  | { ok: false; error: "forbidden" | "no_photo" | "photo_removed" | "migration_pending" };

interface DeliveryPhotoRow {
  id: string;
  pod_photo_path: string | null;
  pod_photo_removed_at?: string | null;
}

/**
 * The photo recorded for an order's delivery, or null. A database without 0082
 * has no column and therefore no photo, which is "none", not an error.
 */
async function readPhotoRow(
  admin: ReturnType<typeof createAdminClient>,
  orderId: string
): Promise<DeliveryPhotoRow | null> {
  if (columnKnownMissing(POD_PHOTO_COLUMN)) return null;
  const read = (withRemoved: boolean) =>
    admin
      .from("deliveries")
      .select(withRemoved ? "id, pod_photo_path, pod_photo_removed_at" : "id, pod_photo_path")
      .eq("order_id", orderId)
      .maybeSingle()
      .overrideTypes<DeliveryPhotoRow>();
  const withRemoved = !columnKnownMissing(POD_REMOVED_COLUMN);
  let { data, error } = await read(withRemoved);
  if (error && withRemoved && isMissingColumn(error)) {
    // 0082 from before the retention stamp: read the photo alone. A photo the
    // retention sweep removed then reads as "no photo" (null path, no stamp)
    // rather than "removed after 90 days" — acceptable: no link to a deleted
    // file is ever signed, and the wording returns with the stamp column.
    rememberColumn(POD_REMOVED_COLUMN, false);
    ({ data, error } = await read(false));
  }
  if (error) {
    if (isMissingColumn(error)) {
      rememberColumn(POD_PHOTO_COLUMN, false);
      return null;
    }
    throw error;
  }
  rememberColumn(POD_PHOTO_COLUMN, true);
  return data ?? null;
}

/**
 * A short-lived signed URL for the proof-of-delivery photo of `orderId`, for
 * the customer who placed it and nobody else.
 *
 * Authorization is decided here, above the service-role reads: the order's
 * `customer_id` must be `userId`. Someone else's order and an order that does
 * not exist answer the same `forbidden`, so the route is no oracle for which
 * ids exist. The path is signed only if it sits under this delivery's own
 * folder — the shape `uploadDeliveryProof` writes — so a corrupted row can never
 * make the bucket serve another delivery's file.
 *
 * Throws on an unexpected database or storage failure (the route answers 500).
 */
export async function getCustomerProofUrl(
  orderId: string,
  userId: string
): Promise<ProofResult> {
  const admin = createAdminClient();

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id, customer_id")
    .eq("id", orderId)
    .maybeSingle()
    .overrideTypes<{ id: string; customer_id: string | null }>();
  if (orderError) throw orderError;
  if (!order || !order.customer_id || order.customer_id !== userId) {
    return { ok: false, error: "forbidden" };
  }

  const row = await readPhotoRow(admin, orderId);
  const path = row?.pod_photo_path;
  if (row && !path && row.pod_photo_removed_at) {
    return { ok: false, error: "photo_removed" };
  }
  if (!row || !isOwnProofPath(row.id, path)) {
    return { ok: false, error: "no_photo" };
  }

  const { data, error } = await admin.storage
    .from(PROOF_BUCKET)
    .createSignedUrl(path, PROOF_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    if (error && /bucket not found/i.test(error.message)) {
      return { ok: false, error: "migration_pending" };
    }
    if (error && /object not found|not found/i.test(error.message)) {
      return { ok: false, error: "no_photo" };
    }
    throw error ?? new Error("proof_sign_failed");
  }
  return { ok: true, url: data.signedUrl, expiresIn: PROOF_URL_TTL_SECONDS };
}

/**
 * A 10-minute signed link to a delivery's proof photo for the rider who
 * delivered it, or null (no photo, a path outside the delivery's folder, or a
 * storage failure - the photo is an extra, never a reason to fail the screen).
 * Authorization is the caller's: only call this for a delivery the signed-in
 * rider delivered.
 */
export async function signDeliveryProofUrl(
  admin: ReturnType<typeof createAdminClient>,
  deliveryId: string,
  path: string | null | undefined
): Promise<string | null> {
  if (!isOwnProofPath(deliveryId, path)) return null;
  const { data, error } = await admin.storage.from(PROOF_BUCKET).createSignedUrl(path, PROOF_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
