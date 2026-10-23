/**
 * QA — an upload is limited while it streams, not after it is buffered
 * (Phase 8 review #19).
 *
 * `request.formData()` buffers the whole body, and a chunked upload sends no
 * Content-Length, so a size check on the header alone is skipped by it. The
 * helper counts bytes as they arrive and stops reading at the limit. Also
 * structural: every manager upload route goes through it.
 *
 * Usage: npx tsx scripts/qa/limited-body.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFormLimited } from "../../src/lib/http/limited-body";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

/** A request whose body arrives in `chunks` pieces of `size` bytes and reports how much was pulled. */
function chunked(chunks: number, size: number, headers: Record<string, string> = {}) {
  const state = { pulled: 0 };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent += 1;
      state.pulled += size;
      controller.enqueue(new Uint8Array(size).fill(65));
    },
  });
  const request = new Request("http://localhost/x", { method: "POST", body: stream, headers, duplex: "half" } as RequestInit);
  return { request, state };
}

async function main() {
  console.log("\n── streaming limit ──");
  {
    // 50 chunks of 64 KB = 3.2 MB, no Content-Length, limit 1 MB.
    const { request, state } = chunked(50, 64 * 1024, { "content-type": "multipart/form-data; boundary=x" });
    const r = await readFormLimited(request, 1024 * 1024);
    check("a chunked body over the limit is refused", r === "too_large");
    check("...and reading stopped near the limit, not at the end of the body", state.pulled < 1024 * 1024 + 4 * 64 * 1024, `pulled ${state.pulled} bytes`);
  }
  {
    const { request, state } = chunked(5, 1024, { "content-type": "multipart/form-data; boundary=x", "content-length": String(50 * 1024 * 1024) });
    const r = await readFormLimited(request, 1024 * 1024);
    // (A ReadableStream primes one chunk by itself when the Request is made; the helper reads none.)
    check("a Content-Length over the limit is refused without reading the body", r === "too_large" && state.pulled <= 1024, `pulled ${state.pulled}`);
  }
  {
    const form = new FormData();
    form.set("body", "hello");
    form.set("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    const raw = new Request("http://localhost/x", { method: "POST", body: form });
    const r = await readFormLimited(raw, 1024 * 1024);
    check("a small form comes back as FormData", r !== "too_large" && r !== "bad" && r.get("body") === "hello" && (r.get("file") as File).size === 3);
  }
  {
    const garbled = new Request("http://localhost/x", { method: "POST", body: "not multipart", headers: { "content-type": "multipart/form-data; boundary=x" } });
    const r = await readFormLimited(garbled, 1024 * 1024);
    check("a body that is not a form is 'bad', not an exception", r === "bad");
  }
  {
    const noBody = new Request("http://localhost/x", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" } });
    check("no body at all is 'bad'", (await readFormLimited(noBody, 1024)) === "bad");
  }

  console.log("\n── every manager upload goes through it ──");
  const uploads: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === "route.ts") uploads.push(p);
    }
  };
  walk("src/app/api/manager");
  const withForm = uploads.filter((p) => /\.formData\(\)/.test(readFileSync(p, "utf8")));
  check("no manager route calls request.formData() directly any more", withForm.length === 0, withForm.join(", "));
  const limited = uploads.filter((p) => /readFormLimited\(/.test(readFileSync(p, "utf8")));
  check("the five manager upload routes use readFormLimited", limited.length >= 5, String(limited.length));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
