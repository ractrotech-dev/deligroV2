import "server-only";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "@/lib/support/rules";

/**
 * The body of a ticket / reply / SOS request: JSON, or multipart form data
 * when photos come with it (fields as strings, photos under `photos` — or
 * `photo`, repeated).
 *
 * Only called AFTER the route's auth gate and rate limit (reading a 20 MB
 * body is work an anonymous caller must not be able to make us do). A body
 * declaring more than four photos' worth of bytes is refused from its
 * Content-Length before it is read; the photos themselves are checked again
 * (count, type, size, magic bytes) by the data layer.
 */

/** Four full-size photos plus the text fields. */
const MAX_BODY_BYTES = MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES + 64 * 1024;

export type SupportBody =
  | { ok: true; fields: Record<string, unknown>; files: File[] }
  | { ok: false; error: "invalid_body" | "too_many_photos" | "photo_too_large" };

export async function readSupportBody(request: Request): Promise<SupportBody> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, error: "photo_too_large" };

  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return { ok: false, error: "invalid_body" };
    }
    const fields: Record<string, unknown> = {};
    const files: File[] = [];
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        if (!(key in fields)) fields[key] = value;
      } else if (key === "photos" || key === "photo") {
        files.push(value);
      }
    }
    if (files.length > MAX_ATTACHMENTS) return { ok: false, error: "too_many_photos" };
    return { ok: true, fields, files };
  }

  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "invalid_body" };
    return { ok: true, fields: parsed as Record<string, unknown>, files: [] };
  } catch {
    return { ok: false, error: "invalid_body" };
  }
}
