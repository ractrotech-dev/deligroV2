import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertRealType } from "@/lib/utils/file-signature";
import {
  autoMatch,
  keywordsFor,
  rankCandidates,
  searchLibrary,
  tokenize,
  vegFromTokens,
  type MatchCandidate,
} from "@/lib/images/match";
import { drivePhotoFile, listDrivePhotos, type DrivePhoto } from "@/lib/data-access/google-drive";

/**
 * The central food photo library.
 *
 * Reads are public — the customer app renders these photos, and RLS says so.
 * Writes go through the service-role client, which every caller here backs with
 * a `requireRole("admin")` in the action or route above it (AGENTS.md §5).
 *
 * The interesting decision is where the matching happens. Candidates are
 * narrowed in Postgres with a GIN-indexed array overlap on `keywords` — cheap,
 * selective, and it returns the whole "biryani family" in one hop — and then
 * RANKED in TypeScript by `@/lib/images/match`, because the decisive rule is a
 * conflict (chicken must never match veg) and that is not something a
 * similarity operator can express. See that module for why this beats an
 * embedding on the actual requirement.
 */

export interface FoodImage extends MatchCandidate {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string;
  storagePath: string | null;
  keywords: string[];
  tags: string[];
  veg: boolean | null;
  createdAt: string;
  /** Set while the photo is only in the owner's Drive: picking it brings it in. */
  driveFileId?: string;
}

const BUCKET = "food-library";
const MAX_BYTES = 2 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const SELECT =
  "id, title, description, image_url, storage_path, keywords, tags, veg, created_at";

interface Row {
  id: string;
  title: string;
  description: string | null;
  image_url: string;
  storage_path: string | null;
  keywords: string[] | null;
  tags: string[] | null;
  veg: boolean | null;
  created_at: string;
}

function map(row: Row): FoodImage {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    storagePath: row.storage_path,
    // Fall back to deriving them: a row written before the keywords column was
    // populated should still be findable rather than silently invisible.
    keywords: row.keywords?.length ? row.keywords : keywordsFor(row.title),
    tags: row.tags ?? [],
    veg: row.veg,
    createdAt: row.created_at,
  };
}

/** Table missing (0035 not applied) — every read degrades to empty. */
function isMissingTable(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  );
}

/** Is migration 0035 applied? Drives the "run migration" notice. */
export async function foodImagesReady(): Promise<boolean> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("food_images")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  return !error;
}

/**
 * Photos whose keywords overlap this dish name at all.
 *
 * `overlaps` (the `&&` array operator) rather than a text LIKE: it uses the GIN
 * index, and it returns the family — every biryani for "Chicken Biryani" — so
 * the ranking step has the alternatives it needs to refuse the wrong ones and
 * the picker has something to offer.
 */
async function candidatesFor(dishName: string): Promise<FoodImage[]> {
  const tokens = tokenize(dishName);
  if (tokens.length === 0) return [];

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("food_images")
    .select(SELECT)
    .overlaps("keywords", tokens)
    .limit(60);

  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map(map);
}

/** A Drive photo as the picker shows it. It joins the library only once it is picked. */
function driveCandidate(photo: DrivePhoto): FoodImage {
  const keywords = keywordsFor(photo.title);
  return {
    id: `drive:${photo.id}`,
    driveFileId: photo.id,
    title: photo.title,
    description: null,
    imageUrl: `/api/drive-photo/${photo.id}`,
    storagePath: null,
    keywords,
    tags: [],
    veg: vegFromTokens(keywords),
    createdAt: "",
  };
}

async function libraryPhotoTitled(title: string): Promise<FoodImage | null> {
  const { data, error } = await createAdminClient()
    .from("food_images")
    .select(SELECT)
    .ilike("title", title.replace(/[\\%_]/g, (c) => `\\${c}`))
    .limit(1);
  if (error) throw error;
  return data?.[0] ? map(data[0] as Row) : null;
}

/**
 * Copies one photo out of the owner's Drive folder, so customers load it from our own
 * storage. Drive stays the source: nothing else is copied, and a second dish with the
 * same photo reuses this copy. Null when it isn't in the folder or can't be read.
 */
export async function foodImageFromDrive(driveFileId: string, adminId: string | null): Promise<FoodImage | null> {
  const photo = await drivePhotoFile(driveFileId);
  if (!photo) return null;
  const existing = await libraryPhotoTitled(photo.title);
  if (existing) return existing;
  try {
    return await addFoodImage({ file: photo.file, title: photo.title, adminId });
  } catch (e) {
    // Two dishes matched the same photo at once: the first copy is the one to use.
    if (e instanceof DuplicateTitleError) return libraryPhotoTitled(photo.title);
    throw e;
  }
}

/**
 * The photo to attach to a new menu item that came without one, or null when a person
 * should choose: the library first, then the owner's Drive, and only at 95% or better
 * (`autoMatch`). An unset photo is a visible gap someone fixes; a confidently wrong one
 * is a mutton photo on a vegetarian dish that nobody notices until a customer does.
 */
export async function autoMatchImage(dishName: string): Promise<{
  image: FoodImage;
  reason: string;
} | null> {
  const inLibrary = autoMatch(dishName, await candidatesFor(dishName));
  if (inLibrary) {
    return { image: inLibrary.candidate, reason: `${Math.round(inLibrary.similarity * 100)}% match` };
  }
  const inDrive = autoMatch(dishName, (await listDrivePhotos()).map(driveCandidate));
  if (!inDrive?.candidate.driveFileId) return null;
  const image = await foodImageFromDrive(inDrive.candidate.driveFileId, null);
  return image ? { image, reason: `${Math.round(inDrive.similarity * 100)}% match from Drive` } : null;
}

/** The library and the Drive folder as one list. A photo in both shows once. */
async function withDrivePhotos(library: FoodImage[]): Promise<FoodImage[]> {
  const known = new Set(library.map((i) => i.title.toLowerCase()));
  const drive = (await listDrivePhotos().catch(() => [] as DrivePhoto[]))
    .filter((p) => !known.has(p.title.toLowerCase()))
    .map(driveCandidate);
  return [...library, ...drive];
}

/** Ranked suggestions for the picker: best first, conflicts already removed. */
export async function suggestImages(
  dishName: string,
  limit = 12
): Promise<{ image: FoodImage; score: number; reason: string }[]> {
  const candidates = await candidatesFor(dishName);
  return rankCandidates(dishName, candidates)
    .slice(0, limit)
    .map((r) => ({ image: r.candidate, score: r.score, reason: r.reason }));
}

/** `suggestImages`, including photos still only in the Drive. For the web picker. */
export async function suggestImagesWithDrive(
  dishName: string,
  limit = 12
): Promise<{ image: FoodImage; score: number; reason: string }[]> {
  const candidates = await withDrivePhotos(await candidatesFor(dishName));
  return rankCandidates(dishName, candidates)
    .slice(0, limit)
    .map((r) => ({ image: r.candidate, score: r.score, reason: r.reason }));
}

/** Search by name across the library and the Drive folder. For the web picker. */
export async function searchImagesWithDrive(query: string, limit = 40): Promise<FoodImage[]> {
  const library = await listFoodImages({ query, limit });
  const known = new Set(library.map((i) => i.title.toLowerCase()));
  const photos = (await listDrivePhotos().catch(() => [] as DrivePhoto[]))
    .filter((p) => !known.has(p.title.toLowerCase()))
    .map(driveCandidate);
  return [...library, ...searchLibrary(query, photos, {})].slice(0, limit);
}

/**
 * Browse or search the library.
 *
 * Looser than the matcher on purpose: someone typing "biryani" wants to see the
 * whole family and pick, which is the entire reason the "Choose from storage"
 * option exists. The narrowing is done in Postgres when there is a query, and
 * the ordering in TypeScript so it matches what the picker does as you type.
 */
export async function listFoodImages(opts: {
  query?: string;
  limit?: number;
  veg?: boolean | null;
} = {}): Promise<FoodImage[]> {
  const supabase = createAdminClient();
  const limit = Math.min(200, Math.max(1, opts.limit ?? 60));
  const tokens = opts.query ? tokenize(opts.query) : [];

  let q = supabase.from("food_images").select(SELECT);
  if (tokens.length > 0) {
    // Overlap first (indexed), then a title ILIKE as a safety net for a query
    // whose words are not in anyone's keyword list yet.
    const needle = opts.query!.replace(/[,()%*\\]/g, " ").trim();
    q = q.or(`keywords.ov.{${tokens.join(",")}},title.ilike.%${needle}%`);
  }

  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  const rows = ((data ?? []) as Row[]).map(map);
  if (!opts.query) return rows;
  return searchLibrary(opts.query, rows, { veg: opts.veg ?? null });
}

export class DuplicateTitleError extends Error {
  constructor(public readonly title: string) {
    super("duplicate_title");
    this.name = "DuplicateTitleError";
  }
}

/**
 * Upload a photo into the library.
 *
 * The declared MIME type is checked against the actual bytes before anything
 * reaches a world-readable bucket — the same guard `vendor-logos` uses, and for
 * the same reason: this rides the service-role client past storage policies, so
 * the file picker's word for what a file is cannot be the only word.
 */
export async function addFoodImage(input: {
  file: File;
  title: string;
  description?: string | null;
  tags?: string[];
  veg?: boolean | null;
  /** Null when it was added by the automatic match rather than by a person. */
  adminId: string | null;
}): Promise<FoodImage> {
  const title = input.title.trim();
  if (!title) throw new Error("title_required");

  const ext = TYPES[input.file.type];
  if (!ext) throw new Error("invalid_type");
  if (input.file.size === 0) throw new Error("invalid_type");
  if (input.file.size > MAX_BYTES) throw new Error("too_large");
  await assertRealType(input.file, ["image/jpeg", "image/png", "image/webp"]);

  const admin = createAdminClient();
  const path = `${randomUUID()}.${ext}`;
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, input.file, { contentType: input.file.type, upsert: false });
  if (upErr) throw upErr;

  const {
    data: { publicUrl },
  } = admin.storage.from(BUCKET).getPublicUrl(path);

  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const keywords = keywordsFor(title, tags);
  // Not stated by the admin? Read it off the name. "Paneer Tikka" is vegetarian
  // whether or not someone remembered to tick the box, and the matcher uses
  // this to keep meat off vegetarian dishes.
  const veg = input.veg ?? vegFromTokens(keywords);

  const { data, error } = await admin
    .from("food_images")
    .insert({
      title,
      description: input.description?.trim() || null,
      image_url: publicUrl,
      storage_path: path,
      keywords,
      tags,
      veg,
      created_by: input.adminId,
    })
    .select(SELECT)
    .single();

  if (error) {
    // The row failed, so the object is an orphan in a public bucket. Remove it
    // rather than leave a file nothing references and nothing will clean up.
    await admin.storage.from(BUCKET).remove([path]).catch(() => {});
    if (error.code === "23505") throw new DuplicateTitleError(title);
    throw error;
  }

  return map(data as Row);
}

export async function updateFoodImage(
  id: string,
  input: { title: string; description?: string | null; tags?: string[]; veg?: boolean | null }
): Promise<void> {
  const title = input.title.trim();
  if (!title) throw new Error("title_required");
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const keywords = keywordsFor(title, tags);

  const admin = createAdminClient();
  const { error } = await admin
    .from("food_images")
    .update({
      title,
      description: input.description?.trim() || null,
      tags,
      keywords,
      // Re-derived from the new title, so renaming "Veg Biryani" to "Chicken
      // Biryani" moves the diet flag with it instead of leaving a stale one
      // that would let the matcher offer it for the wrong dishes.
      veg: input.veg ?? vegFromTokens(keywords),
    })
    .eq("id", id);
  if (error) {
    if (error.code === "23505") throw new DuplicateTitleError(title);
    throw error;
  }
}

/**
 * Delete a library photo and its stored file.
 *
 * Menu items keep the URL they already have — `image_library_id` is ON DELETE
 * SET NULL — so a vendor's menu does not go blank because an admin tidied the
 * library. The URL will 404 once the object is gone, which is why the object is
 * only removed when nothing is using it.
 */
export async function deleteFoodImage(
  id: string
): Promise<{ ok: true } | { error: string }> {
  const admin = createAdminClient();

  const { data: image, error: gErr } = await admin
    .from("food_images")
    .select("id, storage_path, image_url")
    .eq("id", id)
    .maybeSingle();
  if (gErr) throw gErr;
  if (!image) return { error: "That photo no longer exists." };

  const { count, error: cErr } = await admin
    .from("menu_items")
    .select("id", { head: true, count: "exact" })
    .eq("image_library_id", id);
  if (cErr && !isMissingTable(cErr)) throw cErr;

  const inUse = count ?? 0;
  if (inUse > 0) {
    return {
      error: `${inUse} menu item${inUse === 1 ? " is" : "s are"} using this photo. Change ${inUse === 1 ? "it" : "them"} first, or the ${inUse === 1 ? "item" : "items"} will show a broken image.`,
    };
  }

  const { error } = await admin.from("food_images").delete().eq("id", id);
  if (error) throw error;

  if (image.storage_path) {
    await admin.storage
      .from(BUCKET)
      .remove([image.storage_path as string])
      .catch(() => {});
  }
  return { ok: true };
}

