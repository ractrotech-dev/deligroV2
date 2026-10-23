/**
 * Read an upload with a size limit that holds while it streams.
 *
 * `request.formData()` buffers the whole body before any size check can run,
 * and a chunked upload sends no Content-Length at all, so a check on that
 * header alone is skipped by exactly the request that matters (Phase 8 review
 * #19). This counts bytes as they arrive and stops reading — cancelling the
 * stream — the moment the limit is passed.
 *
 * Answers the parsed form, "too_large" (declared over the limit, or it grew past
 * it), or "bad" (no body, or not a multipart form).
 */
export async function readFormLimited(request: Request, maxBytes: number): Promise<FormData | "too_large" | "bad"> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
  if (!request.body) return "bad";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      return "bad";
    }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(step.value);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return await new Response(bytes, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return "bad";
  }
}
