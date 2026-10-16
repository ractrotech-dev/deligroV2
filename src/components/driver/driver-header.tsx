import Link from "next/link";
import { Bike, LogOut, UtensilsCrossed } from "lucide-react";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Top chrome for the courier app.
 *
 * Deliberately not `RoleTopBar`. That component is built for the console
 * portals: a 1120px centred row with a `md:` nav, sign-out copy spelled out in
 * words, and an "Exit" link that only appears from `sm:` up. Inside a 402pt
 * phone screen every one of those decisions is wrong — the nav never shows, the
 * text controls eat the row, and the breakpoints are measuring the browser
 * window rather than the frame the app is actually in.
 *
 * So this is the phone version of the same header, matching AdminHeader (which
 * exists for exactly this reason on exactly this shell): icon controls, sticky
 * under the status bar, nothing that assumes it has 1120px to spend.
 */
export function DriverHeader({ name }: Readonly<{ name?: string | null }>) {
  const who = name?.trim();
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-[color:var(--bg)]/90 px-4 py-3 backdrop-blur-md">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[color:var(--blue)]/12 text-[color:var(--blue)]">
        <Bike className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold leading-none">
          {who || "Deligro rider"}
        </p>
        <p className="text-label mt-1 truncate leading-none">Courier app</p>
      </div>
      <Link
        href="/"
        aria-label="Open the customer app"
        title="Customer app"
        className="press grid size-11 shrink-0 place-items-center rounded-full border border-line bg-surface text-muted"
      >
        <UtensilsCrossed className="size-4" />
      </Link>
      <ThemeToggle className="size-11" />
      {isSupabaseConfigured ? (
        <form action="/auth/signout?next=/driver/login" method="post">
          <button
            type="submit"
            className="press grid size-11 place-items-center rounded-full border border-line bg-surface text-muted"
            aria-label="Sign out"
          >
            <LogOut className="size-4" />
          </button>
        </form>
      ) : null}
    </header>
  );
}
