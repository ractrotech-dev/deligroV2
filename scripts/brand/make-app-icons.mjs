/**
 * Draws the launcher icons for the customer, partner and rider apps and writes
 * the five files each app's `flutter_launcher_icons` config reads:
 *
 *   icon.png             full square, for iOS and pre-Android-8 phones
 *   icon_background.png  adaptive background layer
 *   icon_foreground.png  adaptive foreground layer (glyph inside the safe zone)
 *   icon_monochrome.png  Android 13 themed icon
 *
 * One family: a heavy "D" with a small symbol of the app's role in its counter.
 * Customer: a map pin on orange. Partner: a shop front on green. Rider: a
 * forward chevron on black. Run from the repo root, then in each app:
 *   dart run flutter_launcher_icons
 *
 * Usage: node scripts/brand/make-app-icons.mjs
 */
import sharp from "sharp";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SIZE = 1024;

/** The "D": outer shape with the counter cut out (evenodd). */
const D_PATH =
  "M329 262 H482 A250 250 0 0 1 482 762 H329 Q293 762 293 726 V298 Q293 262 329 262 Z " +
  "M389 340 H482 A172 172 0 0 1 482 684 H389 Q371 684 371 666 V358 Q371 340 389 340 Z";

const SYMBOLS = {
  pin: (fill, hole) =>
    `<path fill="${fill}" fill-rule="evenodd" d="M508 604 C508 604 440 538 440 480 A68 68 0 0 1 576 480 C576 538 508 604 508 604 Z M508 480 m-24 0 a24 24 0 1 0 48 0 a24 24 0 1 0 -48 0 Z"/>`,
  shop: (fill, hole) =>
    `<g fill="${fill}">` +
    // awning with three scallops
    `<path d="M436 456 L458 418 H558 L580 456 Z"/>` +
    `<circle cx="460" cy="456" r="24"/><circle cx="508" cy="456" r="24"/><circle cx="556" cy="456" r="24"/>` +
    // shop body with a door
    `<path fill-rule="evenodd" d="M450 490 H566 V596 H450 Z M492 538 H524 V596 H492 Z"/>` +
    `</g>`,
  chevron: (fill) =>
    `<g fill="none" stroke="${fill}" stroke-width="38" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M450 444 L522 512 L450 580"/><path d="M526 444 L598 512 L526 580"/></g>`,
};

/** How much each symbol is enlarged to fill the counter without touching the D. */
const SYMBOL_SCALE = { pin: 1.3, shop: 1.08, chevron: 1.0 };

const APPS = {
  customer: {
    bgTop: "#FF8A3D",
    bgBottom: "#E85A00",
    letter: "#FFFFFF",
    symbol: "pin",
    symbolFill: "#FFFFFF",
    mono: true,
  },
  vendor: {
    bgTop: "#22A866",
    bgBottom: "#0F6B3C",
    letter: "#FFFFFF",
    symbol: "shop",
    symbolFill: "#FFFFFF",
    mono: true,
  },
  rider: {
    bgTop: "#23272E",
    bgBottom: "#0A0A0A",
    letter: "#FFFFFF",
    symbol: "chevron",
    symbolFill: "#F2680C",
    mono: true,
  },
};

const svg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${inner}</svg>`;

/** The glyph, scaled about the centre of the canvas. */
function glyph(app, scale, { letter = app.letter, symbolFill = app.symbolFill } = {}) {
  return (
    `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)">` +
    `<path fill="${letter}" fill-rule="evenodd" d="${D_PATH}"/>` +
    // The symbol sits in the counter, a little right of the stem and scaled up to fill it.
    `<g transform="translate(522 512) scale(${SYMBOL_SCALE[app.symbol]}) translate(-512 -512)">${SYMBOLS[app.symbol](symbolFill)}</g>` +
    `</g>`
  );
}

const background = (app) =>
  `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="${app.bgTop}"/><stop offset="1" stop-color="${app.bgBottom}"/>` +
  `</linearGradient></defs><rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/>`;

async function write(file, markup) {
  await sharp(Buffer.from(svg(markup))).png().toFile(file);
}

for (const [name, app] of Object.entries(APPS)) {
  const dir = join(ROOT, "apps", name, "assets", "brand");
  // Legacy / iOS: the glyph can be big, the platform crops to a rounded square.
  await write(join(dir, "icon.png"), background(app) + glyph(app, 1.18));
  await write(join(dir, "icon_background.png"), background(app));
  // Adaptive: the launcher masks to a circle or squircle and keeps ~61% of the
  // canvas, so the glyph is pulled in to stay inside that.
  await write(join(dir, "icon_foreground.png"), glyph(app, 0.9));
  // Themed icon: one flat colour, the launcher tints it.
  await write(join(dir, "icon_monochrome.png"), glyph(app, 0.9, { letter: "#FFFFFF", symbolFill: "#FFFFFF" }));
  console.log(`${name}: wrote 4 icon files in ${dir}`);
}
