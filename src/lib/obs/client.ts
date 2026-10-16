/**
 * The browser half of error reporting.
 *
 * Runs in the client bundle, so it is deliberately tiny and has no imports: it
 * ships to every visitor on every page, and an observability tool that costs a
 * customer 30KB on a 3G connection has made the product worse in order to watch
 * it.
 *
 * What it does NOT do, on purpose:
 *
 *   * No batching, no queue, no retry. `sendBeacon` already survives the page
 *     being closed, which is the case that matters — a crash is often the last
 *     thing a page does.
 *   * No breadcrumbs, no session replay, no user identification. The server
 *     takes the actor from the session cookie; the browser is not asked and is
 *     not believed.
 *   * No context beyond the path and the stack. Everything else the endpoint
 *     would need is either derivable server-side or not worth the bytes.
 *
 * Stacks are minified — there is no source-map upload, because there is no
 * Sentry (see the decision log in `docs/OBSERVABILITY_PLAN.md` §12). That is a
 * real limit: these group and count reliably, and they locate only sometimes.
 */

const ENDPOINT = "/api/obs/client";

/**
 * One report per distinct message per page load.
 *
 * A React render loop can throw the same error hundreds of times a second, and
 * without this the first broken page a visitor opens would spend the endpoint's
 * whole rate limit in under a second — after which nothing else that page did
 * wrong could be reported at all.
 */
const seen = new Set<string>();
const MAX_PER_PAGE = 5;

type ClientErrorKind = "error" | "unhandledrejection" | "boundary";

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  /** The `digest` from a Next error boundary — the key that ties this to the server event. */
  digest?: string;
  componentStack?: string;
}

export function reportClientError(report: ClientErrorReport): void {
  try {
    if (typeof window === "undefined") return;

    const key = `${report.kind}:${report.message.slice(0, 120)}`;
    if (seen.has(key) || seen.size >= MAX_PER_PAGE) return;
    seen.add(key);

    const body = JSON.stringify({
      kind: report.kind,
      message: report.message.slice(0, 1000),
      stack: report.stack?.slice(0, 8000),
      digest: report.digest,
      componentStack: report.componentStack?.slice(0, 300),
      // Path only. The endpoint strips the query string as well, but sending
      // less is better than sending something that has to be cleaned up.
      path: window.location.pathname,
    });

    // `sendBeacon` is fire-and-forget and survives unload, which a crashing page
    // frequently is. It cannot set headers, so the correlation ids are taken
    // from the session cookie server-side rather than carried here — a fair
    // trade for a report that actually arrives.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }

    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      /* reporting an error must never produce one */
    });
  } catch {
    /* likewise */
  }
}

/**
 * Attach the two global listeners. Returns a detach function.
 *
 * `window.onerror` catches what no boundary saw — a listener that threw, a
 * script that failed to parse, an image handler. `unhandledrejection` catches
 * the promise nobody awaited, which in this app is most of the client-side
 * `fetch` calls.
 */
export function installClientErrorReporting(): () => void {
  if (typeof window === "undefined") return () => {};

  const onError = (event: ErrorEvent) => {
    // A cross-origin script gives "Script error." and nothing else. It carries
    // no information and would group every unrelated third-party failure into
    // one meaningless issue, so it is dropped rather than counted.
    if (!event.message || event.message === "Script error.") return;
    reportClientError({
      kind: "error",
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    reportClientError({
      kind: "unhandledrejection",
      message:
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "Unhandled promise rejection",
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
