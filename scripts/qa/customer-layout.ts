/**
 * QA — the customer layout's critical path.
 *
 * The layout used to await `getProfile()` (two Supabase round trips) before
 * sending a byte, only to hand a user id to push registration. That read now
 * sits behind a Suspense boundary. These checks keep it from drifting back, and
 * keep the one behaviour that must not change: a failed profile read must never
 * be rendered as "signed out" (which makes OneSignalInit log the browser out of
 * push).
 *
 * Usage: npm run test:customer-layout
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const src = readFileSync(join(root, "src/app/(customer)/layout.tsx"), "utf8")
  .split("\r\n")
  .join("\n");

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

const layoutStart = src.indexOf("export default async function CustomerLayout");
const layoutBody = src.slice(layoutStart);
const pushStart = src.indexOf("async function PushRegistration");
const pushBody = src.slice(pushStart, layoutStart);

console.log("\n═══ the layout's own awaits ═══");
check("the layout body does not call getProfile", layoutBody.includes("getProfile("), false);
check("it still reads settings and language together", layoutBody.includes("Promise.all([getSettings(), getLang()])"), true);

console.log("\n═══ push registration ═══");
check("PushRegistration reads the profile", pushBody.includes("await getProfile()"), true);
check("it renders OneSignalInit with the user id or null", pushBody.includes("userId={profile?.id ?? null}"), true);
check("a failed read is not swallowed into null", pushBody.includes(".catch("), false);
check("it sits inside a Suspense boundary", layoutBody.includes("<Suspense fallback={null}>") && layoutBody.includes("<PushRegistration />"), true);
check("the fallback never mounts OneSignalInit", layoutBody.includes("fallback={<OneSignalInit"), false);
check("OneSignalInit is mounted only through PushRegistration", layoutBody.includes("<OneSignalInit"), false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
