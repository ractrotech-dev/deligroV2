import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertRealType } from "@/lib/utils/file-signature";

/**
 * A dish photo a manager uploads to replace a wrong one. It goes into the
 * shop's folder of the public `menu-images` bucket (0009: path
 * `<restaurant id>/<file>`), named `ops-…` so it is clear Deligro put it there.
 * The service-role client writes it (the route is already gated), so the bytes
 * are checked against the claimed type before anything becomes world-readable.
 */

const BUCKET = "menu-images";
/** The bucket's own limit (0009). */
export const MAX_MENU_PHOTO_BYTES = 2 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function uploadMenuPhoto(restaurantId: string, file: File): Promise<string> {
  const ext = TYPES[file.type];
  if (!ext || file.size === 0) throw new Error("invalid_type");
  if (file.size > MAX_MENU_PHOTO_BYTES) throw new Error("too_large");
  await assertRealType(file, ["image/jpeg", "image/png", "image/webp"]);

  const admin = createAdminClient();
  const path = `${restaurantId}/ops-${randomUUID()}.${ext}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}
