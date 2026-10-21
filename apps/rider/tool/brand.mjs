// Renders the Rider app icon (the customer courier drawing on ink instead of amber,
// so the two apps tell apart on one phone), the splash rider art and the website
// splash wordmark.
//   node apps/rider/tool/brand.mjs   (from the repo root; uses the site's sharp)
// then, in apps/rider:
//   dart run flutter_launcher_icons && dart run flutter_native_splash:create
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP, "assets", "brand");
const REPO = join(APP, "..", "..");
// The rider art. The brief named Resources/3D Icons.../"Electric Cycle3DIcon 10.svg",
// but every file in that folder is a food icon (10 is a tray of doughnuts), so this
// uses the website's own rider illustration (courier with the delivery scooter,
// public/pickdrop-rider.webp). RIDER_ART overrides the source path.
const RIDER_ART = process.env.RIDER_ART ?? join(REPO, "public", "pickdrop-rider.webp");

// The website splash fill (src/app/globals.css .splash).
const AMBER = "#E59A01";
const INK = "#0A0A0A";

// The courier from Resources/deligro-icon.svg, re-centred on (0,0).
// `accent` paints the speed lines, streak, head and parcel; `body` the runner.
function courier({ accent, body, lines = accent }) {
  return `
  <g transform="translate(-68 -63)">
    <g stroke="${lines}" stroke-width="15" stroke-linecap="round">
      <line x1="-40" y1="40" x2="46" y2="40"/>
      <line x1="-54" y1="78" x2="18" y2="78"/>
      <line x1="-26" y1="116" x2="56" y2="116"/>
    </g>
    <path d="M46 24 L104 24 L72 84 L112 84 L42 154 L70 92 L36 92 Z" fill="${accent}"/>
    <circle cx="104" cy="-6" r="24" fill="${accent}"/>
    <rect x="132" y="-26" width="50" height="50" rx="7" transform="rotate(14 157 -1)" fill="${accent}"/>
    <path d="M104 22 c 20 -4 37 7 48 22 l -15 37 l 28 33 l -22 17 l -33 -37 c -6 -9 -9 -20 -4 -31
             l -20 44 l 4 44 l -24 2 l -6 -55 c -2 -17 6 -33 22 -41 l 11 -7 Z" fill="${body}"/>
    <path d="M104 82 l 33 9 l 24 44 l -22 9 l -26 -42 Z" fill="${body}"/>
  </g>`;
}

// On ink the runner turns amber (ink would vanish); the rest stays white.
const onInk = { accent: "#FFFFFF", body: AMBER, lines: "rgba(255,255,255,.88)" };

const inkFill = (size) => `<rect width="${size}" height="${size}" fill="${INK}"/>`;

const svg = (size, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${inner}</svg>`;

// Courier art is ~244 units wide; `scale` sets how much of the canvas it spans.
const art = (size, scale, colors) =>
  `<g transform="translate(${size / 2} ${size / 2}) scale(${scale})">${courier(colors)}</g>`;

const files = {
  // Legacy/iOS icon: full-bleed tile, no alpha (the stores and launchers round it).
  "icon.png": svg(1024, inkFill(1024) + art(1024, 2.6, onInk)),
  // Android adaptive layers. Art stays inside the 66/108 safe zone.
  "icon_background.png": svg(1024, inkFill(1024)),
  "icon_foreground.png": svg(1024, art(1024, 2.1, onInk)),
  // Android 13 themed icons: one colour, the launcher tints it.
  "icon_monochrome.png": svg(1024, art(1024, 2.1, { accent: "#FFFFFF", body: "#FFFFFF" })),
  // Native splash is plain amber; lib/widgets/splash.dart draws the website
  // splash over it. Android 12+ shows the launcher icon unless given an image.
  "splash_blank.png": svg(1152, ""),
  // Login header and in-app use: rounded ink tile.
  "mark.png": svg(512, `<clipPath id="r"><rect width="512" height="512" rx="128"/></clipPath>
    <g clip-path="url(#r)">${inkFill(512)}${art(512, 1.45, onInk)}</g>`),
};

mkdirSync(join(OUT, "src"), { recursive: true });
for (const [name, source] of Object.entries(files)) {
  writeFileSync(join(OUT, "src", name.replace(".png", ".svg")), source);
  const img = sharp(Buffer.from(source));
  await (name === "icon.png" ? img.flatten({ background: INK }) : img).png().toFile(join(OUT, name));
}

// Splash artwork for lib/widgets/splash.dart. The DELIGRO wordmark is the website's,
// as JPEG: the WebP original did not render in the release app (checked on an
// Android 14 emulator). The rider art is PNG (never WebP).
await sharp(join(REPO, "public", "splash-logo.webp")).jpeg({ quality: 90 }).toFile(join(OUT, "splash-logo.jpg"));
await sharp(RIDER_ART).resize({ width: 1024 }).png({ compressionLevel: 9 }).toFile(join(OUT, "rider.png"));

console.log("brand assets written to", OUT);
