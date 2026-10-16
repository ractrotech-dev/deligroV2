"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import {
  SHELL_COOKIE,
  parseShellMode,
  readShellCookie,
  writeShellCookie,
  type ShellMode,
  type ShellPortal,
} from "@/lib/shell-mode";

interface ShellModeValue {
  /** The shell actually on screen. This is the one anything rendering reads. */
  mode: ShellMode;
  /** The stored preference, which a handset overrides but does not erase. */
  preference: ShellMode;
  setPreference: (mode: ShellMode) => void;
  /** False for the hydration render; true once mounted in a browser. */
  hydrated: boolean;
}

const ShellModeContext = createContext<ShellModeValue | null>(null);

/**
 * What anything rendered outside a shell sees. A frozen constant rather than an
 * inline literal, so a consumer with no provider above it does not re-render on
 * every pass against a fresh object.
 */
const NO_SHELL: ShellModeValue = Object.freeze({
  mode: "app",
  preference: "app",
  setPreference: () => {},
  hydrated: false,
});

/* ============================================================
   The preference, as an external store
   ============================================================
   The cookie *is* the store — it is the copy the server reads, so keeping a
   second one in React state would mean two answers to one question. This is the
   subscription that lets React re-read it when the switcher writes.

   `useSyncExternalStore` rather than state-plus-effect for the same reason
   `useIsDesktop` uses it: the hydration render must return the server's answer
   exactly, and the corrected value must arrive as a normal re-render rather
   than a cascading setState inside an effect.
   ------------------------------------------------------------ */

type Listener = () => void;
const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Mount detection, for controls that must not look live before hydration. */
const alwaysTrue = () => true;
const alwaysFalse = () => false;

/**
 * One source of truth for "which shell am I in", shared by the chrome and by
 * every `ConsoleOnly` deep in the page.
 *
 * ## Why this replaced the zustand shell stores
 *
 * They were module-global, so they could not be seeded per request without
 * leaking one operator's preference into another's render. That is why the
 * server had no answer at all and resolved to `"app"` for everyone: the admin
 * console was server-rendered inside a 402px iPhone mock, on every request,
 * and only became the console after hydration. The value now arrives as a prop
 * from the server layout — per-request by construction — and this context
 * carries it down. The stores are deleted rather than kept alongside; two
 * places answering one question is how a shell ends up disagreeing with its own
 * pages.
 *
 * ## The two renders
 *
 * - **Hydration render**: `mode` is exactly the server's answer, so the client
 *   tree matches the HTML. No mismatch, no flash of the wrong shell.
 * - **After mount**: the viewport is measured. A real handset is forced to
 *   `"app"` whatever the cookie says — the console is not something a 390px
 *   screen can cope with — while the cookie keeps the operator's console
 *   preference intact for when they are back at a desk.
 *
 * Fails closed in the sense that matters (AGENTS.md, "never fail open"): a
 * device that cannot be measured, or a page rendered outside this provider,
 * resolves to the phone frame — *fewer* tools plus an explanation, never a
 * console-grade tool dropped into a handset.
 */
export function ShellModeProvider({
  portal,
  initialMode,
  locked,
  children,
}: Readonly<{
  portal: ShellPortal;
  initialMode: ShellMode;
  /**
   * Pins the shell for a portal that has only one (admin is web-only). The
   * viewport, the cookie and the user agent are all ignored, and no cookie is
   * written, so a stale `app` preference from before the lock cannot matter.
   */
  locked?: ShellMode;
  children: React.ReactNode;
}>) {
  const isDesktop = useIsDesktop();

  const preference = useSyncExternalStore(
    subscribe,
    () => readShellCookie(portal) ?? initialMode,
    () => initialMode
  );

  const hydrated = useSyncExternalStore(subscribe, alwaysTrue, alwaysFalse);

  useEffect(() => {
    if (locked) return;
    // One-time migration off the pre-cookie storage. localStorage never reached
    // the server, which is the whole bug; anything found there moves to the
    // cookie and the old key is dropped, so there is one place to look.
    try {
      const legacy = parseShellMode(localStorage.getItem(SHELL_COOKIE[portal]));
      if (legacy) {
        localStorage.removeItem(SHELL_COOKIE[portal]);
        writeShellCookie(portal, legacy);
        emit();
        return;
      }
    } catch {
      /* private mode, blocked storage — the cookie still works */
    }

    // A first visit was resolved from the user agent. Record the answer so the
    // next request is served from the cookie instead of being guessed again.
    if (!readShellCookie(portal)) writeShellCookie(portal, initialMode);
  }, [portal, initialMode, locked]);

  const setPreference = useCallback(
    (next: ShellMode) => {
      if (locked) return;
      writeShellCookie(portal, next);
      emit();
    },
    [portal, locked]
  );

  let mode: ShellMode = initialMode;
  if (locked) mode = locked;
  else if (hydrated) mode = isDesktop && preference !== "app" ? "web" : "app";

  const value = useMemo(
    () => ({
      mode,
      preference: locked ?? preference,
      setPreference,
      hydrated,
    }),
    [mode, locked, preference, setPreference, hydrated]
  );

  return (
    <ShellModeContext.Provider value={value}>
      {children}
    </ShellModeContext.Provider>
  );
}

/**
 * The full state, for the shells that own the layout switch.
 *
 * Outside a provider it reports the phone frame and a no-op setter rather than
 * throwing: `ConsoleOnly` is used on pages a future portal might render without
 * this chrome, and the safe answer there is "fewer tools".
 */
export function useShellModeState(): ShellModeValue {
  return useContext(ShellModeContext) ?? NO_SHELL;
}
