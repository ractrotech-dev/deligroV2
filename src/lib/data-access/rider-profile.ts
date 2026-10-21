import "server-only";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertRealType } from "@/lib/utils/file-signature";
import { maskNumber } from "@/lib/ops/rider-rules";
import { RIDER_DOC_MAX_BYTES, RIDER_DOC_MIME, validateRiderDocFields } from "@/lib/ops/rider-actions";
import type { RiderDocType } from "@/lib/ops/rider-contract";

/**
 * Rider documents in the private `rider-documents` bucket — the Rider plan's
 * `rider-profile.ts` document functions (rider phase 6), created here first for
 * the Manager app with the Rider plan's signatures. The Rider app's own upload
 * route and the manager's audited upload (manager-rider-actions.ts) share the
 * file checks and storage layout below, so a document is stored one way.
 *
 * Service role. Callers authorise first: the rider's own session for
 * `uploadRiderDocument` / `riderDocumentUrl`; managerApiContext + the rider
 * scope for the manager path.
 */

const BUCKET = "rider-documents";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

export type UploadError = "bad_type" | "too_large" | "invalid_number" | "expiry_required";

/**
 * Check the file (declared type, real bytes, size) and put it at
 * `<driverId>/<type>-<random>.<ext>`. Nothing from the client shapes the path.
 */
export async function storeRiderDocumentFile(
  driverId: string,
  type: RiderDocType,
  file: File
): Promise<{ ok: true; path: string } | { ok: false; error: "bad_type" | "too_large" }> {
  if (!UUID.test(driverId)) return { ok: false, error: "bad_type" };
  if (!(RIDER_DOC_MIME as readonly string[]).includes(file.type)) return { ok: false, error: "bad_type" };
  if (file.size > RIDER_DOC_MAX_BYTES) return { ok: false, error: "too_large" };
  try {
    await assertRealType(file, RIDER_DOC_MIME);
  } catch {
    return { ok: false, error: "bad_type" };
  }
  const path = `${driverId.toLowerCase()}/${type}-${randomBytes(6).toString("hex")}.${EXT[file.type]}`;
  const { error } = await createAdminClient().storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return { ok: true, path };
}

/** Remove a stored file whose row could not be recorded. */
export async function removeRiderDocumentFile(path: string): Promise<void> {
  await createAdminClient().storage.from(BUCKET).remove([path]).catch(() => {});
}

/**
 * The rider's own upload (Rider app): the document is pending until ops review
 * it; a previous one of the same type is marked replaced.
 */
export async function uploadRiderDocument(
  driverId: string,
  input: { type: string; number?: string; expiresOn?: string; file: File }
): Promise<{ ok: true; id: string } | { ok: false; error: UploadError }> {
  const fields = validateRiderDocFields(input.type, input.number ?? null, input.expiresOn ?? null);
  if (!fields.ok) return fields;
  const stored = await storeRiderDocumentFile(driverId, fields.type, input.file);
  if (!stored.ok) return stored;
  const supabase = createAdminClient();
  try {
    const { error: replaceErr } = await supabase
      .from("rider_documents")
      .update({ status: "replaced" })
      .eq("driver_id", driverId)
      .eq("doc_type", fields.type)
      .neq("status", "replaced");
    if (replaceErr) throw replaceErr;
    const { data, error } = await supabase
      .from("rider_documents")
      .insert({
        driver_id: driverId,
        doc_type: fields.type,
        number: fields.number,
        number_masked: maskNumber(fields.number),
        file_path: stored.path,
        expires_on: fields.expiresOn,
        status: "pending",
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return { ok: true, id: data.id };
  } catch (e) {
    await removeRiderDocumentFile(stored.path);
    throw e;
  }
}

/** A 10-minute signed link to one of the rider's own documents, or null. */
export async function riderDocumentUrl(driverId: string, docId: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("rider_documents")
    .select("file_path")
    .eq("id", docId)
    .eq("driver_id", driverId)
    .maybeSingle<{ file_path: string }>();
  if (error) throw error;
  if (!data) return null;
  const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(data.file_path, 600);
  return signed?.signedUrl ?? null;
}
