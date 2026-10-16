"use client";

/**
 * Getting a folder of photos under the bucket's 2 MB ceiling, in the browser.
 *
 * A folder of real food photography is 4–8 MB a picture, and the `food-library`
 * bucket takes 2 MB. Without this, a bulk upload is mostly a list of failures
 * the operator can do nothing about — they are not going to open two hundred
 * files in an image editor.
 *
 * This is a convenience, not a control. The server still checks the declared
 * type against the actual bytes and still enforces the size limit
 * (`addFoodImage`), because anything a browser hands over is the caller's word.
 * Every failure path here returns the original file and lets the server say no.
 */

const MAX_BYTES = 2 * 1024 * 1024;
/** Under this, don't even decode — it already fits and re-encoding only loses. */
const LEAVE_ALONE = 1.5 * 1024 * 1024;

/**
 * Successively harder attempts. A library photo is displayed at ~240px in the
 * grid and ~800px at its largest, so 1600px on the long edge is generous; the
 * later rungs exist for the rare 12-megapixel JPEG that stays fat at quality
 * 0.8.
 */
const ATTEMPTS = [
  { edge: 1600, quality: 0.82 },
  { edge: 1400, quality: 0.72 },
  { edge: 1200, quality: 0.62 },
  { edge: 1000, quality: 0.5 },
];

function canvasFor(width: number, height: number): {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  toBlob: (type: string, quality: number) => Promise<Blob | null>;
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    return {
      ctx: canvas.getContext("2d"),
      toBlob: (type, quality) =>
        canvas.convertToBlob({ type, quality }).catch(() => null),
    };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return {
    ctx: canvas.getContext("2d"),
    toBlob: (type, quality) =>
      new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
  };
}

/**
 * Return a file that fits, or the original when it already does — or when
 * anything at all goes wrong, in which case the server gets the last word.
 */
export async function shrinkForUpload(file: File): Promise<File> {
  if (file.size <= LEAVE_ALONE) return file;
  if (typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // HEIC, a corrupt file, an animated WebP — let the server rule.
  }

  try {
    let best: Blob | null = null;

    for (const { edge, quality } of ATTEMPTS) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const { ctx, toBlob } = canvasFor(width, height);
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, width, height);

      const blob = await toBlob("image/webp", quality);
      // A browser that cannot write WebP hands back a PNG here, which would be
      // larger than what we started with — take JPEG instead.
      const encoded =
        blob?.type === "image/webp"
          ? blob
          : await toBlob("image/jpeg", quality);
      if (!encoded) return file;

      if (!best || encoded.size < best.size) best = encoded;
      if (encoded.size <= MAX_BYTES) break;
    }

    if (!best || best.size >= file.size) return file;

    const ext = best.type === "image/webp" ? "webp" : "jpg";
    return new File([best], file.name.replace(/\.[a-z0-9]+$/i, "") + "." + ext, {
      type: best.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
