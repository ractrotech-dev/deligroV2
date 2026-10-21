/**
 * QA — the manager side is English only (owner, 2026-10-21): no Hindi in the
 * manager API, the web manager portal, the manager-related admin screens, the
 * alert-kind labels, or the manager permission switches. Vendor and rider
 * switches keep their Hindi labels. Offline. Usage:
 * npx tsx scripts/qa/manager-english-only.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FEATURES } from "../../src/lib/features/catalog";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`, cond || detail === undefined ? "" : detail);
}

const root = join(__dirname, "..", "..");
const DEVANAGARI = /[ऀ-ॿ]/;

function files(dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [dir];
  return readdirSync(full).flatMap((name) => files(join(dir, name)));
}

const scanned = [
  "src/app/api/manager",
  "src/app/manager",
  "src/app/(portal-auth)/manager",
  "src/components/manager",
  "src/lib/manager",
  "src/lib/ops-alerts",
  "src/lib/auth/manager-api.server.ts",
  "src/lib/auth/manager-scope.ts",
  "src/app/admin/settings/zones",
  "src/app/admin/settings/employees",
].flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f));

console.log(`── ${scanned.length} manager files ──`);
const offenders = scanned.filter((f) => DEVANAGARI.test(readFileSync(join(root, f), "utf8")));
ok("no Hindi in the manager API, portal, admin manager screens or alert labels", offenders.length === 0, offenders);

console.log("\n── permission switches ──");
const manager = FEATURES.filter((f) => f.role === "manager");
ok("there are manager switches", manager.length > 0);
ok("no manager switch carries a Hindi label", manager.every((f) => !("labelHi" in f) || !f.labelHi));
const others = FEATURES.filter((f) => f.role !== "manager");
ok("vendor and rider switches keep theirs", others.length > 0 && others.every((f) => typeof f.labelHi === "string" && DEVANAGARI.test(f.labelHi)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
