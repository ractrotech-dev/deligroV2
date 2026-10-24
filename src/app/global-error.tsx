"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/obs/client";

/**
 * Last resort: an error thrown by the ROOT layout itself.
 *
 * `error.tsx` wraps pages and nested layouts, but explicitly not the layout
 * above it in the same segment — so a failure in the root layout escapes it
 * entirely. This file replaces the root layout when that happens, which is why
 * it has to supply its own `<html>` and `<body>`.
 *
 * The realistic trigger in production is a config guard: `supabase/config.ts`
 * throws at module load when the credentials are missing or malformed in a
 * production build (it refuses to fall back to demo mode, which would make
 * `requireRole()` hand out synthetic admin profiles). That throw happens above
 * every page, so this is the screen a mis-configured deploy actually shows.
 *
 * Styles are inline on purpose. The app's stylesheet is loaded by the root
 * layout this file replaces, so Tailwind classes are not guaranteed to apply.
 */
export default function GlobalError({
  error,
  retry,
}: Readonly<{
  error: Error & { digest?: string };
  /** `retry` — see next/dist/client/components/error-boundary.d.ts. */
  retry: () => void;
}>) {
  useEffect(() => {
    // The whole app failed, so this is the error most worth hearing about.
    reportClientError({ kind: "boundary", message: error.message || "The app failed to render", stack: error.stack, digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          background: "#0b0b0c",
          color: "#f5f5f5",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          textAlign: "center",
        }}
      >
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 800, margin: 0 }}>
            Deligro is unavailable
          </h1>
          <p
            style={{
              margin: "10px auto 0",
              maxWidth: "22rem",
              fontSize: "14px",
              lineHeight: 1.5,
              color: "#a1a1aa",
            }}
          >
            The app could not start. This is usually a configuration problem on
            our side, not something you did.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: "20px",
              height: "44px",
              padding: "0 20px",
              borderRadius: "999px",
              border: "none",
              background: "#f5f5f5",
              color: "#0b0b0c",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p style={{ marginTop: "16px", fontSize: "11px", color: "#71717a" }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
