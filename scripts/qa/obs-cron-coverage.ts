/**
 * QA — every background job reports its failures: each `/api/cron/*` route
 * exports its handlers through `withCronObservability` (OBSERVABILITY_V2.md).
 * Usage: npx tsx scripts/qa/obs-cron-coverage.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..", "src", "app", "api", "cron");
let passed = 0;
let failed = 0;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return f === "route.ts" ? [p] : [];
  });
}

const routes = walk(ROOT);
if (routes.length === 0) {
  failed++;
  console.log("  FAIL no cron routes found");
}
for (const file of routes) {
  const src = readFileSync(file, "utf8");
  const name = relative(ROOT, file).split(sep).join("/");
  const exported = [...src.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST)\b/g)].map((m) => m[1]);
  const wrapped = exported.every((verb) => new RegExp(`export const ${verb}\\s*=\\s*withCronObservability\\(`).test(src));
  if (exported.length > 0 && wrapped) {
    passed++;
    console.log(`  ok   ${name} reports its failures`);
  } else {
    failed++;
    console.log(`  FAIL ${name}: export it as  export const GET = withCronObservability("<job>", handler)`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
