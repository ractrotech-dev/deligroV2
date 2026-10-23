/**
 * QA — readLimitedForm: an upload is read as a stream and abandoned at its cap, so a
 * chunked body with no Content-Length (which a header check cannot see) is never
 * buffered whole. Also: a body within the cap parses to its file, and a missing or
 * non-multipart body is refused.
 *
 * Usage: npx tsx scripts/qa/limited-form.ts
 */
import { readLimitedForm } from "../../src/lib/http/limited-form";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

/** A multipart request whose body is delivered in `chunks` pieces with no Content-Length. */
function chunkedUpload(bytes: number, chunkSize = 64 * 1024): { request: Request; pulled: () => number } {
  const boundary = "----qa";
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  let sent = 0;
  let pulled = 0;
  let phase: "head" | "body" | "tail" | "done" = "head";
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (phase === "head") { controller.enqueue(head); phase = "body"; return; }
      if (phase === "body") {
        const n = Math.min(chunkSize, bytes - sent);
        controller.enqueue(new Uint8Array(n).fill(7));
        sent += n;
        if (sent >= bytes) phase = "tail";
        return;
      }
      if (phase === "tail") { controller.enqueue(tail); phase = "done"; return; }
      controller.close();
    },
  });
  const request = new Request("http://localhost/upload", {
    method: "POST", body: stream, headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    // @ts-expect-error — Node's fetch needs this to send a stream body
    duplex: "half",
  });
  return { request, pulled: () => pulled };
}

async function main() {
  const CAP = 2 * 1024 * 1024 + 64 * 1024;

  const small = chunkedUpload(300 * 1024);
  const form = await readLimitedForm(small.request, CAP);
  const file = form?.get("file");
  check("a body within the cap parses to its file", file instanceof File && file.size === 300 * 1024, file instanceof File ? file.size : file);

  const big = chunkedUpload(50 * 1024 * 1024);
  check("a chunked body over the cap is refused", (await readLimitedForm(big.request, CAP)) === null);
  check("...and was abandoned early, not read to the end (50 MB is ~800 chunks of 64 KB)", big.pulled() < 100, big.pulled());

  check("a body with a Content-Length over the cap is refused before any read",
    (await readLimitedForm(new Request("http://localhost/u", { method: "POST", body: "x", headers: { "content-length": String(CAP + 1), "content-type": "multipart/form-data; boundary=b" } }), CAP)) === null);
  check("a body that is not multipart is refused", (await readLimitedForm(new Request("http://localhost/u", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), CAP)) === null);
  check("no body is refused", (await readLimitedForm(new Request("http://localhost/u", { method: "POST" }), CAP)) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
void main();
