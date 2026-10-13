/**
 * QA — the Developer overview's checks.
 *
 * The rules this pins, offline:
 *   - a check that cannot be answered is Unknown, never Pass;
 *   - an integration nobody configured is Not configured, not Down;
 *   - configuration is reported as variable NAMES only: no value, prefix or
 *     length can reach the page;
 *   - the Node version shown is compared with the one `.nvmrc` pins;
 *   - the admin console no longer carries technical health, and the overview
 *     calls no provider.
 *
 * Usage: npm run test:developer-health
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  EXPECTED_NODE_MAJOR,
  classifyDatabaseLatency,
  configRows,
  deploymentRows,
  nodeMajor,
  summarize,
} from "../../src/lib/developer/health-checks";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8").split("\r\n").join("\n");
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const find = (rows: { label: string }[], label: string) => rows.find((r) => r.label === label) as never as { state: string; detail: string; note?: string };

console.log("\n═══ release ═══");
const prod = deploymentRows({ VERCEL_GIT_COMMIT_SHA: "f2847645abcdef", VERCEL_GIT_COMMIT_REF: "master", VERCEL_ENV: "production", VERCEL_REGION: "iad1" }, "v24.1.0");
check("a production build names its commit, branch and environment", find(prod, "Release").detail, "f284764 · master · production");
check("and passes", find(prod, "Release").state, "ok");
check("a preview build is flagged, not passed", find(deploymentRows({ VERCEL_GIT_COMMIT_SHA: "abc1234", VERCEL_ENV: "preview" }, "v24.0.0"), "Release").state, "degraded");
check("no commit means Unknown, not Pass", find(deploymentRows({}, "v24.0.0"), "Release").state, "unknown");
check("the function region is shown", find(prod, "Function region").detail, "iad1");
check("but is never scored as passing (the database region is not known here)", find(prod, "Function region").state, "unknown");
check("a missing region is Unknown", find(deploymentRows({}, "v24.0.0"), "Function region").state, "unknown");

console.log("\n═══ Node.js ═══");
check("the major version is read", nodeMajor("v22.16.0"), 22);
check("a garbled version reads as nothing", nodeMajor("banana"), null);
check("the expected Node matches the version pinned in .nvmrc", EXPECTED_NODE_MAJOR, Number(read(".nvmrc").trim()));
check("the matching version passes", find(deploymentRows({}, "v24.3.1"), "Node.js").state, "ok");
check("a different version is flagged", find(deploymentRows({}, "v22.16.0"), "Node.js").state, "degraded");
check("and the flag says what was expected", find(deploymentRows({}, "v22.16.0"), "Node.js").detail.includes(String(EXPECTED_NODE_MAJOR)), true);
check("an unreadable version is Unknown", find(deploymentRows({}, "banana"), "Node.js").state, "unknown");

console.log("\n═══ configuration ═══");
const SECRET = "SECRET-VALUE-do-not-leak-123";
const full: Record<string, string> = {};
for (const n of [
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SECRET_KEY", "OTP_PEPPER", "RENFLAIR_API_KEY",
  "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "NEXT_PUBLIC_RAZORPAY_KEY_ID",
  "ONESIGNAL_APP_ID", "ONESIGNAL_REST_API_KEY", "NEXT_PUBLIC_ONESIGNAL_APP_ID", "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
]) full[n] = SECRET;
const all = configRows(full);
check("everything set passes every area", all.filter((r) => r.state === "ok").length, all.length);
check("no secret value appears anywhere in the rows", JSON.stringify(all).includes(SECRET), false);
check("nor does any fragment of one", JSON.stringify(all).includes("SECRET"), false);

const noPay = { ...full };
for (const n of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "NEXT_PUBLIC_RAZORPAY_KEY_ID"]) delete noPay[n];
check("an integration with nothing set is Not configured, not Down", find(configRows(noPay), "Payments (Razorpay)").state, "off");
const partial = { ...full };
delete partial.RAZORPAY_WEBHOOK_SECRET;
const part = find(configRows(partial), "Payments (Razorpay)");
check("a half-configured integration is Down", part.state, "down");
check("and names exactly what is missing", part.detail, "Missing: RAZORPAY_WEBHOOK_SECRET");
const noCore = { ...full };
delete noCore.OTP_PEPPER;
const core = find(configRows(noCore), "Core: database, sign-in, SMS");
check("a missing core variable is Down", core.state, "down");
check("and is named", core.detail.includes("OTP_PEPPER"), true);
const renamed = { ...full };
delete renamed.NEXT_PUBLIC_SUPABASE_ANON_KEY;
renamed.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = SECRET;
check("the renamed Supabase key satisfies the same requirement", find(configRows(renamed), "Core: database, sign-in, SMS").state, "ok");
const blank = { ...full, OTP_PEPPER: "   " };
check("a blank value counts as missing", find(configRows(blank), "Core: database, sign-in, SMS").state, "down");
check("a retired setting that is still present is flagged", find(configRows({ ...full, MFA_EXEMPT_EMAILS: "a@b.c" }), "Retired settings").state, "degraded");
check("and is named without its value", find(configRows({ ...full, MFA_EXEMPT_EMAILS: SECRET }), "Retired settings").detail.includes(SECRET), false);
check("no retired setting passes", find(all, "Retired settings").state, "ok");

console.log("\n═══ database round trip ═══");
check("a fast query passes", classifyDatabaseLatency(120, false).state, "ok");
check("a slow query is flagged, not failed", classifyDatabaseLatency(900, false).state, "degraded");
check("a failed query is Down", classifyDatabaseLatency(50, true).state, "down");
check("a probe with no timing is Down, never Pass", classifyDatabaseLatency(null, false).state, "down");
check("the latency is shown in milliseconds", classifyDatabaseLatency(123.4, false).detail, "123 ms");

console.log("\n═══ the scorecard headline ═══");
const s = summarize([
  { label: "a", state: "ok", detail: "" }, { label: "b", state: "ok", detail: "" },
  { label: "c", state: "degraded", detail: "" }, { label: "d", state: "down", detail: "" },
  { label: "e", state: "unknown", detail: "" }, { label: "f", state: "off", detail: "" },
]);
check("passing", s.pass, 2);
check("degraded and down both need investigating", s.investigate, 2);
check("unknown stays its own bucket", s.unknown, 1);
check("not configured stays its own bucket", s.notConfigured, 1);
check("unknown never counts as passing", summarize([{ label: "x", state: "unknown", detail: "" }]).pass, 0);

console.log("\n═══ where it lives ═══");
const adminFiles = [...walk(join(root, "src/app/admin")), ...walk(join(root, "src/components/admin"))].map((f) => relative(root, f).split(sep).join("/"));
const stillHealthy = adminFiles.filter((f) => /ConsoleHealth|getConsoleHealth|SystemCard|HealthChip/.test(read(f)));
check("the admin console carries no technical health", stillHealthy.length, 0);
if (stillHealthy.length) console.log(`    ${stillHealthy.join(", ")}`);
const page = read("src/app/developer/page.tsx");
const server = read("src/lib/developer/scorecard.server.ts");
check("the overview page reads the scorecard, which requires the developer role", server.includes('requireRole("developer")') && page.includes("getScorecard()"), true);
check("the scorecard calls no payment, SMS or push provider", /razorpay|onesignal|renflair|fetch\(/i.test(server.replace(/RAZORPAY|ONESIGNAL/g, "")), false);
check("the overview prints no environment value", /process\.env/.test(page), false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
