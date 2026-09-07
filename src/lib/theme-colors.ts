/**
 * The one place the app's two page-background colours are written down.
 *
 * A phone tints the strip behind its own status bar from `<meta name="theme-color">`,
 * not from anything the page paints. So that tag has to carry the *exact* colour
 * `--bg` resolves to under the active theme, or the notch strip reads as a band
 * of a different colour sitting on top of the screen.
 *
 * This existed in four places that disagreed: `--bg` in globals.css, a
 * `prefers-color-scheme`-keyed `themeColor` in the root layout (light `#ffffff`
 * against a `#f4f3f0` page — a seam even when the schemes agreed), a hardcoded
 * dark `theme_color` in the manifest, and `color-scheme: light dark`. Three of
 * the four followed the OS or a constant while the app's real theme follows
 * `data-theme` from localStorage, which defaults to light on every device. An
 * OS-dark phone running the app in light mode therefore got a dark status strip
 * above a light page.
 *
 * `scripts/qa/theme-color.ts` asserts these still equal the `--bg` declarations
 * in globals.css, so the two cannot drift apart again.
 */
export const THEME_BG = {
  light: "#f4f3f0",
  dark: "#0f1215",
} as const;

export type ThemeName = keyof typeof THEME_BG;
