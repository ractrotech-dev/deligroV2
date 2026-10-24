/**
 * QA — fingerprint v2 (docs/OBSERVABILITY_V2.md): the same bug stays one issue
 * across deploys, and a laptop is never "production".
 * Usage: npx tsx scripts/qa/obs-fingerprint-v2.ts
 */
import { fingerprint, normaliseMessage, stableLocation } from "../../src/lib/obs/fingerprint";
import { currentEnv } from "../../src/lib/obs/ids";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

const base = { env: "production", kind: "error", errorType: "TypeError", message: "Cannot read properties of undefined (reading 'id')" };

check("an edit above the line does not split the issue",
  fingerprint({ ...base, culprit: "lib/data-access/orders.ts:88" }) === fingerprint({ ...base, culprit: "lib/data-access/orders.ts:91" }));
check("a minified bundle frame is not part of the key",
  fingerprint({ ...base, culprit: "/_next/static/chunks/app/page-3f2a9c.js:1:2034" }) ===
  fingerprint({ ...base, culprit: "/_next/static/chunks/app/page-77b1e0.js:1:1988" }));
check("a different file is still a different issue",
  fingerprint({ ...base, culprit: "lib/a.ts:10" }) !== fingerprint({ ...base, culprit: "lib/b.ts:10" }));
check("stableLocation drops line and column", stableLocation("lib/x.ts:12:5") === "lib/x.ts" && stableLocation("lib/x.ts:12") === "lib/x.ts");
check("stableLocation drops built bundles", stableLocation("/var/task/.next/server/chunks/123.js:1") === "");
check("web addresses in a message group together",
  normaliseMessage("fetch https://a.supabase.co/rest/v1/orders?id=eq.1 failed") === normaliseMessage("fetch https://b.supabase.co/rest/v1/menu failed"));
check("environment is part of the key",
  fingerprint({ ...base, culprit: "x" }) !== fingerprint({ ...base, env: "development", culprit: "x" }));

const saved = { vercel: process.env.VERCEL_ENV, node: process.env.NODE_ENV };
delete process.env.VERCEL_ENV;
(process.env as Record<string, string>).NODE_ENV = "production";
check("a local production build is 'development', not 'production'", currentEnv() === "development");
process.env.VERCEL_ENV = "production";
check("the live deployment is 'production'", currentEnv() === "production");
process.env.VERCEL_ENV = "preview";
check("a preview deployment is 'preview'", currentEnv() === "preview");
if (saved.vercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved.vercel;
(process.env as Record<string, string | undefined>).NODE_ENV = saved.node;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
