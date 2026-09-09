"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import {
  DEFAULT_CONSOLE_THEME,
  DEFAULT_RAIL_MODE,
  writeConsoleTheme,
  writeRailMode,
  type ConsoleTheme,
  type RailMode,
} from "@/lib/console-theme";
import { cn } from "@/lib/utils/cn";

/**
 * The console's own chrome preferences — palette and rail width — shared by the
 * shell that renders them and the controls that change them.
 *
 * ## Why plain state rather than an external store
 *
 * `ShellModeProvider` needs `useSyncExternalStore` because its cookie is also
 * written from outside React (the legacy localStorage migration) and because a
 * media query can override it after mount. Neither is true here: this provider
 * is the only writer, and there is nothing to re-measure once mounted. So the
 * server's answer seeds `useState` and the hydration render matches the HTML by
 * construction.
 *
 * The cookie is still written on every change, because that is what the *next*
 * server render reads. React state is the truth for this session; the cookie is
 * the truth for the next one.
 *
 * ## Why this is separate from `data-theme`
 *
 * See `lib/console-theme.ts`. In short: `data-theme` belongs to the customer
 * app, is light by default, and lives in localStorage where no server render
 * can see it. The console is dark-first and needs its answer before the first
 * byte of HTML.
 */

interface ConsoleChromeValue {
  theme: ConsoleTheme;
  rail: RailMode;
  toggleTheme: () => void;
  toggleRail: () => void;
}

/**
 * What a control rendered outside the provider sees. Frozen rather than an
 * inline literal, so a consumer with no provider above it does not re-render
 * against a fresh object every pass.
 */
const NO_CHROME: ConsoleChromeValue = Object.freeze({
  theme: DEFAULT_CONSOLE_THEME,
  rail: DEFAULT_RAIL_MODE,
  toggleTheme: () => {},
  toggleRail: () => {},
});

const ConsoleChromeContext = createContext<ConsoleChromeValue | null>(null);

export function ConsoleChromeProvider({
  initialTheme,
  initialRail,
  children,
}: {
  initialTheme: ConsoleTheme;
  initialRail: RailMode;
  children: React.ReactNode;
}) {
  const [theme, setTheme] = useState<ConsoleTheme>(initialTheme);
  const [rail, setRail] = useState<RailMode>(initialRail);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: ConsoleTheme = prev === "dark" ? "light" : "dark";
      writeConsoleTheme(next);
      return next;
    });
  }, []);

  const toggleRail = useCallback(() => {
    setRail((prev) => {
      const next: RailMode = prev === "full" ? "compact" : "full";
      writeRailMode(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ theme, rail, toggleTheme, toggleRail }),
    [theme, rail, toggleTheme, toggleRail]
  );

  return (
    <ConsoleChromeContext.Provider value={value}>
      {children}
    </ConsoleChromeContext.Provider>
  );
}

export function useConsoleChrome(): ConsoleChromeValue {
  return useContext(ConsoleChromeContext) ?? NO_CHROME;
}

/* ============================================================
   Controls
   ============================================================ */

/**
 * The palette switch. Says what it will do, not what is on screen — a moon on
 * a dark console is ambiguous about which of the two it means, and this one is
 * pressed rarely enough that the label has to carry it.
 */
export function ConsoleThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useConsoleChrome();
  const toLight = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={toLight ? "Switch to the light console" : "Switch to the dark console"}
      title={toLight ? "Light console" : "Dark console"}
      className={cn(
        "press grid size-8 place-items-center rounded-[var(--c-r)] text-muted transition-colors hover:bg-[var(--c-hover)] hover:text-ink",
        className
      )}
    >
      {toLight ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

/**
 * Collapse the rail to icons and back.
 *
 * Lives in the rail's own foot rather than the top bar: it changes the rail, so
 * it belongs to the rail, and putting it in the header would leave a collapsed
 * rail with no visible way back that is anywhere near it.
 */
export function RailToggle({ className }: { className?: string }) {
  const { rail, toggleRail } = useConsoleChrome();
  const compact = rail === "compact";
  const Icon = compact ? PanelLeftOpen : PanelLeftClose;

  return (
    <button
      type="button"
      onClick={toggleRail}
      aria-label={compact ? "Expand the navigation" : "Collapse the navigation"}
      title={compact ? "Expand" : "Collapse"}
      aria-pressed={compact}
      className={cn(
        "press grid size-8 shrink-0 place-items-center rounded-[7px] text-[var(--sb-meta)] transition-colors hover:bg-[var(--sb-hover)] hover:text-white",
        className
      )}
    >
      <Icon className="size-[15px]" strokeWidth={1.7} />
    </button>
  );
}
