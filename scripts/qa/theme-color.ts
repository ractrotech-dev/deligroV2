/**
 * QA — the status-bar strip matches the page.
 *
 * A phone paints the strip behind its own status bar from
 * `<meta name="theme-color">` and from `color-scheme`, neither of which the
 * page's CSS touches. When those drift from `--bg` the app grows a band of a
 * different colour above its header — the failure this file exists to catch.
 *
 * The specific way it broke: `themeColor` was declared with
 * `prefers-color-scheme` media queries and `color-scheme` was `light dark`, so
 * both followed the *phone's OS setting*, while the app's theme follows
 * `data-theme` from localStorage and defaults to light on every device. The two
 * agreed only by luck. `lib/theme-colors.ts` is now the one source, and these
 * checks assert nothing has quietly grown a second one.
 *
 * Runs offline — it reads source files. No Supabase, no network, no server.
 *
 * Usage:
 *   npm run test:theme-color
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { THEME_BG } from "../../src/lib/theme-colors";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const css = read("src/app/globals.css");
const layout = read("src/app/layout.tsx");
const manifest = read("src/app/manifest.ts");
const store = read("src/stores/ui-store.ts");

/**
 * Comments stripped, for the checks that assert something is *absent*. Every
 * one of these files documents the bug in prose, and "prefers-color-scheme" or
 * "color-scheme: light dark" written in a comment explaining why they are gone
 * would otherwise fail the check that they are gone.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const cssCode = code(css);
const layoutCode = code(layout);

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * The `--bg` a theme actually resolves to, read out of globals.css rather than
 * assumed: `:root` for light, the `[data-theme="dark"]` block for dark. Only the
 * phone shells are in scope — `.console-theme` overrides `--bg` for the desktop
 * console, which has no status bar to match.
 */
function declaredBg(selector: string): string | null {
  const at = css.indexOf(selector);
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  if (open === -1 || close === -1) return null;
  const body = css.slice(open, close);
  return /--bg:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(body)?.[1]?.toLowerCase() ?? null;
}

console.log("\n═══ theme-color equals the page background ═══");

const lightBg = declaredBg("\n:root {");
const darkBg = declaredBg('\n[data-theme="dark"] {');

check(
  `light --bg in globals.css is ${THEME_BG.light}`,
  lightBg === THEME_BG.light,
  `globals.css says ${lightBg}`,
);
check(
  `dark --bg in globals.css is ${THEME_BG.dark}`,
  darkBg === THEME_BG.dark,
  `globals.css says ${darkBg}`,
);

console.log("\n═══ Nothing keys the browser's chrome to the OS ═══");

// The whole bug in one line. `prefers-color-scheme` is the phone's setting;
// the app's theme is `data-theme`. A theme-color keyed to the former is a
// promise the page cannot keep.
check(
  "the root layout does not key theme-color to prefers-color-scheme",
  !/prefers-color-scheme/.test(layoutCode),
  "viewport.themeColor is back on a media query",
);
check(
  "globals.css does not declare `color-scheme: light dark` outside @media print",
  !/color-scheme:\s*light dark/.test(cssCode),
  "the UA is choosing the appearance from the OS again",
);
check(
  "color-scheme is pinned per data-theme instead",
  /:root\[data-theme="light"\][\s\S]{0,120}color-scheme:\s*light/.test(cssCode) &&
    /:root\[data-theme="dark"\][\s\S]{0,120}color-scheme:\s*dark/.test(cssCode),
);

console.log("\n═══ Exactly one theme-color tag, kept in sync ═══");

// One tag, emitted by Next from a *static* viewport value. Two tags is the
// other way this breaks: the browser honours one of them and it may not be the
// one being kept in sync.
check(
  "viewport.themeColor is a static value taken from THEME_BG",
  /themeColor:\s*THEME_BG\.light,/.test(layoutCode),
  "a literal colour, or a media-query pair, is back in viewport",
);
check(
  "…and the layout does not also hand-render a second theme-color meta",
  !/<meta\s+name="theme-color"/.test(layoutCode),
  "two theme-color tags — the browser picks one and it may not be yours",
);
// Interpolated, not spelled out: a hex literal here is a fifth copy of a colour
// that already lives in three files, and it is the copy nobody would think to
// update.
check(
  "the pre-paint bootstrap rewrites the tag from THEME_BG",
  /meta\[name="theme-color"\]/.test(layoutCode) &&
    /\$\{THEME_BG\.dark\}/.test(layoutCode) &&
    /\$\{THEME_BG\.light\}/.test(layoutCode),
);
check(
  "the bootstrap has no hardcoded hex colour",
  !new RegExp(THEME_BG.dark + "|" + THEME_BG.light).test(layoutCode),
  "a literal colour in the bootstrap will outlive the next palette change",
);
check(
  "toggling the theme in-session rewrites it too",
  /meta\[name="theme-color"\]/.test(code(store)) && /THEME_BG\[theme\]/.test(code(store)),
  "ui-store applyTheme leaves the notch strip on the old colour",
);

console.log("\n═══ The manifest declares the boot theme ═══");

// An installed app reads the manifest once, so it cannot follow a runtime
// theme — it has to name the theme the app actually boots into, which is light.
check(
  "manifest theme_color and background_color come from THEME_BG.light",
  /theme_color:\s*THEME_BG\.light/.test(manifest) &&
    /background_color:\s*THEME_BG\.light/.test(manifest),
  "a hardcoded colour is back in the manifest",
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
