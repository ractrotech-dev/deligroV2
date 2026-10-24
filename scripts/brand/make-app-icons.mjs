/**
 * Builds the launcher icons and the in-app logo for the customer, partner and
 * rider apps from the glossy Deligro logo
 * (apps/customer/assets/brand/src/deligro-logo-glossy.png: the "D" with its
 * speed lines and the DELIGRO name, on a transparent background). The tagline
 * under the name ("ALL IN ONE DELIVERY APP") is cut off: the icon is the D and
 * the name only.
 *
 * Writes, for each app, the files its `flutter_launcher_icons` config reads and
 * the logo the sign-in screen shows:
 *
 *   icon.png             full square, for iOS and pre-Android-8 phones
 *   icon_background.png  adaptive background layer (dark, so the cream and orange read)
 *   icon_foreground.png  adaptive foreground layer (the logo inside the safe zone)
 *   icon_monochrome.png  Android 13 themed icon (the logo's shape, one colour)
 *   mark.png             512 px, the logo on its background, for the app screens
 *
 * Run from the repo root, then in each app: dart run flutter_launcher_icons
 * Usage: node scripts/brand/make-app-icons.mjs
 */
import sharp from "sharp";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SOURCE = join(ROOT, "apps", "customer", "assets", "brand", "src", "deligro-logo-glossy.png");
const SIZE = 1024;
const APPS = ["customer", "vendor", "rider"];

/** Source rows above this hold the D and the name; the tagline starts below it. */
const NAME_BOTTOM = 1088;

/** Share of the canvas the logo's longer side takes: generous on the full icon, inside the safe zone on the adaptive layer. */
const FULL_SCALE = 0.84;
const ADAPTIVE_SCALE = 0.6;

const backgroundSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<defs><radialGradient id="g" cx="0.5" cy="0.42" r="0.75">` +
    `<stop offset="0" stop-color="#3A2214"/><stop offset="0.6" stop-color="#1C110A"/><stop offset="1" stop-color="#0C0705"/>` +
    `</radialGradient></defs><rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/></svg>`,
);

/** The D and the name, trimmed to their visible pixels. */
const meta0 = await sharp(SOURCE).metadata();
const cropped = await sharp(SOURCE).extract({ left: 0, top: 0, width: meta0.width, height: Math.min(NAME_BOTTOM, meta0.height) }).png().toBuffer();
const logo = await sharp(cropped).trim({ threshold: 10 }).png().toBuffer();

async function logoAt(scale) {
  const box = Math.round(SIZE * scale);
  return sharp(logo).resize(box, box, { fit: "inside" }).png().toBuffer();
}

/** The logo (or another image) centred on a transparent square. */
async function onCanvas(scale, input) {
  const img = input ?? (await logoAt(scale));
  return sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: img, gravity: "centre" }])
    .png()
    .toBuffer();
}

const background = await sharp(backgroundSvg).png().toBuffer();
const full = await sharp(background).composite([{ input: await onCanvas(FULL_SCALE) }]).png().toBuffer();
const foreground = await onCanvas(ADAPTIVE_SCALE);

// Themed icon: the logo's shape in white; the launcher tints it.
const shape = await sharp(await logoAt(ADAPTIVE_SCALE)).extractChannel("alpha").toBuffer();
const shapeMeta = await sharp(shape).metadata();
const white = await sharp({ create: { width: shapeMeta.width, height: shapeMeta.height, channels: 3, background: "#ffffff" } })
  .joinChannel(shape)
  .png()
  .toBuffer();
const monochrome = await onCanvas(ADAPTIVE_SCALE, white);

const mark = await sharp(full).resize(512, 512).png().toBuffer();

for (const app of APPS) {
  const dir = join(ROOT, "apps", app, "assets", "brand");
  await sharp(full).toFile(join(dir, "icon.png"));
  await sharp(background).toFile(join(dir, "icon_background.png"));
  await sharp(foreground).toFile(join(dir, "icon_foreground.png"));
  await sharp(monochrome).toFile(join(dir, "icon_monochrome.png"));
  await sharp(mark).toFile(join(dir, "mark.png"));
  console.log(`${app}: wrote icon files and mark.png in ${dir}`);
}
