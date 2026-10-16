/**
 * Which shell a portal is being viewed in — the one concept, in one place.
 *
 * Admin and vendor both run two top-level shells: the ops console (desktop) and
 * the phone frame (a handset, or a preview of one on a desktop). Everything
 * about *which* is on screen lives here so the server, the client and the CSS
 * cannot disagree.
 *
 * The preference is carried in a **cookie**, not localStorage. That is the
 * whole point: only a cookie reaches the server, and the server is where the
 * decision has to be made. When it was client-only, `admin/layout.tsx` had no
 * way to know, so every console page server-rendered as the 402px phone frame —
 * iPhone bezel, Dynamic Island and all — and swapped to the console a paint
 * later. The web admin was, briefly but literally, the phone app.
 *
 * This module is safe on both sides of the boundary. The server-only resolver
 * lives in `shell-mode.server.ts`.
 */

export type ShellMode = "app" | "web";

/** Cookie *and* legacy localStorage key, one per portal. */
export const SHELL_COOKIE = {
  admin: "deligro-admin-shell",
  vendor: "deligro-vendor-shell",
  manager: "deligro-manager-shell",
} as const;

export type ShellPortal = keyof typeof SHELL_COOKIE;

/** A year. The preference is a workspace choice, not a session detail. */
const SHELL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Narrows an untrusted string (cookie, localStorage) to the closed set. */
export function parseShellMode(value: string | null | undefined): ShellMode | null {
  return value === "app" || value === "web" ? value : null;
}

/**
 * Phone-shaped user agents, for the *first* request from a device that has no
 * cookie yet. Presentation only — it picks a layout and nothing else. No
 * authorization anywhere in this codebase reads it (AGENTS.md: device detection
 * is not authorization), and one request later the cookie written from
 * `matchMedia` supersedes it.
 *
 * Deliberately narrow. iPadOS reports a Macintosh UA and is wider than the
 * 480px breakpoint anyway, so tablets fall through to the console — which is
 * the correct answer for them.
 */
const PHONE_UA = /iPhone|iPod|Android.+Mobile|Windows Phone|BlackBerry|Opera Mini|IEMobile/i;

export function shellModeFromUserAgent(ua: string | null | undefined): ShellMode {
  return ua && PHONE_UA.test(ua) ? "app" : "web";
}

/**
 * Write the preference where the *next* server render will find it.
 * Client-side only; `document` is the point of the exercise.
 */
export function writeShellCookie(portal: ShellPortal, mode: ShellMode): void {
  try {
    document.cookie = `${SHELL_COOKIE[portal]}=${mode}; path=/; max-age=${SHELL_COOKIE_MAX_AGE}; samesite=lax`;
  } catch {
    /* a browser that refuses cookies still gets the client-side switch */
  }
}

/** Reads the cookie in the browser, for the one-time migration off localStorage. */
export function readShellCookie(portal: ShellPortal): ShellMode | null {
  try {
    const name = SHELL_COOKIE[portal];
    const hit = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${name}=`));
    return parseShellMode(hit?.slice(name.length + 1));
  } catch {
    return null;
  }
}
