"use client";

import { useEffect } from "react";
import { TriangleAlert, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the manager portal.
 *
 * The board itself already catches its own read failure and says so in place —
 * a manager shown an empty board during an outage would believe there was no
 * work. This covers what that cannot: a throw from the layout's `requireRole`
 * path, or from a server action's re-render.
 *
 * Renders bare: the manager layout supplies `.device` / `.app-shell`, and
 * wrapping again would put a phone frame inside a phone frame on desktop.
 */
export default function ManagerError({
  error,
  retry,
}: Readonly<{
  error: Error & { digest?: string };
  /** `retry` — see next/dist/client/components/error-boundary.d.ts. */
  retry: () => void;
}>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mt-8 flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-10 text-center">
        <span className="mb-1 grid size-12 place-items-center rounded-2xl bg-red-500/10 text-red-600">
          <TriangleAlert className="size-6" />
        </span>
        <p className="font-semibold">The board failed to load</p>
        <p className="max-w-xs text-sm text-muted">
          Orders could not be read. Nothing was changed — retrying is safe.
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
    </div>
  );
}
