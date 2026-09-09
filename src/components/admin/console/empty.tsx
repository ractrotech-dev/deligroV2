import Link from "next/link";
import { cn } from "@/lib/utils/cn";

/**
 * The compact empty state.
 *
 * What this replaces: a 200px-tall centred box with an icon chip, a heading and
 * a paragraph, to say "No orders in this window." An operator who filtered a
 * list to nothing does not need a poster about it — they need to know it is
 * empty and to get back to a range that is not. So this is a single dashed row
 * where the rows would have been, at the height of about two of them.
 *
 * The large centred version still exists (`EmptyState` in `admin-ui`) and is
 * still right for a page that is empty in its entirety — a console with no
 * vendors at all, a first run. It is wrong for a filtered list, which is where
 * it was being used.
 */
export function Empty({
  children,
  action,
  className,
}: {
  /** One sentence. What is not here, and why. */
  children: React.ReactNode;
  /** The one thing that would fix it — usually widening the filter. */
  action?: { href: string; label: string };
  className?: string;
}) {
  return (
    <p className={cn("c-empty", className)}>
      <span className="min-w-0">{children}</span>
      {action ? (
        <Link
          href={action.href}
          className="press shrink-0 font-semibold text-accent-ink underline-offset-2 hover:underline"
        >
          {action.label}
        </Link>
      ) : null}
    </p>
  );
}
