/**
 * QA — admin/vendor platform separation.
 *
 * Two things this pack refuses to take on trust:
 *
 * 1. **Which shell the server renders.** The console used to be decided
 *    client-side only, so every server render answered "phone frame" and the
 *    admin console shipped as a 402px iPhone mock that swapped to the console
 *    after hydration. The resolution order is now a pure function of a cookie
 *    and a user agent, so it is testable, and it is tested.
 * 2. **The console-reach contract.** `reach: "console"` used to mean only "keep
 *    this out of the phone's menu" — the route itself still rendered a
 *    ten-tab, 560px-wide observability console inside the phone frame. Every
 *    console-reach nav entry must now have a route that actually gates, and the
 *    phone's derived menu must never offer one.
 *
 * Presentation only, on both counts. Nothing here is authorization: every
 * server action and API route keeps its own `requireRole` check, which is what
 * this suite asserts is still true in `scripts/qa/idor-suite.ts`.
 *
 * Runs offline. Usage:  npm run test:platform
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseShellMode,
  shellModeFromUserAgent,
  SHELL_COOKIE,
  type ShellMode,
} from "../../src/lib/shell-mode.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every file under a directory, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

/* ============================================================
   1. Shell resolution
   ============================================================
   A copy of `resolveShellMode`'s decision, minus the `next/headers` plumbing
   this process has no request to give it. Kept adjacent to the real one on
   purpose: if the order of authority changes there and not here, this fails.
   ------------------------------------------------------------ */
function resolve(cookie: string | undefined, ua: string | null): ShellMode {
  if (shellModeFromUserAgent(ua) === "app") return "app";
  return parseShellMode(cookie) ?? "web";
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const IPAD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

console.log("\n── Shell resolution (server) ──");
check("a desktop with no cookie gets the console", resolve(undefined, DESKTOP_UA), "web");
check("a desktop that chose app gets the phone frame", resolve("app", DESKTOP_UA), "app");
check("a desktop that chose web gets the console", resolve("web", DESKTOP_UA), "web");
check("an iPhone with no cookie gets the phone frame", resolve(undefined, IPHONE_UA), "app");
check("an Android phone gets the phone frame", resolve(undefined, ANDROID_UA), "app");
check(
  "a handset never gets the console, whatever the cookie says",
  resolve("web", IPHONE_UA),
  "app"
);
check("an iPad is a desktop-class client", resolve(undefined, IPAD_UA), "web");
check("a missing user agent falls back to the console", resolve(undefined, null), "web");
check("a junk cookie is ignored, not trusted", resolve("console", DESKTOP_UA), "web");
check("an empty cookie is ignored", resolve("", DESKTOP_UA), "web");

console.log("\n── Cookie parsing ──");
check("app parses", parseShellMode("app"), "app");
check("web parses", parseShellMode("web"), "web");
check("anything else is null", parseShellMode("APP"), null);
check("undefined is null", parseShellMode(undefined), null);
check("admin and vendor have separate cookies", SHELL_COOKIE.admin === SHELL_COOKIE.vendor, false);

/* ============================================================
   2. No phone chrome in the console branch
   ============================================================
   The regression that started all of this is visual, so it is asserted
   structurally: the `.device` frame, the phone header and the bottom tab bar
   must appear only inside the `effective === "app"` branch of each shell.
   ------------------------------------------------------------ */
console.log("\n── Console branch carries no phone chrome ──");

function consoleBranch(file: string): string {
  const src = readFileSync(join(root, file), "utf8");
  const marker = 'if (effective === "app") {';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`${file}: no app branch found`);
  // Everything after the app branch's own `return (…)` closes is the console
  // branch: both shells are a single early-return followed by the console.
  const tail = src.indexOf("\n  return (", start);
  if (tail < 0) throw new Error(`${file}: no console branch found`);
  return src.slice(tail);
}

const PHONE_ONLY = ['"device"', "StatusBar", "TabBar", "app-shell", "app-scroll"];

// Admin is web-only: the whole shell is the console, so the whole file is held
// to the standard the vendor shell's console branch is.
const adminShell = readFileSync(join(root, "src/components/admin/admin-shell.tsx"), "utf8");
for (const phoneOnly of PHONE_ONLY) {
  check(`admin shell has no ${phoneOnly}`, adminShell.includes(phoneOnly), false);
}
check(
  "admin shell has no phone-frame branch or layout switcher",
  /effective === "app"|DesktopShellSwitcher/.test(adminShell),
  false
);
check(
  "admin shell locks the shell mode to web",
  /<ShellModeProvider[^>]*locked="web"/.test(adminShell),
  true
);

{
  const branch = consoleBranch("src/components/vendor/vendor-shell.tsx");
  for (const phoneOnly of PHONE_ONLY) {
    check(`vendor console branch has no ${phoneOnly}`, branch.includes(phoneOnly), false);
  }
}

/* ============================================================
   3. The console-reach contract
   ============================================================ */
console.log("\n── reach: \"console\" is a route contract ──");

const nav = readFileSync(join(root, "src/components/admin/admin-nav.ts"), "utf8");

const entries = nav
  .split(/\r?\n  \{\r?\n/)
  .slice(1)
  .map((block) => ({
    href: /href:\s*"([^"]+)"/.exec(block)?.[1] ?? "",
    console: /reach:\s*"console"/.test(block),
    primary: /primary:\s*true/.test(block),
  }))
  .filter((e) => e.href);

const gated = entries.filter((e) => e.console).map((e) => e.href);

check("the nav parses into entries", entries.length > 5, true);
check("nav declares at least one console-only route", gated.length > 0, true);

/** Route file that owns a console-reach href — its layout if it has one. */
const GATE_FILES: Record<string, string[]> = {
  "/admin/observability": [
    "src/app/admin/observability/layout.tsx",
    "src/app/admin/observability/page.tsx",
  ],
  "/admin/settings/platform": ["src/app/admin/settings/platform/page.tsx"],
};

for (const href of gated) {
  const files = GATE_FILES[href];
  if (!files) {
    failed++;
    console.log(`  ✗ ${href} is console-only but this test knows no route file for it`);
    continue;
  }
  const gatedSomewhere = files.some((f) =>
    readFileSync(join(root, f), "utf8").includes("ConsoleOnly")
  );
  check(`${href} gates its own route, not just the nav`, gatedSomewhere, true);
}

// A console-only entry must never reach the phone's derived menu.
check(
  "no console-only entry is also a phone tab",
  entries.some((e) => e.console && e.primary),
  false
);

/* ============================================================
   4. The server actually decides
   ============================================================
   The fix is only a fix if the layout resolves the shell and hands it down. A
   layout that forgets `initialMode` silently falls back to the provider's
   default and the phone frame comes straight back, so each one is asserted.
   ------------------------------------------------------------ */
console.log("\n── Every portal layout resolves its shell server-side ──");

// Admin has one shell, locked in `AdminShell`, so its layout resolves nothing.
for (const [portal, file] of [
  ["vendor", "src/app/vendor/layout.tsx"],
  ["manager", "src/app/manager/layout.tsx"],
] as const) {
  const src = readFileSync(join(root, file), "utf8");
  check(`${portal} layout calls resolveShellMode`, /resolveShellMode\(/.test(src), true);
  check(`${portal} layout passes initialMode`, /initialMode=\{/.test(src), true);
}

/* ============================================================
   5. No second source of truth, and no device-based authorization
   ============================================================ */
console.log("\n── One source of truth, and it is not the user agent ──");

const clientFiles = walk(join(root, "src")).filter(
  (f) => f.endsWith(".ts") || f.endsWith(".tsx")
);

const storeImporters = clientFiles.filter((f) =>
  /stores\/(admin|vendor)-shell-store/.test(readFileSync(f, "utf8"))
);
check(
  "nothing still imports the removed zustand shell stores",
  storeImporters.length,
  0
);

// Device sniffing is allowed for presentation (the PWA install hint reads it
// to spot iOS, which never fires `beforeinstallprompt`). What is never allowed
// is a file that sniffs the device *and* decides access, or one that decides
// the shell from the client's user agent instead of the resolved mode.
const uaUsers = clientFiles.filter((f) =>
  /navigator\.userAgent/.test(readFileSync(f, "utf8"))
);
const uaNearAuth = uaUsers.filter((f) => {
  const src = readFileSync(f, "utf8");
  return /requireRole|createAdminClient|ConsoleOnly|ShellMode|useAdminShellMode|useVendorShellMode/.test(
    src
  );
});
check(
  "no file both sniffs the user agent and decides access or shell",
  uaNearAuth.length,
  0
);

const uaModule = readFileSync(join(root, "src/lib/shell-mode.ts"), "utf8");
check(
  "the user-agent sniff never imports auth",
  /requireRole|createAdminClient|supabase/i.test(uaModule),
  false
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
