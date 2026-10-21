import "server-only";

/**
 * Magic-byte validation for uploads.
 *
 * `File.type` is whatever the client said it was — a multipart part can declare
 * `image/png` and carry anything at all. The buckets set `allowed_mime_types`
 * and the callers cap size, but both of those also trust the declared type, so
 * nothing in the chain actually looks at the bytes. This does.
 *
 * Kept deliberately small: we accept four formats, and each has a short, stable
 * signature at a fixed offset. No dependency needed for that.
 */

/** The formats any Deligro upload path accepts. */
export type SniffedType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "application/pdf"
  | "audio/mpeg"
  | "audio/wav"
  | "audio/ogg";

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/**
 * The real type of these bytes, or null if it isn't one we accept.
 * Only the header is inspected, so the caller can pass a slice.
 */
export function sniffType(bytes: Uint8Array): SniffedType | null {
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  // WebP is a RIFF container: "RIFF" <4-byte size> "WEBP".
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }

  // PDF: "%PDF-"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";

  // WAV is a RIFF container too: "RIFF" <4-byte size> "WAVE".
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)
  ) {
    return "audio/wav";
  }

  // OGG: "OggS"
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";

  // MP3: an ID3v2 tag ("ID3"), which almost every real-world file carries, or —
  // failing that — a raw MPEG frame sync (11 set bits: 0xFF then top 3 bits set).
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }

  return null;
}

/**
 * Throw unless the file's actual bytes are one of `allowed` AND match the type
 * the client declared. Both halves matter: the first stops a disguised payload,
 * the second stops a real PNG being stored and later served as something else.
 *
 * Throws `invalid_type`, matching the error contract the upload routes already
 * map to a 400.
 */
export async function assertRealType(
  file: File,
  allowed: readonly SniffedType[]
): Promise<SniffedType> {
  // 16 bytes covers every signature above (WebP needs 12).
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const actual = sniffType(header);

  if (!actual || !allowed.includes(actual)) throw new Error("invalid_type");
  if (actual !== file.type) throw new Error("invalid_type");

  return actual;
}
