import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { captureError } from "@/lib/obs/emit";
import {
  DRIVE_SCOPE,
  decryptToken,
  dishTitleFromFileName,
  driveConfig,
  encryptToken,
  folderIdFrom,
  isDriveId,
  isGoogleThumbnail,
  type DriveConfig,
} from "@/lib/drive/core";

/**
 * Food photos in the owner's Google Drive (migration 0204). The owner connects their
 * account and names a folder, and each photo's file name is the dish it shows. The
 * photo matching in food-images.ts reads this list; a photo is only copied out when a
 * dish matches it or someone picks it, so customers never load anything from Drive.
 *
 * Read-only: the app can't change anything in the Drive. Service role throughout:
 * callers have passed a role check, or are saving a dish for someone who has (AGENTS.md
 * rule 5). The token is decrypted only here; neither it nor an access token leaves the
 * server. Any failure reads as "no Drive photos", so a dish always still saves.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/drive/v3";
const TIMEOUT = () => AbortSignal.timeout(20_000);

/** The food library's own limit. A bigger photo comes in through Google's resized copy. */
const LIBRARY_MAX_BYTES = 2 * 1024 * 1024;
/** New photos in the folder show up within this long. */
const LIST_TTL_MS = 5 * 60_000;
const LIST_RETRY_MS = 60_000;
const LIST_PAGE = 1000;
const LIST_MAX_PAGES = 10;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export type DriveStatus =
  | { state: "not_set_up" }
  | { state: "not_migrated" }
  | { state: "not_connected" }
  | { state: "connected"; email: string; folderId: string | null; folderName: string | null };

/** The owner removed access, or Google ended it. Fixed by connecting again. */
export class DriveAccessEnded extends Error {}

interface Row {
  google_email: string;
  refresh_token_enc: string;
  folder_id: string | null;
  folder_name: string | null;
}

async function readRow(): Promise<Row | null> {
  const { data, error } = await createAdminClient()
    .from("google_drive_connection")
    .select("google_email, refresh_token_enc, folder_id, folder_name")
    .eq("id", true)
    .maybeSingle();
  if (error) throw error;
  return data as Row | null;
}

export async function getDriveStatus(): Promise<DriveStatus> {
  if (!isSupabaseConfigured || !driveConfig()) return { state: "not_set_up" };
  try {
    const row = await readRow();
    return row
      ? { state: "connected", email: row.google_email, folderId: row.folder_id, folderName: row.folder_name }
      : { state: "not_connected" };
  } catch (e) {
    if (isMissingTable(e as { code?: string })) return { state: "not_migrated" };
    throw e;
  }
}

/* ---------------- tokens ---------------- */

// Keyed to the stored token, so a disconnect or a new account can't reuse an old one.
let cached: { enc: string; token: string; until: number } | null = null;

async function postToken(config: DriveConfig, body: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...body }),
    signal: TIMEOUT(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  return { ok: res.ok, json };
}

async function connection(): Promise<{ row: Row; token: string }> {
  const config = driveConfig();
  if (!config) throw new DriveAccessEnded("not_set_up");
  const row = await readRow();
  if (!row) throw new DriveAccessEnded("not_connected");

  if (cached && cached.enc === row.refresh_token_enc && cached.until > Date.now()) {
    return { row, token: cached.token };
  }
  let refresh: string;
  try {
    refresh = decryptToken(row.refresh_token_enc, config.tokenKey);
  } catch {
    // GOOGLE_DRIVE_TOKEN_KEY changed: the stored token can't be read any more.
    throw new DriveAccessEnded("bad_key");
  }
  const { ok, json } = await postToken(config, { grant_type: "refresh_token", refresh_token: refresh });
  if (!ok || !json.access_token) {
    if (json.error === "invalid_grant") throw new DriveAccessEnded("invalid_grant");
    throw new Error("drive_token_failed");
  }
  cached = {
    enc: row.refresh_token_enc,
    token: json.access_token,
    until: Date.now() + Math.max(0, (json.expires_in ?? 3600) - 60) * 1000,
  };
  return { row, token: json.access_token };
}

async function api(token: string, url: string): Promise<Response> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: TIMEOUT() });
  // The owner removed the app's access in their Google account.
  if (res.status === 401) throw new DriveAccessEnded("revoked");
  return res;
}

/* ---------------- connecting ---------------- */

export type ConnectResult = { ok: true; email: string } | { ok: false; reason: "no_scope" | "no_refresh" | "failed" };

/** The end of Google's sign-in: swap the code, check what was granted, keep the token. */
export async function completeDriveConnection(code: string, adminId: string): Promise<ConnectResult> {
  const config = driveConfig();
  if (!config) return { ok: false, reason: "failed" };

  const { ok, json } = await postToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });
  if (!ok || !json.access_token) return { ok: false, reason: "failed" };
  // Google lets someone untick the Drive box on its consent screen.
  if (!(json.scope ?? "").split(" ").includes(DRIVE_SCOPE)) return { ok: false, reason: "no_scope" };
  if (!json.refresh_token) return { ok: false, reason: "no_refresh" };

  const about = await api(json.access_token, `${API}/about?fields=user(emailAddress)`);
  const aboutJson = (await about.json().catch(() => ({}))) as { user?: { emailAddress?: string } };
  const email = aboutJson.user?.emailAddress?.trim();
  if (!about.ok || !email) return { ok: false, reason: "failed" };

  // The same account keeps its folder; another account has to choose its own.
  const previous = await readRow();
  const same = previous?.google_email === email;

  const { error } = await createAdminClient()
    .from("google_drive_connection")
    .upsert({
      id: true,
      google_email: email,
      refresh_token_enc: encryptToken(json.refresh_token, config.tokenKey),
      folder_id: same ? previous.folder_id : null,
      folder_name: same ? previous.folder_name : null,
      connected_by: adminId,
      connected_at: new Date().toISOString(),
    });
  if (error) throw error;
  cached = null;
  listCache = null;
  return { ok: true, email };
}

/** Ends Google's access too when it can. Nothing in the Drive or the library changes. */
export async function disconnectDrive(): Promise<void> {
  const config = driveConfig();
  const row = await readRow();
  if (config && row) {
    try {
      const refresh = decryptToken(row.refresh_token_enc, config.tokenKey);
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh }),
        signal: TIMEOUT(),
      });
    } catch {
      // Forgetting it here still matters most, so a failed revoke doesn't stop that.
    }
  }
  const { error } = await createAdminClient().from("google_drive_connection").delete().eq("id", true);
  if (error) throw error;
  cached = null;
  listCache = null;
}

/** Saves the photo folder from its Drive link, once Google confirms it is a folder. */
export async function setDriveFolder(link: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const id = folderIdFrom(link);
  if (!id) return { ok: false, error: "Paste the link to the Drive folder." };
  const { token } = await connection();
  const res = await api(token, `${API}/files/${id}?fields=id,name,mimeType,trashed&supportsAllDrives=true`);
  const json = (await res.json().catch(() => ({}))) as { name?: string; mimeType?: string; trashed?: boolean };
  if (!res.ok || json.mimeType !== "application/vnd.google-apps.folder" || json.trashed) {
    return { ok: false, error: "This Google account can't open a folder at that link." };
  }
  const name = json.name?.trim() || "Drive folder";
  const { error } = await createAdminClient()
    .from("google_drive_connection")
    .update({ folder_id: id, folder_name: name })
    .eq("id", true);
  if (error) throw error;
  listCache = null;
  return { ok: true, name };
}

/* ---------------- the photos ---------------- */

export interface DrivePhoto {
  id: string;
  /** The dish name, from the file name. */
  title: string;
}

interface DriveListing {
  id: string;
  name: string;
}

// The promise itself is cached, so a menu sheet of many dishes makes one listing.
let listCache: { until: number; photos: Promise<DrivePhoto[]> } | null = null;

async function readPhotoList(): Promise<DrivePhoto[]> {
  const { row, token } = await connection();
  if (!row.folder_id) return [];
  const photos: DrivePhoto[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      // `folder_id` was checked as a Drive id and confirmed as a folder when saved.
      q: `'${row.folder_id}' in parents and trashed = false and (${PHOTO_TYPES.map((t) => `mimeType = '${t}'`).join(" or ")})`,
      fields: "nextPageToken,files(id,name)",
      orderBy: "name",
      pageSize: String(LIST_PAGE),
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await api(token, `${API}/files?${params}`);
    if (!res.ok) throw new Error("drive_list_failed");
    const json = (await res.json()) as { files?: DriveListing[]; nextPageToken?: string };
    for (const file of json.files ?? []) {
      const title = dishTitleFromFileName(file.name);
      if (title && isDriveId(file.id)) photos.push({ id: file.id, title });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return photos;
}

/** Every named photo in the folder. Empty when Drive isn't connected or can't be read. */
export function listDrivePhotos(): Promise<DrivePhoto[]> {
  if (!isSupabaseConfigured || !driveConfig()) return Promise.resolve([]);
  if (listCache && listCache.until > Date.now()) return listCache.photos;
  const entry: { until: number; photos: Promise<DrivePhoto[]> } = {
    until: Date.now() + LIST_TTL_MS,
    photos: readPhotoList().catch((e) => {
      // Not connected is normal. Anything else is worth seeing, but costs only the match.
      if (!(e instanceof DriveAccessEnded) && !isMissingTable(e as { code?: string })) {
        captureError(e, { source: "google-drive", attrs: { event: "drive_list_failed" } });
      }
      entry.until = Date.now() + LIST_RETRY_MS;
      return [];
    }),
  };
  listCache = entry;
  return entry.photos;
}

export async function countDrivePhotos(): Promise<number> {
  return (await listDrivePhotos()).length;
}

interface PhotoMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  thumbnailLink?: string;
  parents?: string[];
}

/** Read fresh each time, and refused unless the file is in the owner's chosen folder. */
async function photoInFolder(id: string): Promise<{ token: string; meta: PhotoMeta } | null> {
  if (!isDriveId(id)) return null;
  const { row, token } = await connection();
  if (!row.folder_id) return null;
  const res = await api(token, `${API}/files/${id}?fields=id,name,mimeType,size,thumbnailLink,parents,trashed&supportsAllDrives=true`);
  if (!res.ok) return null;
  const meta = (await res.json()) as PhotoMeta & { trashed?: boolean };
  if (meta.trashed || !meta.parents?.includes(row.folder_id) || !PHOTO_TYPES.includes(meta.mimeType)) return null;
  return { token, meta };
}

async function imageFromResponse(res: Response): Promise<{ type: string; bytes: ArrayBuffer } | null> {
  if (!res.ok) return null;
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!PHOTO_TYPES.includes(type)) return null;
  return { type, bytes: await res.arrayBuffer() };
}

/** A small preview, for the picker. */
export async function drivePhotoPreview(id: string): Promise<{ type: string; bytes: ArrayBuffer } | null> {
  const found = await photoInFolder(id);
  if (!found) return null;
  const { token, meta } = found;
  if (meta.thumbnailLink && isGoogleThumbnail(meta.thumbnailLink)) {
    return imageFromResponse(await api(token, meta.thumbnailLink.replace(/=s\d+$/, "=s400")));
  }
  if (Number(meta.size ?? 0) > LIBRARY_MAX_BYTES) return null;
  return imageFromResponse(await api(token, `${API}/files/${id}?alt=media&supportsAllDrives=true`));
}

/** The photo itself, or Google's resized copy when the original is over the library's limit. */
export async function drivePhotoFile(id: string): Promise<{ file: File; title: string } | null> {
  const found = await photoInFolder(id);
  if (!found) return null;
  const { token, meta } = found;
  const title = dishTitleFromFileName(meta.name);
  if (!title) return null;

  let res: Response;
  if (Number(meta.size ?? 0) > LIBRARY_MAX_BYTES) {
    if (!meta.thumbnailLink || !isGoogleThumbnail(meta.thumbnailLink)) return null;
    res = await api(token, meta.thumbnailLink.replace(/=s\d+$/, "=s1600"));
  } else {
    res = await api(token, `${API}/files/${id}?alt=media&supportsAllDrives=true`);
  }
  const image = await imageFromResponse(res);
  if (!image || image.bytes.byteLength > LIBRARY_MAX_BYTES) return null;
  return { title, file: new File([image.bytes], `${title}.${image.type.split("/")[1]}`, { type: image.type }) };
}
