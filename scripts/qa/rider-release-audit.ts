/**
 * QA — the rider release security walk (Phase 8, docs/SECURITY_AUDIT.md §4): writes this project
 * added or changed that are reached outside /api/rider/* must carry a rateLimit() before they write.
 * Structural (reads the source); no server, no database. Usage: npm run test:rider-release-audit
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? ` — ${String(detail).slice(0, 200)}` : ""}`);
}

/** The body of an exported async function, from its opening brace to its matching close. */
function body(src: string, name: string): string {
  const at = src.search(new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`));
  if (at < 0) return "";
  // The body opens at the brace after the return type: `): Promise<…> {`.
  const sig = /\)\s*:\s*Promise<[^>]*>\s*\{/.exec(src.slice(at));
  if (!sig) return "";
  const i = at + sig.index + sig[0].length - 1;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  return "";
}

/** rateLimit( appears before the first write-ish call in the function. */
function limitedBefore(fnBody: string, write: RegExp): boolean {
  const limit = fnBody.search(/rateLimit\(/);
  const w = fnBody.search(write);
  return limit >= 0 && (w < 0 || limit < w);
}

console.log("\n── admin actions this project added or changed ──");
const settings = read("src/app/admin/settings/actions.ts");
const save = body(settings, "saveSettingsAction");
check("saveSettingsAction exists", save.length > 0);
check("saveSettingsAction: requireRole('admin') first, then rateLimit before the write",
  /^\{\s*const\s+admin\s*=\s*await\s+requireRole\(\s*"admin"\s*\)/.test(save) && limitedBefore(save, /updateSettings\(/));

const orders = read("src/app/admin/orders/actions.ts");
for (const [fn, write] of [["cancelOrderAsAdmin", /cancelOrderAsOps\(/], ["overrideOrderStatus", /readOrder\(|\.update\(/]] as const) {
  const b = body(orders, fn);
  check(`${fn} exists`, b.length > 0);
  check(`${fn}: requireRole('admin') first, then rateLimit before any read or write`,
    /^\{\s*const\s+admin\s*=\s*await\s+requireRole\(\s*"admin"\s*\)/.test(b) && limitedBefore(b, write));
}

console.log("\n── manager board actions (final review A minor 7, review B minor 3) ──");
const manager = read("src/app/manager/actions.ts");
for (const [fn, write] of [["advanceOrder", /\.update\(/], ["assignRider", /\.update\(|\.insert\(/]] as const) {
  // Leading comment lines are not code: requireRole must be the first statement.
  const b = body(manager, fn).replace(/^\s*\/\/.*$/gm, "");
  check(`${fn} exists`, b.length > 0);
  check(`${fn}: requireRole first, then rateLimit before any write`,
    /^\{\s*const\s+\w+\s*=\s*await\s+requireRole\(/.test(b) && limitedBefore(b, write));
}
{
  const b = body(manager, "assignRider");
  const gate = b.search(/riderUnworkable\(riderId\)/);
  const firstWrite = b.search(/\.update\(|\.insert\(/);
  check("assignRider: the rider is checked (a driver, active, not rejected, not blocked by expired documents) before any write",
    gate > 0 && (firstWrite < 0 || gate < firstWrite));
  check("...and a refusal says why, in plain English (UNWORKABLE_MESSAGE)", /UNWORKABLE_MESSAGE\[/.test(b));
  check("...and the rider id must be a uuid", /UUID\.test\(riderId\)/.test(b));
}

console.log("\n── /auth/signout: the rider's offline write ──");
const signout = read("src/app/auth/signout/route.ts");
const at = signout.indexOf("forceRiderOffline(profile.id");
const before = signout.slice(Math.max(0, at - 600), at);
check("forceRiderOffline is called on sign-out", at > 0);
check("...behind a per-rider rateLimit (the /api/rider/signout bucket)", /rateLimit\(`rider-signout:\$\{profile\.id\}`/.test(before));
check("...and a refused limit still signs out (only the write is skipped)",
  /if\s*\(limit\.ok\)\s*await\s+forceRiderOffline/.test(signout) && /await\s+supabase\.auth\.signOut\(\)/.test(signout));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
