import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Google Drive's pure parts: settings, the Google sign-in link, the token's
 * encryption, and reading names and links. No database or network, so
 * scripts/qa/google-drive.ts can check them. Only server code imports this.
 */

/**
 * Read-only. The narrower `drive.file` only sees files the app created, and the
 * owner's photos are already in their Drive. Nothing here can change the Drive.
 */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  /** Exactly as listed on the OAuth client in Google Cloud. */
  redirectUri: string;
  /** 32 bytes: encrypts the refresh token. */
  tokenKey: Buffer;
}

type Env = Record<string, string | undefined>;

/** Null unless every setting is there and usable: a missing one turns Drive off, never on. */
export function driveConfig(env: Env = process.env): DriveConfig | null {
  const clientId = env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_DRIVE_REDIRECT_URI?.trim();
  const rawKey = env.GOOGLE_DRIVE_TOKEN_KEY?.trim();
  if (!clientId || !clientSecret || !redirectUri || !rawKey) return null;
  const tokenKey = Buffer.from(rawKey, "base64");
  if (tokenKey.length !== 32) return null;
  try {
    new URL(redirectUri);
  } catch {
    return null;
  }
  return { clientId, clientSecret, redirectUri, tokenKey };
}

/** `prompt=consent` with offline access is what makes Google hand over a refresh token. */
export function googleSignInUrl(config: DriveConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** iv.tag.ciphertext, base64. GCM refuses anything altered, and any other key. */
export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

/** Throws when the value was altered or the key is wrong. */
export function decryptToken(stored: string, key: Buffer): string {
  const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !data) throw new Error("bad_token");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Google's ids are letters, digits, `-` and `_`; this also keeps a query safe to build. */
export function isDriveId(id: unknown): id is string {
  return typeof id === "string" && /^[\w-]{5,200}$/.test(id);
}

/** The id from a Drive folder link, or a bare id. Null for anything else. */
export function folderIdFrom(input: string): string | null {
  const text = input.trim();
  if (isDriveId(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.hostname !== "drive.google.com") return null;
    const id = /\/folders\/([\w-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("id");
    return isDriveId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * "chicken_biryani (2).JPG" → "chicken biryani". The file name is what the library
 * matches dishes on, so a camera's name like IMG_1234 is refused rather than saved
 * as a photo no dish could ever find.
 */
export function dishTitleFromFileName(name: string): string | null {
  const title = name
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\(\d+\)/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if ((title.match(/\p{L}/gu) ?? []).length < 3) return null;
  if (/^(img|image|dscn?|pxl|photo|picture|pic|untitled)[\s\d.:]*$/i.test(title)) return null;
  if (/^(screenshot|whatsapp image)\b/i.test(title)) return null;
  return Array.from(title).slice(0, 120).join("");
}

/** A resized copy may only be fetched, with the owner's token, from Google's own image host. */
export function isGoogleThumbnail(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}
