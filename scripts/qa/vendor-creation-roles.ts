/**
 * Only the admin panel and managers can add a vendor (docs/RULE-BOOK.md). Vendors
 * and customers cannot create a vendor account or sign themselves up.
 *
 * The database half (RLS, the onboarding function's grants, lock_role) is proved in
 * scripts/qa/sql/migration-0197.mjs. This is the application half: it walks every
 * source file, so a new route or action that creates a shop fails here until it is
 * added on purpose.
 *
 * Usage: npm run test:vendor-creation
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const sources = walk("src").map((file) => ({
  file: file.split(path.sep).join("/"),
  text: readFileSync(file, "utf8"),
}));
const callersOf = (pattern: RegExp) =>
  sources.filter((s) => pattern.test(s.text)).map((s) => s.file).sort();
const read = (file: string) => sources.find((s) => s.file === file)?.text ?? "";
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

const REGISTRATION = "src/lib/data-access/vendor-registration.ts";
const MANAGER_ACTIONS = "src/lib/data-access/manager-vendor-actions.ts";
const ADMIN_ACTIONS = "src/app/admin/vendors/actions.ts";
const MANAGER_ROUTE = "src/app/api/manager/vendors/route.ts";

console.log("\n── who can reach account creation ──");
{
  const callers = callersOf(/\bcreateVendorAccount\(/);
  const expected = [ADMIN_ACTIONS, MANAGER_ACTIONS, REGISTRATION].sort();
  check("createVendorAccount has only the admin and manager callers", same(callers, expected), callers.join(", "));

  const attach = callersOf(/\battachVendorToExistingUser\(/);
  const attachExpected = [ADMIN_ACTIONS, REGISTRATION].sort();
  check("attaching a shop to a customer is admin only", same(attach, attachExpected), attach.join(", "));

  const onboard = callersOf(/\bopsOnboardVendor\(/);
  const onboardExpected = [MANAGER_ACTIONS, MANAGER_ROUTE].sort();
  check("the manager onboarding call has one route", same(onboard, onboardExpected), onboard.join(", "));

  const rpc = callersOf(/["']ops_onboard_vendor["']/);
  check("only vendor-registration.ts calls the onboarding function", same(rpc, [REGISTRATION]), rpc.join(", "));
}

console.log("\n── each door is guarded ──");
{
  const admin = read(ADMIN_ACTIONS);
  for (const fn of ["createVendorAccountAction", "convertCustomerToVendorAction", "saveDraftAction"]) {
    const at = admin.indexOf(`export async function ${fn}(`);
    const body = at < 0 ? "" : admin.slice(at, at + 400);
    check(`${fn} starts with requireRole("admin")`, /await requireRole\("admin"\)/.test(body));
  }
  check(
    "the manager route needs manager.vendors.onboard",
    /export async function POST[\s\S]{0,200}managerApiContext\("manager\.vendors\.onboard"\)/.test(read(MANAGER_ROUTE))
  );
}

console.log("\n── no other way in ──");
{
  const insert = sources
    .filter((s) => /\.from\(\s*["']restaurants["']\s*\)\s*\.(insert|upsert)\(/.test(s.text))
    .map((s) => s.file);
  check("nothing inserts a shop except through the onboarding function", insert.length === 0, insert.join(", "));

  const owner = callersOf(/role:\s*["']restaurant["']/).filter((f) => !f.includes("/ops/marketing-contract"));
  check("only account creation gives someone the vendor role", same(owner, [REGISTRATION]), owner.join(", "));

  const signUp = callersOf(/\.auth\.signUp\(/);
  check("nothing uses public sign-up", signUp.length === 0, signUp.join(", "));

  const pages = sources
    .filter((s) => /^src\/app\/(vendor|\(customer\)|\(auth\)|login|signup|register)/.test(s.file))
    .filter((s) => /\b(become a (vendor|partner|seller)|register your (shop|store|restaurant)|sell on deligro)\b/i.test(s.text))
    .map((s) => s.file);
  check("no screen invites a vendor to sign up", pages.length === 0, pages.join(", "));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
