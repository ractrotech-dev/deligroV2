import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * Status, said quietly.
 *
 * The rule the redesign works to: colour carries meaning and nothing else, and
 * it is applied to the smallest thing that can carry it. A late order gets a
 * red dot and a red figure, not a red row — a whole tinted row among forty
 * rows is a wall, and a wall is not a signal. A delivered order gets green
 * text, not a green container.
 *
 * Green success, red critical, amber pending, blue informational, neutral for
 * everything that is merely normal.
 */

export type Tone = "green" | "amber" | "red" | "blue" | "accent" | "neutral";

const DOT: Record<Tone, string> = {
  green: "text-green",
  amber: "text-[color:var(--c-ink-amber)]",
  red: "text-deal",
  blue: "text-blue",
  accent: "text-accent",
  neutral: "text-[color:var(--c-faint)]",
};

const BADGE: Record<Tone, string> = {
  green: "bg-green-soft text-green",
  amber: "bg-[var(--c-tint-amber)] text-[color:var(--c-ink-amber)]",
  red: "bg-deal-soft text-deal",
  blue: "bg-[var(--c-tint-blue)] text-blue",
  accent: "bg-accent-soft text-accent-ink",
  neutral: "bg-[var(--c-divider)] text-muted",
};

/** A 6px mark. The lightest way to say which state a row is in. */
export function StatusDot({
  tone,
  className,
}: {
  tone: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn("c-status-dot", DOT[tone], className)}
      aria-hidden="true"
    />
  );
}

/**
 * Dot plus label — the default way a table states a status.
 *
 * Preferred over `StatusBadge` inside a table: a column of forty tinted
 * capsules is the "overuse of badges" the redesign set out to remove, and a
 * dot next to plain text reads faster anyway.
 */
export function StatusText({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <StatusDot tone={tone} />
      <span className="text-[12.5px] font-medium text-ink">{children}</span>
    </span>
  );
}

/**
 * The tinted capsule. For a *single* prominent status — beside a page title, on
 * a detail screen — not for a column of them.
 */
export function StatusBadge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--c-r-sm)] px-2 py-[3px] text-[11.5px] font-semibold",
        BADGE[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/** "Live", with the dot that breathes. */
export function LiveBadge({ label = "Live" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--c-r-sm)] bg-green-soft px-2 py-[3px] text-[11.5px] font-semibold text-green">
      <span className="c-dot bg-green" />
      {label}
    </span>
  );
}

/* ============================================================
   Attention list
   ============================================================ */

export interface AttentionItem {
  href: string;
  title: string;
  /** Why it needs a person, in the words an operator would use. */
  detail: string;
  count: number;
  tone: Tone;
  /** The button's words: "View orders", "Open queue". */
  action?: string;
}

const RULE: Record<Tone, string> = {
  green: "var(--green)",
  amber: "var(--c-ink-amber)",
  red: "var(--deal)",
  blue: "var(--blue)",
  accent: "var(--accent)",
  neutral: "var(--c-faint)",
};

/**
 * One row of the attention centre: what is waiting, how much of it, and the
 * one link that clears it.
 *
 * The count is the loudest thing in the row because it is the thing being
 * triaged — an operator scanning this is asking "which of these is worst", and
 * that is a comparison between numbers, not between labels.
 *
 * A queue at zero is dropped by the caller rather than shown as a green zero.
 * A list of zeros trains you to stop reading the list, and then the one that
 * is not zero goes unread too.
 */
export function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <Link
      href={item.href}
      className="press group flex items-center gap-3 border-l-2 py-2 pl-3 pr-1 transition-colors hover:bg-[var(--c-hover)]"
      style={{ borderLeftColor: RULE[item.tone] }}
    >
      <span
        className="text-data w-9 shrink-0 text-[19px] font-bold leading-none tabular-nums"
        style={{ color: RULE[item.tone] }}
      >
        {item.count}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-ink">
          {item.title}
        </span>
        <span className="block truncate text-[11.5px] text-muted">
          {item.detail}
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-0.5 text-[11.5px] font-semibold text-muted transition-colors group-hover:text-ink @xl:inline-flex">
        {item.action ?? "Open"}
        <ChevronRight className="size-3.5" />
      </span>
      <ChevronRight className="size-4 shrink-0 text-[color:var(--c-faint)] @xl:hidden" />
    </Link>
  );
}

/** The attention centre's list. Rows are separated by hairlines, not gaps. */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  if (!items.length) {
    return (
      <p className="c-empty">Nothing is waiting on you right now.</p>
    );
  }
  return (
    <div className="divide-y divide-[color:var(--c-divider-2)]">
      {items.map((i) => (
        <AttentionRow key={i.href + i.title} item={i} />
      ))}
    </div>
  );
}
