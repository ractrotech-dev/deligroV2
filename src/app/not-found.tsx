import Link from "next/link";
import { SearchX } from "lucide-react";
import { NotFoundReporter } from "@/components/providers/not-found-reporter";

/**
 * The app-wide 404, rendered whenever a page calls `notFound()` or a URL
 * matches nothing.
 *
 * Without this file Next serves its own default 404, which carries none of the
 * app's styling and renders full-bleed — so on desktop it breaks straight out
 * of the phone frame every other screen sits inside. The admin order and
 * customer detail screens both call `notFound()` for a missing or malformed id,
 * so this is a reachable page in normal operation, not only a typo'd URL.
 */
export default function NotFound() {
  return (
    <div className="device">
      <NotFoundReporter />
      <div className="app-shell">
        <div className="app-scroll no-scrollbar grid place-items-center px-6 py-16 text-center">
          <div>
            <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-surface-2 text-muted">
              <SearchX className="size-7" />
            </span>
            <h1 className="text-xl font-extrabold tracking-tight">
              Not found
            </h1>
            <p className="mx-auto mt-1.5 max-w-xs text-sm text-muted">
              This page doesn&rsquo;t exist, or whatever it pointed at has been
              removed.
            </p>
            <Link
              href="/"
              className="press mt-5 inline-flex h-11 items-center justify-center rounded-full bg-accent px-5 text-sm font-semibold text-[var(--on-accent)]"
            >
              Go home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
