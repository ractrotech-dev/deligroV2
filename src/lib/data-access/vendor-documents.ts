import "server-only";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertRealType } from "@/lib/utils/file-signature";

/**
 * Vendor legal documents (migration 0019). The bucket is private, so every
 * operation runs through the service-role client and reads are handed out as
 * short-lived signed URLs. The calling API route / action re-gates the admin.
 */

const BUCKET = "vendor-docs";
const SIGNED_URL_TTL = 60 * 60; // 1 hour

export type VendorDocType =
  | "fssai"
  | "gst"
  | "pan"
  | "bank_proof"
  | "shop_license"
  | "other";

export interface VendorDocument {
  id: string;
  docType: VendorDocType;
  fileName: string;
  url: string | null;
  createdAt: string;
}

interface DocRow {
  id: string;
  doc_type: VendorDocType;
  storage_path: string;
  file_name: string;
  created_at: string;
}

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** Extension for the storage key. */
function extFor(mime: string, fileName: string): string {
  const fromName = fileName.includes(".") ? fileName.split(".").pop()! : "";
  // The filename is attacker-controlled. Accept it only when it is plainly a
  // bare extension — anything with a slash, dot or other punctuation is
  // discarded in favour of the (already byte-verified) MIME type, so nothing
  // from the client can shape the storage path.
  if (/^[a-z0-9]{2,5}$/i.test(fromName)) return fromName.toLowerCase();
  return mime === "application/pdf" ? "pdf" : mime.split("/")[1] || "bin";
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listVendorDocuments(
  restaurantId: string
): Promise<VendorDocument[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("vendor_documents")
    .select("id, doc_type, storage_path, file_name, created_at")
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false });
  if (error) {
    const code = (error as { code?: string }).code ?? "";
    if (code === "42P01" || code === "PGRST205") return [];
    throw error;
  }

  const rows = (data ?? []) as DocRow[];
  const signed = await Promise.all(
    rows.map((r) =>
      admin.storage
        .from(BUCKET)
        .createSignedUrl(r.storage_path, SIGNED_URL_TTL)
        .then((res) => res.data?.signedUrl ?? null)
        .catch(() => null)
    )
  );

  return rows.map((r, i) => ({
    id: r.id,
    docType: r.doc_type,
    fileName: r.file_name,
    url: signed[i],
    createdAt: r.created_at,
  }));
}

/**
 * Check a document upload (claimed type, size, and the real bytes) and put it
 * in the private bucket. Returns the storage path. Throws `invalid_type` or
 * `too_large`. The caller records the row (and removes the object if that fails).
 */
export async function storeVendorDocumentFile(
  restaurantId: string,
  docType: VendorDocType,
  file: File
): Promise<string> {
  if (!ALLOWED_MIME.has(file.type)) throw new Error("invalid_type");
  if (file.size > MAX_BYTES) throw new Error("too_large");

  // restaurantId comes straight off the route param and is the first path
  // segment of the storage key; pin it to a UUID so it can't shape the path.
  if (!UUID_RE.test(restaurantId)) throw new Error("invalid_type");

  // ALLOWED_MIME only checks what the client claimed. Check the bytes.
  await assertRealType(file, [
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ]);

  const admin = createAdminClient();
  const key = randomBytes(6).toString("hex");
  const path = `${restaurantId}/${docType}-${key}.${extFor(file.type, file.name)}`;

  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (upErr) throw upErr;
  return path;
}

/** Remove an uploaded object whose row could not be recorded. */
export async function removeVendorDocumentFile(path: string): Promise<void> {
  await createAdminClient().storage.from(BUCKET).remove([path]).catch(() => {});
}

/** A short-lived signed URL for a stored document, or null if signing failed. */
export async function signedDocumentUrl(path: string, seconds: number): Promise<string | null> {
  const { data } = await createAdminClient().storage.from(BUCKET).createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}

export async function addVendorDocument(
  restaurantId: string,
  docType: VendorDocType,
  file: File,
  uploadedBy: string
): Promise<void> {
  const path = await storeVendorDocumentFile(restaurantId, docType, file);
  const { error: rowErr } = await createAdminClient().from("vendor_documents").insert({
    restaurant_id: restaurantId,
    doc_type: docType,
    storage_path: path,
    file_name: file.name.slice(0, 200),
    uploaded_by: uploadedBy,
  });
  if (rowErr) {
    // Don't leave an orphaned object if the row insert fails.
    await removeVendorDocumentFile(path);
    throw rowErr;
  }
}

export async function deleteVendorDocument(id: string): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("vendor_documents")
    .select("storage_path")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  const path = (data as { storage_path: string } | null)?.storage_path;

  const { error: delErr } = await admin
    .from("vendor_documents")
    .delete()
    .eq("id", id);
  if (delErr) throw delErr;

  if (path) await admin.storage.from(BUCKET).remove([path]).catch(() => {});
}
