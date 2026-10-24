/**
 * The browser half of error reporting.
 *
 * Runs in the client bundle, so it stays small and has no imports: it ships to
 * every visitor on every page.
 *
 * What it records (OBSERVABILITY_V2.md, phase 2):
 *
 *   * script errors and unhandled promise rejections (window listeners);
 *   * error screens (every error boundary calls `reportClientError` first);
 *   * signed-in "page not found" (`reportNotFound`, from the 404 page);
 *   * our own API answering 5xx (a watched `fetch`);
 *   * the **steps before** each error: the last 30 page changes, clicks (the
 *     words on the button, never what was typed) and requests (path, status,
 *     time; never the query string).
 *
 * What it drops, because each one was a flood of false alarms elsewhere:
 * requests cancelled on purpose, requests that failed while the phone was
 * offline, the tab was hidden or had just woken up, router prefetches,
 * "ResizeObserver loop", and errors thrown from browser extensions.
 *
 * A stale tab after a deploy ("Loading chunk … failed", "Failed to find Server
 * Action") is reported and then cured with one reload, at most once a minute so
 * it can never loop.
 *
 * Every line is wrapped: reporting an error must never produce one.
 */

const ENDPOINT = "/api/obs/client";

/** One report per distinct message per page load, and five at most. */
const seen = new Set<string>();
const MAX_PER_PAGE = 5;

type ClientErrorKind = "error" | "unhandledrejection" | "boundary" | "fetch" | "notfound";

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  /** The `digest` from a Next error boundary — the key that ties this to the server event. */
  digest?: string;
  componentStack?: string;
}

/* ---------- the steps before an error ---------- */

const MAX_STEPS = 30;
const steps: string[] = [];

function clock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function addStep(text: string): void {
  try {
    steps.push(`${clock()} ${text.slice(0, 120)}`);
    if (steps.length > MAX_STEPS) steps.shift();
  } catch {
    /* never throw from telemetry */
  }
}

/** The words a person would use for what they tapped: label, text, title, image alt. */
function describeTarget(el: Element): string | null {
  const target = el.closest("button, a, [role='button'], [role='tab'], [role='menuitem'], summary, label");
  if (!target) return null;
  const text =
    target.getAttribute("aria-label") ??
    (target as HTMLElement).innerText?.trim() ??
    target.getAttribute("title") ??
    target.querySelector("img")?.getAttribute("alt") ??
    "";
  const words = text.replace(/\s+/g, " ").trim().slice(0, 40);
  const href = target instanceof HTMLAnchorElement ? target.pathname : null;
  if (!words && !href) return null;
  return href ? `clicked "${words}" → ${href}` : `clicked "${words}"`;
}

/* ---------- noise ---------- */

/** When the tab or the network last came back; requests failing soon after are not errors. */
let wokeAt = 0;
const WAKE_GRACE_MS = 15_000;
let leaving = false;

function deviceAway(): boolean {
  return (
    leaving ||
    (typeof navigator !== "undefined" && navigator.onLine === false) ||
    (typeof document !== "undefined" && document.visibilityState === "hidden") ||
    Date.now() - wokeAt < WAKE_GRACE_MS
  );
}

const NETWORK_FAILURE = /^(failed to fetch|load failed|networkerror when attempting to fetch resource\.?|network request failed)$/i;
const STALE_DEPLOY = /loading chunk [\w-]+ failed|chunkloaderror|failed to fetch dynamically imported module|importing a module script failed|failed to find server action/i;
const IGNORED = /resizeobserver loop/i;
const EXTENSION = /(chrome|moz|safari(-web)?)-extension:\/\//i;

function isNoise(message: string, stack?: string): boolean {
  if (IGNORED.test(message)) return true;
  if (stack && EXTENSION.test(stack)) return true;
  if (/^aborterror\b|the (operation|user) (was )?abort/i.test(message)) return true;
  if (NETWORK_FAILURE.test(message.trim()) && deviceAway()) return true;
  return false;
}

/* ---------- sending ---------- */

function send(body: string): void {
  if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
  void fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
}

export function reportClientError(report: ClientErrorReport): void {
  try {
    if (typeof window === "undefined") return;
    if (report.kind !== "boundary" && report.kind !== "notfound" && isNoise(report.message, report.stack)) return;

    const key = `${report.kind}:${report.message.slice(0, 120)}`;
    if (seen.has(key) || seen.size >= MAX_PER_PAGE) return;
    seen.add(key);

    send(
      JSON.stringify({
        kind: report.kind,
        message: report.message.slice(0, 1000),
        stack: report.stack?.slice(0, 8000),
        digest: report.digest,
        componentStack: report.componentStack?.slice(0, 300),
        // Path only; the endpoint strips the query string as well.
        path: window.location.pathname,
        steps: [...steps, `${clock()} → ERROR`],
      }),
    );

    if (STALE_DEPLOY.test(report.message)) healStaleTab();
  } catch {
    /* reporting an error must never produce one */
  }
}

/** The 404 page calls this; the server keeps it only for signed-in people (robots get 404s all day). */
export function reportNotFound(): void {
  reportClientError({ kind: "notfound", message: "Page not found" });
}

/** A stale tab after a deploy is cured by one reload; never more than once a minute. */
function healStaleTab(): void {
  try {
    const KEY = "obs-heal-reload-at";
    const last = Number(sessionStorage.getItem(KEY) ?? "0");
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
    leaving = true;
    // Let the beacon leave first.
    setTimeout(() => window.location.reload(), 300);
  } catch {
    /* no storage, no reload: the report already went */
  }
}

function rejectionMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.name === "AbortError" ? `AbortError: ${reason.message}` : reason.message;
  if (typeof reason === "string") return reason;
  return "Unhandled promise rejection";
}

/* ---------- page speed (OBSERVABILITY_V2.md, phase 5) ---------- */

const TIMINGS_ENDPOINT = "/api/obs/timings";

interface Timing {
  path: string;
  kind: "first" | "move";
  visitorMs: number;
  serverMs: number | null;
}

const timings: Timing[] = [];

function flushTimings(): void {
  try {
    if (timings.length === 0) return;
    const body = JSON.stringify({ rows: timings.splice(0) });
    if (navigator.sendBeacon && navigator.sendBeacon(TIMINGS_ENDPOINT, new Blob([body], { type: "application/json" }))) return;
    void fetch(TIMINGS_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    /* never throw from telemetry */
  }
}

function queueTiming(t: Timing): void {
  // Over two minutes is a background tab, not a wait.
  if (!Number.isFinite(t.visitorMs) || t.visitorMs < 0 || t.visitorMs > 120_000) return;
  timings.push(t);
  if (timings.length >= 20) flushTimings();
}

/**
 * A full page load: the largest paint (or the load event where the browser
 * cannot say), and the server's share as time to first byte, which is left out
 * when the browser answered from its own cache: 0 ms would flatter the server.
 */
function measureFirstLoad(path: string): void {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as (PerformanceNavigationTiming & { deliveryType?: string }) | undefined;
    if (!nav) return;
    let lcp = 0;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) lcp = entry.startTime;
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      observer = null; // no LCP in this browser: the load event stands in
    }
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      observer?.disconnect();
      const visitor = lcp || nav.loadEventEnd || performance.now();
      const server = nav.responseStart - nav.requestStart;
      const cached = nav.deliveryType === "cache" || (nav.transferSize === 0 && nav.decodedBodySize > 0) || server < 1;
      queueTiming({ path, kind: "first", visitorMs: Math.round(visitor), serverMs: cached ? null : Math.round(server) });
    };
    window.addEventListener("pointerdown", settle, { once: true, capture: true });
    window.addEventListener("keydown", settle, { once: true, capture: true });
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && settle(), { once: true });
    if (document.readyState === "complete") setTimeout(settle, 3000);
    else window.addEventListener("load", () => setTimeout(settle, 3000), { once: true });
  } catch {
    /* never throw from telemetry */
  }
}

/** A move inside the app: from the click to the next paint, and the router's data request as the server's share. */
let pendingMove: { path: string; start: number; server: number | null; rsc: boolean; timer: number } | null = null;

function finishMove(): void {
  const move = pendingMove;
  if (!move) return;
  pendingMove = null;
  try {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => queueTiming({ path: move.path, kind: "move", visitorMs: Math.round(performance.now() - move.start), serverMs: move.server })),
    );
  } catch {
    /* never throw from telemetry */
  }
}

function startMove(path: string): void {
  try {
    if (pendingMove) window.clearTimeout(pendingMove.timer);
    // If no router data request starts soon, the page was already in hand.
    pendingMove = { path, start: performance.now(), server: null, rsc: false, timer: window.setTimeout(() => !pendingMove?.rsc && finishMove(), 300) };
  } catch {
    /* never throw from telemetry */
  }
}

/* ---------- watching our own requests ---------- */

let fetchWatched = false;
let firstLoadMeasured = false;

function watchFetch(): void {
  if (fetchWatched || typeof window.fetch !== "function") return;
  fetchWatched = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now();
    let path: string | null = null;
    let method = "GET";
    let routerData = false;
    try {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
      method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const prefetch = headers.has("next-router-prefetch");
      if (url.origin === window.location.origin && url.pathname !== ENDPOINT && url.pathname !== TIMINGS_ENDPOINT && !prefetch) path = url.pathname;
      // The router's own data request for the page being moved to.
      routerData = !prefetch && (headers.get("rsc") === "1" || url.searchParams.has("_rsc"));
      if (routerData && pendingMove) {
        pendingMove.rsc = true;
        window.clearTimeout(pendingMove.timer);
      }
    } catch {
      path = null;
    }

    const response = await original(input, init);
    try {
      if (routerData && pendingMove) {
        pendingMove.server = Math.round(performance.now() - started);
        finishMove();
      }
      if (path) {
        addStep(`${method} ${path} ${response.status} (${Math.round(performance.now() - started)}ms)`);
        if (response.status >= 500 && path.startsWith("/api/")) {
          reportClientError({ kind: "fetch", message: `Request failed: ${method} ${path} answered ${response.status}` });
        }
      }
    } catch {
      /* never throw from telemetry */
    }
    return response;
  };
}

/**
 * Attach the listeners, once, from the root layout. Returns a detach function
 * for the listeners (the fetch watch stays for the page's life).
 */
export function installClientErrorReporting(): () => void {
  if (typeof window === "undefined") return () => {};

  const onError = (event: ErrorEvent) => {
    // A cross-origin script gives "Script error." and nothing else.
    if (!event.message || event.message === "Script error.") return;
    reportClientError({
      kind: "error",
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : (event.filename ? `at ${event.filename}` : undefined),
    });
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    reportClientError({
      kind: "unhandledrejection",
      message: rejectionMessage(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };

  const onClick = (event: MouseEvent) => {
    try {
      const el = event.target instanceof Element ? event.target : null;
      // A click inside a typing box is never recorded: what people type is theirs.
      if (!el || el.closest("input, textarea, select, [contenteditable='true']")) return;
      const step = describeTarget(el);
      if (step) addStep(step);
    } catch {
      /* never throw from telemetry */
    }
  };

  const onWake = () => {
    if (document.visibilityState === "visible") wokeAt = Date.now();
  };
  const onOnline = () => {
    wokeAt = Date.now();
  };
  const onLeave = () => {
    leaving = true;
    flushTimings();
  };
  const onHidden = () => {
    if (document.visibilityState === "hidden") flushTimings();
  };

  let lastPath = window.location.pathname;
  const onNavigate = () => {
    try {
      const now = window.location.pathname;
      if (now !== lastPath) {
        lastPath = now;
        addStep(`opened ${now}`);
        startMove(now);
      }
    } catch {
      /* never throw from telemetry */
    }
  };
  // The app router changes pages with history.pushState; watch it.
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  history.pushState = (...args: Parameters<History["pushState"]>) => {
    push(...args);
    onNavigate();
  };
  history.replaceState = (...args: Parameters<History["replaceState"]>) => {
    replace(...args);
    onNavigate();
  };

  addStep(`opened ${lastPath}`);
  watchFetch();
  if (!firstLoadMeasured) {
    firstLoadMeasured = true;
    measureFirstLoad(lastPath);
  }
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("click", onClick, true);
  window.addEventListener("popstate", onNavigate);
  window.addEventListener("online", onOnline);
  window.addEventListener("pagehide", onLeave);
  document.addEventListener("visibilitychange", onWake);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("popstate", onNavigate);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("pagehide", onLeave);
    document.removeEventListener("visibilitychange", onWake);
    document.removeEventListener("visibilitychange", onHidden);
    history.pushState = push;
    history.replaceState = replace;
  };
}
