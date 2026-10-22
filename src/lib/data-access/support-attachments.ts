import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertRealType } from "@/lib/utils/file-signature";
import { RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import { checkAttachments, type AttachmentError } from "@/lib/support/rules";

/**
 * Photos on support tickets and SOS reports: the private `support-attachments`
 * bucket (0064 / 0087 — 5 MB, JPEG/PNG, no storage policies).
 *
 * Every path is built here — `<uploader id>/<uuid>.<jpg|png>` — never taken
 * from a client (SECURITY_AUDIT §4). Every file is checked by its declared
 * type and size (`checkAttachments`) AND by its first bytes
 * (`assertRealType`) before ANY of them is uploaded, so a refused set leaves
 * nothing behind. Reading is only ever through a 10-minute signed URL, minted
 * by a caller that has already checked the ticket is the reader's (or the
 * reader is staff).
 */

export const SUPPORT_BUCKET = "support-attachments";
export const SIGNED_URL_SECONDS = 600;

type AdminClient = ReturnType<typeof createAdminClient>;

/** Declared type, size and magic bytes of every file; null when all pass. */
export async function validateAttachments(files: readonly File[]): Promise<AttachmentError | null> {
  const declared = checkAttachments(files);
  if (declared) return declared;
  for (const f of files) {
    try {
      await assertRealType(f, ["image/jpeg", "image/png"]);
    } catch {
      return "bad_photo_type";
    }
  }
  return null;
}

/** The bucket is missing: 0064/0087 not applied. */
function bucketMissing(error: { message?: string; statusCode?: string | number } | null): boolean {
  return /bucket not found/i.test(error?.message ?? "");
}

/**
 * Upload already-validated files to the uploader's folder. All or nothing:
 * a failure part-way removes what was uploaded and throws.
 */
export async function uploadAttachments(uploaderId: string, files: readonly File[], client?: AdminClient): Promise<string[]> {
  if (files.length === 0) return [];
  const storage = (client ?? createAdminClient()).storage.from(SUPPORT_BUCKET);
  const paths: string[] = [];
  try {
    for (const f of files) {
      const ext = f.type === "image/png" ? "png" : "jpg";
      const path = `${uploaderId}/${randomUUID()}.${ext}`;
      const { error } = await storage.upload(path, f, { contentType: f.type, upsert: false });
      if (error) {
        if (bucketMissing(error)) throw new RiderSchemaPendingError("migration_pending: support-attachments bucket (0087) is not created");
        throw error;
      }
      paths.push(path);
    }
    return paths;
  } catch (e) {
    await removeAttachments(paths, client);
    throw e;
  }
}

/** Best-effort clean-up of uploads whose ticket was never written. */
export async function removeAttachments(paths: readonly string[], client?: AdminClient): Promise<void> {
  if (paths.length === 0) return;
  try {
    await (client ?? createAdminClient()).storage.from(SUPPORT_BUCKET).remove([...paths]);
  } catch {
    // an orphaned private object is harmless; the ticket write is what failed
  }
}

/** 10-minute signed URLs for paths the caller is entitled to see. Unsignable -> null. */
export async function signAttachments(paths: readonly string[], client?: AdminClient): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) return out;
  try {
    const { data } = await (client ?? createAdminClient()).storage
      .from(SUPPORT_BUCKET)
      .createSignedUrls([...paths], SIGNED_URL_SECONDS);
    for (const d of data ?? []) out.set(d.path ?? "", d.signedUrl ?? null);
  } catch {
    // shown as "photo unavailable"
  }
  return out;
}
