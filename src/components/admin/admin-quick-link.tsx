import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

/**
 * A shortcut to a related screen, at the foot of a catalogue page.
 *
 * Retuned to console density: an 8px radius, one hairline, and no 36px icon
 * tile. Two of these under the vendor table were previously as tall as four
 * table rows, to carry a label and a six-word hint.
 */
export function AdminQuickLink({
  href,
  label,
  hint,
  icon: Icon,
}: {
  href: string;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Link
      href={href}
      className="press group flex items-center justify-between gap-3 rounded-[var(--c-r)] border border-line bg-surface px-3 py-2.5 transition-colors hover:border-[var(--c-border-hover)]"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-muted" />
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-ink">{label}</p>
          <p className="truncate text-[11px] text-muted">{hint}</p>
        </div>
      </div>
      <ArrowUpRight className="size-3.5 shrink-0 text-[color:var(--c-faint)] transition group-hover:text-accent" />
    </Link>
  );
}
