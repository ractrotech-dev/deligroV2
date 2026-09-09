import "server-only";

import { cookies } from "next/headers";
import {
  CONSOLE_RAIL_COOKIE,
  CONSOLE_THEME_COOKIE,
  DEFAULT_CONSOLE_THEME,
  DEFAULT_RAIL_MODE,
  parseConsoleTheme,
  parseRailMode,
  type ConsoleTheme,
  type RailMode,
} from "@/lib/console-theme";

/** One request's worth of console chrome preferences. */
export interface ConsolePrefs {
  theme: ConsoleTheme;
  rail: RailMode;
}

/**
 * The console's palette and rail width, decided before a byte of HTML is
 * written — the same discipline `resolveShellMode` applies to the shell, and
 * for the same reason. Read once in the portal layout and handed to the shell
 * as props, so it is per-request by construction and cannot leak one
 * operator's preference into another's render.
 *
 * Both fall back to the product default rather than to the last thing seen: an
 * unreadable or absent cookie means "this operator has not chosen", and the
 * console is dark-first with a full rail until they do.
 */
export async function resolveConsolePrefs(): Promise<ConsolePrefs> {
  const store = await cookies();

  return {
    theme:
      parseConsoleTheme(store.get(CONSOLE_THEME_COOKIE)?.value) ??
      DEFAULT_CONSOLE_THEME,
    rail:
      parseRailMode(store.get(CONSOLE_RAIL_COOKIE)?.value) ?? DEFAULT_RAIL_MODE,
  };
}
