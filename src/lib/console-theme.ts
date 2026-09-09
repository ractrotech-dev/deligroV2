/**
 * The ops console's own light/dark preference — one concept, one place.
 *
 * ## Why this is not `data-theme`
 *
 * `data-theme` is the *app's* theme: a global localStorage toggle written by
 * the bootstrap in `app/layout.tsx`, shared with the customer PWA, the driver
 * board and the manager screens, and defaulting to light. The console is
 * dark-first. Flipping that global default to make the console dark would
 * re-skin a food-delivery storefront as a side effect of an operations
 * decision, which is not a trade anyone would make on purpose.
 *
 * So the console carries its own preference, scoped to `.console-theme` and
 * stamped as `data-console` on the console div. The two are independent by
 * construction: an operator can run the console dark and the customer app
 * light in the same browser, because they are different questions.
 *
 * ## Why a cookie
 *
 * The same reason `shell-mode.ts` uses one, and it is worth restating because
 * getting it wrong here costs the same bug: only a cookie reaches the server,
 * and the server is where the first paint is decided. A localStorage
 * preference would leave the layout with no answer, so every console page
 * would server-render in the default palette and repaint after hydration —
 * a full-page flash from near-black to white, or the reverse, on every
 * navigation that misses the client cache.
 *
 * There is deliberately no bootstrap script and no `prefers-color-scheme`
 * fallback. The console is dark-first as a product decision, not as a
 * reflection of the operating system's setting; a desk running the OS in light
 * mode still gets the dark console until somebody says otherwise.
 *
 * Safe on both sides of the boundary. The server-only resolver lives in
 * `console-theme.server.ts`.
 */

export type ConsoleTheme = "dark" | "light";

/**
 * Whether the rail is collapsed to icons. Stored alongside the theme because
 * it is the same kind of thing — a workspace preference that has to be known
 * before the first byte of HTML, or the rail visibly snaps width on load.
 */
export type RailMode = "full" | "compact";

export const CONSOLE_THEME_COOKIE = "deligro-console-theme";
export const CONSOLE_RAIL_COOKIE = "deligro-console-rail";

/** A year. These are workspace choices, not session details. */
export const CONSOLE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The console is dark-first. Anything unreadable resolves to this. */
export const DEFAULT_CONSOLE_THEME: ConsoleTheme = "dark";
export const DEFAULT_RAIL_MODE: RailMode = "full";

/** Narrows an untrusted cookie value to the closed set. */
export function parseConsoleTheme(
  value: string | null | undefined
): ConsoleTheme | null {
  return value === "dark" || value === "light" ? value : null;
}

export function parseRailMode(
  value: string | null | undefined
): RailMode | null {
  return value === "full" || value === "compact" ? value : null;
}

/* ------------------------------------------------------------
   Browser side
   ------------------------------------------------------------
   Both writers are fire-and-forget: a browser that refuses cookies still gets
   the switch for the rest of the session, because the shell also holds the
   value in React state. It just won't survive a reload, which is the honest
   consequence of refusing the only storage that reaches the server.
   ------------------------------------------------------------ */

function writeCookie(name: string, value: string): void {
  try {
    document.cookie = `${name}=${value}; path=/; max-age=${CONSOLE_COOKIE_MAX_AGE}; samesite=lax`;
  } catch {
    /* private mode, blocked storage — the in-session switch still works */
  }
}

function readCookie(name: string): string | null {
  try {
    const hit = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : null;
  } catch {
    return null;
  }
}

export function writeConsoleTheme(theme: ConsoleTheme): void {
  writeCookie(CONSOLE_THEME_COOKIE, theme);
}

export function readConsoleTheme(): ConsoleTheme | null {
  return parseConsoleTheme(readCookie(CONSOLE_THEME_COOKIE));
}

export function writeRailMode(mode: RailMode): void {
  writeCookie(CONSOLE_RAIL_COOKIE, mode);
}

export function readRailMode(): RailMode | null {
  return parseRailMode(readCookie(CONSOLE_RAIL_COOKIE));
}
