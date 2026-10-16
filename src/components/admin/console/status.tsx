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
 * The dashboard's attention cards: one per queue with something in it, each
 * with a coloured left rule, the count as the headline, and the one link that
 * clears it. Zeros are dropped; this is the card presentation for the top of a
 * screen.
 */
export function AttentionCards({ items }: { items: AttentionItem[] }) {
  if (!items.length) {
    return (
      <div className="c-att-grid">
        <div className="c-att" style={{ ["--att" as string]: "var(--green)" }}>
          <p className="text-[13px] font-semibold text-ink">All clear</p>
          <p className="mt-1 text-[12px] text-muted">
            Nothing is waiting on you right now.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="c-att-grid">
      {items.map((i) => {
        const color = RULE[i.tone];
        return (
          <Link
            key={i.href + i.title}
            href={i.href}
            className="c-att press"
            style={{ ["--att" as string]: color }}
          >
            <p
              className="text-data text-[30px] font-extrabold leading-none tabular-nums"
              style={{ color }}
            >
              {i.count}
            </p>
            <p className="mt-1.5 text-[12.5px] font-semibold leading-snug text-ink">
              {i.title}
            </p>
            <p className="mt-0.5 truncate text-[11.5px] text-muted">
              {i.detail}
            </p>
            <p
              className="mt-2 inline-flex items-center gap-0.5 text-[11.5px] font-bold"
              style={{ color }}
            >
              {i.action ?? "Open"}
              <ChevronRight className="size-3.5" />
            </p>
          </Link>
        );
      })}
    </div>
  );
}
