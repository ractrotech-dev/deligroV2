"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/obs/client";
import { TriangleAlert, RotateCw } from "lucide-react";

/**
 * The app-wide error boundary.
 *
 * Every data-access call in this app throws on a real failure rather than
 * returning empty — a page that renders "no orders" during a database outage is
 * worse than one that admits it broke, because an operator will act on the
 * empty list. That design only holds up if something catches the throw; without
 * this file it reaches Next's default error page, which is unstyled, escapes
 * the phone frame, and offers no way back.
 *
 * `error.message` is deliberately not shown. Next replaces it with a generic
 * string plus a digest for anything thrown in a Server Component precisely so
 * that connection strings and row contents do not reach the browser. The digest
 * is safe and is what matches this to the server log, so that is what we show.
 */
export default function RouteError({
  error,
  retry,
}: Readonly<{
  error: Error & { digest?: string };
  // `retry` — see next/dist/client/components/error-boundary.d.ts. The
  // `unstable_retry` name this was written against only existed in the Next 16
  // pre-releases, so the button threw instead of retrying.
  retry: () => void;
}>) {
  useEffect(() => {
    console.error(error);
    // Report first: an error screen that only says "Try again" leaves no record.
    reportClientError({ kind: "boundary", message: error.message || "A page failed to render", stack: error.stack, digest: error.digest });
  }, [error]);

  return (
    <div className="device">
      <div className="app-shell">
        <div className="app-scroll no-scrollbar grid place-items-center px-6 py-16 text-center">
          <div>
            <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-red-500/10 text-red-600">
              <TriangleAlert className="size-7" />
            </span>
            <h1 className="text-xl font-extrabold tracking-tight">
              Something went wrong
            </h1>
            <p className="mx-auto mt-1.5 max-w-xs text-sm text-muted">
              This screen failed to load. Nothing you were doing was saved.
            </p>
            <button
              type="button"
              onClick={() => retry()}
              className="press mt-5 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-[var(--on-accent)]"
            >
              <RotateCw className="size-4" />
              Try again
            </button>
            {error.digest ? (
              <p className="text-data mt-4 text-[11px] text-muted">
                Reference: {error.digest}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
