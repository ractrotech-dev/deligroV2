/**
 * QA — an ADD pill never paints over sticky chrome.
 *
 * `.bolt-add` is `position: absolute; bottom: -8px; z-index: 30` so the pill
 * overhangs the bottom edge of its 96px photo tile. That z-index is only safe
 * because it is meant to be TRAPPED: the photo wrapper carries `relative z-20`,
 * which opens a stacking context, so the pill's 30 is resolved *inside* a
 * z-20 box and can never out-rank sticky chrome sitting above it.
 *
 * The bug this file exists to catch: `search/dish-card.tsx` had `relative` on
 * that wrapper but no `z-20`. With no stacking context the pill's z-index: 30
 * escaped to compete globally, and the search screen's sticky header is z-20 —
 * so scrolling the dish list painted ADD pills on top of the search field and
 * the Dishes/Restaurants tabs. `restaurant/menu-item-row.tsx` never had the bug:
 * its wrapper is `relative z-20`, and `restaurant-menu.tsx` puts its sticky
 * category strip at z-30, which is the convention this asserts.
 *
 * The invariant, in one line:
 *
 *     photo wrapper (20)  <  sticky chrome (30),  pill trapped inside the wrapper
 *
 * Both halves are load-bearing and neither is sufficient alone. Drop the
 * wrapper's z-20 and the pill escapes. Leave the sticky at z-20 while the
 * wrapper is also z-20 and they tie — at which point DOM order decides, the
 * list comes after the header, and the pill wins anyway.
 *
 * Reads source rather than rendering: the failure is a CSS stacking rule across
 * two files, which is not observable in one component's markup. Runs offline.
 *
 * Usage:
 *   npm run test:layering
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

console.log("\nOverlay layering — ADD pill vs sticky chrome\n");

const css = read("src/app/globals.css");

/** The z-index declared on a CSS class block. */
function classZIndex(selector: string): number | null {
  const block = css.match(
    new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, "m")
  );
  if (!block) return null;
  const z = block[1].match(/z-index:\s*(\d+)/);
  return z ? Number(z[1]) : null;
}

const pillZ = classZIndex(".bolt-add");
const pillQtyZ = classZIndex(".bolt-add-qty");

check(
  ".bolt-add declares a z-index (the pill overhangs, so it needs one)",
  pillZ !== null,
  "no z-index found in the .bolt-add block"
);
check(
  ".bolt-add and .bolt-add-qty share one z-index",
  pillZ !== null && pillZ === pillQtyZ,
  `add=${pillZ}, qty=${pillQtyZ} — the pill and the stepper replace each other in the same slot, so a mismatch means one of them layers differently from the other`
);

// ---------------------------------------------------------------------------
// Every card that renders a pill must trap it in a stacking context.
// ---------------------------------------------------------------------------
const CARDS = [
  "src/components/search/dish-card.tsx",
  "src/components/restaurant/menu-item-row.tsx",
] as const;

const WRAPPER_Z = 20;

for (const file of CARDS) {
  const src = read(file);
  check(
    `${file}: renders a bolt-add pill (guard is pointed at the right file)`,
    src.includes("bolt-add"),
    "no bolt-add here — this list is stale, update CARDS"
  );

  // The wrapper is the element that holds PhotoTile; the pill is its sibling.
  const wrapper = src.match(/<div className="([^"]*\bsize-24\b[^"]*)"/);
  check(
    `${file}: photo wrapper found`,
    wrapper !== null,
    "no size-24 wrapper — the card's shape changed, update this check"
  );
  if (!wrapper) continue;

  const cls = wrapper[1];
  check(
    `${file}: photo wrapper is positioned (relative)`,
    /\brelative\b/.test(cls),
    `got: "${cls}"`
  );
  check(
    `${file}: photo wrapper opens a stacking context (z-${WRAPPER_Z}) so the pill cannot escape`,
    new RegExp(`\\bz-${WRAPPER_Z}\\b`).test(cls),
    `got: "${cls}" — without a z-index this wrapper is not a stacking context, so .bolt-add's z-index:${pillZ} competes with the whole page`
  );
}

// ---------------------------------------------------------------------------
// Sticky chrome on those screens must out-rank the wrapper.
// ---------------------------------------------------------------------------
const STICKY_SCREENS = [
  { file: "src/components/search/search-view.tsx", what: "search header" },
  { file: "src/components/restaurant/restaurant-menu.tsx", what: "category strip" },
] as const;

for (const { file, what } of STICKY_SCREENS) {
  const src = read(file);
  const stickies = [...src.matchAll(/className="([^"]*\bsticky\b[^"]*)"/g)];

  check(
    `${file}: has sticky chrome (${what})`,
    stickies.length > 0,
    "no sticky element found — update this check"
  );

  for (const m of stickies) {
    const cls = m[1];
    const z = cls.match(/\bz-(\d+)\b/);
    check(
      `${file}: sticky ${what} declares a z-index`,
      z !== null,
      `got: "${cls}"`
    );
    if (!z) continue;
    check(
      `${file}: sticky ${what} (z-${z[1]}) out-ranks the photo wrapper (z-${WRAPPER_Z})`,
      Number(z[1]) > WRAPPER_Z,
      `z-${z[1]} does not beat z-${WRAPPER_Z}. Equal values tie, and DOM order then puts the scrolling list on top — which is the bug.`
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
