"use client";

import { useEffect } from "react";
import { TriangleAlert, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/lib/obs/client";

/**
 * Error boundary for the admin section.
 *
 * Scoped here so a failed screen renders inside the admin shell — the layout
 * supplies `.device` / `.app-shell`, so this must not add its own — leaving the
 * operator in the portal instead of dropping them on a bare full-page error.
 *
 * The admin data layer throws rather than degrading: `getCustomerDetail` throws
 * on a failed profile read, and the probed selects in `admin-orders.ts` throw on
 * anything that is not a missing column. That is the right call — an operator
 * shown an empty order list during an outage will act on it — but it only holds
 * up if something catches the throw, which is what this is.
 *
 * `error.message` is not rendered. Next replaces it with a generic string for
 * anything thrown in a Server Component so that query text and row contents
 * cannot reach the browser; the digest is the safe half and is what ties this
 * screen to the server log — searchable in the console at
 * /admin/observability, which is where the matching `onRequestError` record
 * carries the same digest and the real stack.
 */
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  // `retry` — see next/dist/client/components/error-boundary.d.ts, which is
  // what actually hands these props over. It was briefly `unstable_retry` in
  // the Next 16 pre-releases and this file was written against that name, so
  // every "Try again" button threw "unstable_retry is not a function" on click.
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
    // The digest is the whole point of reporting from here. Next replaces a
    // Server Component's message with a generic string before it reaches the
    // browser and hands the real one to `onRequestError`, which records it
    // against the same digest — so this report is what joins the screen the
    // operator is looking at to the stack trace that explains it. Until now the
    // "Reference:" line below pointed at a server log that did not exist.
    reportClientError({
      kind: "boundary",
      message: error.message || "Admin screen failed to render",
      stack: error.stack,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-surface px-4 py-10 text-center">
      <span className="mb-1 grid size-12 place-items-center rounded-2xl bg-deal-soft text-deal">
        <TriangleAlert className="size-6" />
      </span>
      <p className="font-semibold">This screen failed to load</p>
      <p className="max-w-xs text-sm text-muted">
        The database did not answer. Nothing was changed — retrying is safe.
      </p>
      <div className="mt-3">
        <Button size="sm" variant="secondary" onClick={() => retry()}>
          <RotateCw className="size-4" /> Try again
        </Button>
      </div>
      {error.digest ? (
        <p className="text-data mt-2 text-[11px] text-muted">
          Reference: {error.digest}
        </p>
      ) : null}
    </div>
  );
}
