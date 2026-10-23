/**
 * Read an upload without trusting its size. A Content-Length check is only as good as the
 * header: a chunked body carries none, and `request.formData()` buffers all of whatever
 * arrives. This reads the body as a stream, counts as it goes and walks away at the cap,
 * so an oversized upload costs at most `max` bytes of memory; then parses the bytes it
 * kept. Returns null for anything refused — too big, not multipart, no body — and the
 * caller answers the same 400 for all of them.
 */
export async function readLimitedForm(request: Request, max: number): Promise<FormData | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type) || !request.body) return null;
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return await new Response(bytes, { headers: { "content-type": type } }).formData();
  } catch {
    return null;
  }
}
