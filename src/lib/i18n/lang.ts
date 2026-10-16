/**
 * The customer app's language: English or Hindi, one at a time.
 *
 * It used to print both side by side ("Saved addresses · सेव पते"), which made
 * every row twice as long and harder to read in either language. Now the
 * customer picks one (Profile → Language, or the switch on the login screen)
 * and it is kept in a cookie, so server-rendered pages read the same choice
 * the client does — no English flash before the Hindi arrives.
 *
 * Text stays next to the code that shows it: `t("Home", "होम")`. There are
 * not enough strings to justify a key-based catalogue, and a pair can't drift
 * out of step with the screen it belongs to.
 *
 * Only the customer app is translated. The vendor, rider, manager and admin
 * screens keep their bilingual labels.
 */
export type Lang = "en" | "hi";

/** An English/Hindi pair, for text that lives in data rather than markup. */
export type Bi = { en: string; hi: string };

export type T = (en: string, hi: string) => string;

/**
 * Hindi is switched OFF for now (owner's call, 3 Oct 2026): the app is
 * English only and the language switch is hidden. Every screen still carries
 * its Hindi text, so turning this back to `true` (and un-commenting the
 * switch in profile/page.tsx) brings it back.
 */
export const HINDI_ENABLED = false;

export const LANG_COOKIE = "deligro-lang";
export const DEFAULT_LANG: Lang = "en";

/** One year — a language choice is not something people redo. */
const MAX_AGE = 60 * 60 * 24 * 365;

export function parseLang(value: string | null | undefined): Lang {
  if (!HINDI_ENABLED) return "en";
  if (value === "hi" || value === "en") return value;
  return DEFAULT_LANG;
}

export function translator(lang: Lang): T {
  return HINDI_ENABLED && lang === "hi" ? (_en, hi) => hi : (en) => en;
}

export function pick(lang: Lang, text: Bi): string {
  return HINDI_ENABLED && lang === "hi" ? text.hi : text.en;
}

/** The `document.cookie` string that stores a choice. */
export function langCookie(lang: Lang): string {
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`;
}
