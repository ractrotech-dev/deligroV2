/**
 * QA — observability v2 phase 2 catchers (docs/OBSERVABILITY_V2.md):
 * the database watcher and the session label on server errors.
 * Usage: npx tsx --conditions=react-server scripts/qa/obs-capture.ts
 */
import { dbTarget, describeRefusal, isRefusal, watchedFetch } from "../../src/lib/obs/db-watch";
import { actorIdFromCookieHeader } from "../../src/lib/obs/session-label";
import { deviceLabel } from "../../src/lib/obs/sign-ins";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const UID = "3f2a9c1e-0000-4000-8000-000000000001";

async function main() {
  // ---------- the database watcher ----------
  check("a table read is recognised", JSON.stringify(dbTarget("https://x.supabase.co/rest/v1/orders?select=id&id=eq.1")) === JSON.stringify({ name: "orders", isRpc: false }));
  check("a function call is recognised", JSON.stringify(dbTarget("https://x.supabase.co/rest/v1/rpc/ops_adjust_stock")) === JSON.stringify({ name: "ops_adjust_stock", isRpc: true }));
  check("auth and storage calls are not database refusals", dbTarget("https://x.supabase.co/auth/v1/token") === null && dbTarget("https://x.supabase.co/storage/v1/object/a") === null);
  check("300 (ambiguous embed) and 400+ are refusals; 200 and 204 are not",
    isRefusal(300) && isRefusal(400) && isRefusal(409) && isRefusal(500) && !isRefusal(200) && !isRefusal(204) && !isRefusal(206));
  check("the refusal reads as a sentence",
    describeRefusal("PATCH", { name: "orders", isRpc: false }, 409, "23505", "duplicate key value") === "Database refused to update orders: 23505 duplicate key value");

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: "23505", message: "dup" }), { status: 409 })) as typeof fetch;
    const res = await watchedFetch("https://x.supabase.co/rest/v1/orders", { method: "POST" });
    check("the caller still gets the refusal, body intact", res.status === 409 && (await res.json()).code === "23505");

    globalThis.fetch = (async () => new Response("[]", { status: 200 })) as typeof fetch;
    const ok = await watchedFetch("https://x.supabase.co/rest/v1/orders");
    check("a good answer passes through untouched", ok.status === 200 && (await ok.text()) === "[]");

    globalThis.fetch = (async () => new Response(JSON.stringify({ code: "XX000" }), { status: 500 })) as typeof fetch;
    const own = await watchedFetch("https://x.supabase.co/rest/v1/rpc/obs_ingest", { method: "POST" });
    check("the telemetry's own calls are passed through (never recorded)", own.status === 500);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ---------- who a server error hit ----------
  const jwt = `x.${b64url(JSON.stringify({ sub: UID }))}.y`;
  const session = JSON.stringify({ access_token: jwt, refresh_token: "r" });
  check("the person is read from a plain session cookie",
    actorIdFromCookieHeader(`a=1; sb-abcd-auth-token=${encodeURIComponent(session)}`) === UID);
  const encoded = `base64-${b64url(session)}`;
  const half = Math.floor(encoded.length / 2);
  check("…from a base64 cookie split into chunks, in any order",
    actorIdFromCookieHeader(`sb-abcd-auth-token.1=${encoded.slice(half)}; sb-abcd-auth-token.0=${encoded.slice(0, half)}`) === UID);
  check("no session, no person", actorIdFromCookieHeader("theme=dark") === null && actorIdFromCookieHeader(undefined) === null);
  check("a broken cookie is no person, not a crash", actorIdFromCookieHeader("sb-abcd-auth-token=base64-%%%") === null);
  // ---------- the copied bug report ----------
  const { eventReport } = await import("../../src/lib/developer/ai-report");
  const report = eventReport({
    id: 1, occurredAt: "2026-10-24T10:00:00Z", env: "production", release: "abc1234", kind: "client", level: "error",
    source: "client", message: "TypeError: x is undefined", traceId: null, requestId: null, spanId: null, durationMs: null,
    httpMethod: null, httpRoute: "/orders/[id]", httpStatus: null, provider: null, errorType: "client_error",
    errorFingerprint: "f", stack: null, actorRole: "customer", actorId: UID, orderId: null, restaurantId: null, driverId: null,
    attrs: { route: "/orders/x", steps: ["13:58:01 opened /orders/x", '13:58:04 clicked "Pay"', "13:58:05 → ERROR"] },
  } as never);
  check("the copied report never carries the person's account id", !report.includes(UID), report);
  check("…it says who by role", report.includes("Who: a customer"));
  check("…and lists the steps before it, oldest first, ending in the error",
    report.indexOf("opened /orders/x") < report.indexOf('clicked "Pay"') && report.includes("→ ERROR") && !report.includes('"steps"'));

  // ---------- device labels for sign-ins ----------
  check("Chrome on an Android phone", deviceLabel("Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36", null) === "Chrome on Android");
  check("Safari on an iPhone", deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", null) === "Safari on iPhone");
  check("Edge on Windows is not called Chrome", deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0", null) === "Edge on Windows");
  check("our own apps say which app", deviceLabel("Dart/3.13 (dart:io)", "deligro-partner-flutter/4") === "Partner app" && deviceLabel("Dart/3.13 (dart:io)", null) === "Deligro app");
  check("no user agent, no label", deviceLabel(null, null) === null);

  check("a token whose subject is not a profile id is ignored",
    actorIdFromCookieHeader(`sb-a-auth-token=${encodeURIComponent(JSON.stringify({ access_token: `x.${b64url(JSON.stringify({ sub: "anon" }))}.y` }))}`) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
