/**
 * Reading a folder of photos as dish names.
 *
 * The library's whole value is that a photo is named the way a menu writes the
 * dish — the matcher in `./match` has nothing else to go on. So when an admin
 * drops a folder in, the filename IS the name, and this module is where that
 * translation happens: `chicken-biryani_02.jpg` → "Chicken Biryani", and the
 * folders it sat in become alternate names.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not invent a name for `IMG_2043.jpg`. A camera filename carries no
 *    dish in it, and a library full of "Img 2043" is worse than one photo
 *    short: it can never be matched, and it collides with the next camera dump.
 *    `looksUnnamed()` flags those so the UI asks a person.
 *  - It does not guess veg/non-veg. That is `vegFromTokens`' job, run on the
 *    server over the same keywords the matcher compares, so a bulk upload and a
 *    single one can never disagree.
 *
 * Pure and client-safe — the review list scores names as you edit them.
 */

/** Extensions the `food-library` bucket accepts. Everything else is skipped. */
const SUPPORTED = /\.(jpe?g|png|webp)$/i;

/** Files a folder carries that are not photos anyone meant to upload. */
const JUNK = /^(\.|__MACOSX|thumbs\.db$|desktop\.ini$)/i;

/**
 * Filenames a camera or a phone produced: a known prefix followed by a counter
 * or a timestamp. Matched as a whole name rather than word by word, because the
 * digits in "DSC00123" are not the digits in "Chicken 65".
 */
const CAMERA_SERIAL =
  /^(img|imag|dsc|dscn|dscf|pxl|mvimg|gopr|photo|image|picture|capture|scan|video|received|fb img|p)\s*\d{2,}/i;

/** Names a phone, a messaging app or a browser hands out wholesale. */
const CAMERA_NAME =
  /^(screenshot|screen shot|whatsapp (image|video)|signal|snapchat|inshot|untitled|download|unnamed|new image|no name)\b/i;

export function isSupportedImageName(name: string): boolean {
  return SUPPORTED.test(name) && !JUNK.test(name);
}

/**
 * The dish name a file is claiming to be.
 *
 * `01. Chicken-Biryani (2).JPG` → "Chicken Biryani". Ordering prefixes, copy
 * markers and separators go; digits inside the name stay, because "Chicken 65"
 * and "Chilli 65" are dishes and dropping the number merges them.
 */
export function titleFromFilename(filename: string): string {
  const base = filename
    .replace(/^.*[\\/]/, "")
    .replace(/\.[a-z0-9]+$/i, "");

  const words = base
    // Separators menus and exports use. A dot is one too, since "chicken.biryani"
    // only reaches here once the extension is already off.
    .replace(/[_\-.+]+/g, " ")
    // "(2)", "(copy)", "[1]" — a duplicate marker from a file manager.
    .replace(/[([]\s*(copy\s*)?(?:\d+\s*)?[)\]]\s*$/i, " ")
    .replace(/\bcopy\b\s*(?:\d+\s*)?$/i, " ")
    // A leading index: "01 chicken biryani", "3) dosa". Only when something
    // survives it — a file actually called "01.jpg" keeps its 01 and gets
    // flagged as unnamed instead.
    .replace(/^\s*\d{1,3}(?:\s*[).\-])?\s+(?=\S)/, "")
    // A trailing shot counter: "gobi manchurian 03", "dosa 2". Only the forms
    // no dish uses — a leading zero, or a lone digit. "Chicken 65" and
    // "Chilli 65" keep theirs, which is the whole point of not being greedy
    // here. Two photos that both reduce to "Gobi Manchurian" is the intended
    // outcome; the review list treats the second as a repeat.
    .replace(/\s(0\d{1,2}|\d)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!words) return "";

  return words
    .split(" ")
    .map((w) =>
      // Leave a word that already carries its own capitals alone — "McAloo",
      // "KFC", "65" — and title-case the rest.
      /[a-z]/.test(w) && /[A-Z]/.test(w.slice(1))
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(" ");
}

/**
 * Does this name need a person before it is worth storing?
 *
 * True for camera dumps, for names that are all digits, and for anything under
 * three letters. The UI holds these back rather than uploading them, because an
 * unnamed row in this library is invisible to the matcher forever.
 */
export function looksUnnamed(title: string): boolean {
  const t = title.trim();
  if (t.length < 3) return true;
  if (!/[a-z]{3}/i.test(t)) return true;
  return CAMERA_SERIAL.test(t) || CAMERA_NAME.test(t);
}

/**
 * The folders a photo sat in, as alternate names.
 *
 * `Menu photos/Biryani/Non Veg/chicken biryani.jpg` → ["Biryani", "Non Veg"].
 * The outermost folder is dropped: that is the one the operator picked, and it
 * is named for the batch ("october photos", "vendor pics"), not the food. The
 * rest are how the operator already organises dishes, and feeding them in as
 * tags is what lets a "Veg" folder mark a whole subtree vegetarian — tags reach
 * `keywordsFor`, and the veg flag is read off the keywords server-side.
 */
export function tagsFromRelativePath(relativePath: string): string[] {
  const parts = relativePath.split("/").filter(Boolean);
  // [root, ...dirs, file] — drop both ends.
  if (parts.length < 3) return [];
  return parts
    .slice(1, -1)
    .map((p) => p.replace(/[_\-]+/g, " ").trim())
    .filter((p) => p.length > 1 && !/^\d+$/.test(p));
}
