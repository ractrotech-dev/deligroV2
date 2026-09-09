import { cn } from "@/lib/utils/cn";

/**
 * A lifecycle, as the thing you read first.
 *
 * The console has several records whose most important fact is *where they got
 * to* — an order, a settlement, a refund. Stating that as a status pill in a
 * corner makes the reader reconstruct the sequence from a set of timestamps
 * scattered across four panels. A timeline states it directly: what happened,
 * when, what is happening now, and what has not happened yet.
 *
 * ## Reached-ness and time are two different questions
 *
 * `state` answers the first: **done**, **current** (drawn as a ring rather than
 * a filled dot, so "here" is distinguishable from "passed" without reading down
 * to the first grey row), or **pending**.
 *
 * `at` answers the second, and it can be missing from a stage that definitely
 * happened. A deployment predating the migration that added the timestamp knows
 * the stage was reached — the record's own status says so — but not when. That
 * is why a caller can pass `atFallback`: "Time not recorded" is the truth
 * there, where both "not yet" and a blank would be lies. Deriving reached-ness
 * from the presence of a timestamp is exactly the bug this separation prevents,
 * and it is how a delivered order came to show "Delivered — not yet".
 */

export type StageState = "done" | "current" | "pending";

export interface Stage {
  label: string;
  /** Formatted for display. Null when the moment was never recorded. */
  at?: string | null;
  state: StageState;
  /**
   * What to say instead of a time. For a stage that happened on a database
   * that did not stamp it — "Time not recorded" — never for one that simply
   * has not happened, which the state already covers.
   */
  atFallback?: string;
  /** A qualifier under the label: a rider's name, a reason for cancellation. */
  detail?: string;
  /** Marks a stage that ended the lifecycle early — cancelled, failed. */
  tone?: "normal" | "bad";
}

export function Timeline({
  stages,
  className,
}: {
  stages: Stage[];
  className?: string;
}) {
  return (
    <ol className={cn("relative", className)}>
      {stages.map((s, i) => {
        const last = i === stages.length - 1;
        const bad = s.tone === "bad";
        const reached = s.state === "done" || s.state === "current";

        return (
          <li key={s.label} className="relative flex gap-3 pb-3.5 last:pb-0">
            {/* The rail. Drawn per-row rather than as one absolutely-positioned
                line down the list, so it stops at the last dot instead of
                trailing past it, and so a row of any height still connects. */}
            {!last ? (
              <span
                aria-hidden
                className={cn(
                  "absolute left-[4.5px] top-[14px] w-px",
                  "bottom-0",
                  s.state === "done"
                    ? bad
                      ? "bg-deal/40"
                      : "bg-green/40"
                    : "bg-[color:var(--c-divider)]"
                )}
              />
            ) : null}

            <span
              aria-hidden
              className={cn(
                "relative z-[1] mt-[5px] size-2.5 shrink-0 rounded-full",
                s.state === "done" &&
                  (bad ? "bg-deal" : "bg-green"),
                s.state === "current" &&
                  "bg-surface ring-2 ring-accent ring-offset-2 ring-offset-[color:var(--surface)]",
                s.state === "pending" &&
                  "border border-[color:var(--c-border-strong)] bg-surface"
              )}
            />

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-[12.5px] font-semibold",
                  reached ? "text-ink" : "text-muted",
                  bad && reached && "text-deal"
                )}
              >
                {s.label}
              </p>
              <p className="text-data mt-0.5 text-[11px] text-muted">
                {s.at ??
                  s.atFallback ??
                  (s.state === "current" ? "In progress" : "Not yet")}
              </p>
              {s.detail ? (
                <p className="mt-0.5 truncate text-[11.5px] text-muted">
                  {s.detail}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ============================================================
   Financial breakdown
   ============================================================ */

export interface BreakdownLine {
  label: string;
  /** Pre-formatted. Pass "—" for a figure this deployment cannot know. */
  value: string;
  /** A sentence under the label, for a charge that needs explaining. */
  note?: string;
  /** Renders in the negative tone: a refund, a deduction, a penalty. */
  negative?: boolean;
  /** A subtotal rule above this line. */
  rule?: boolean;
}

/**
 * A money statement: labels left, figures right, all in one column so they can
 * be added up by eye.
 *
 * Tabular figures throughout and a fixed-width value column — the whole point
 * of a financial breakdown is that the digits line up, and a proportional font
 * puts the rupee in "₹1,240" and the one in "₹140" in different places.
 *
 * The total is a separate prop rather than the last line, so it cannot be
 * mistaken for one more charge and so the rule above it is never forgotten.
 */
export function FinancialBreakdown({
  lines,
  total,
  className,
}: {
  lines: BreakdownLine[];
  total?: { label: string; value: string; note?: string };
  className?: string;
}) {
  return (
    <dl className={cn("text-[12.5px]", className)}>
      {lines.map((l) => (
        <div
          key={l.label}
          className={cn(
            "flex items-baseline justify-between gap-4 py-[5px]",
            l.rule && "mt-1 border-t border-[color:var(--c-divider)] pt-2"
          )}
        >
          <dt className="min-w-0">
            <span className="text-muted">{l.label}</span>
            {l.note ? (
              <span className="block text-[11px] leading-snug text-[color:var(--c-faint)]">
                {l.note}
              </span>
            ) : null}
          </dt>
          <dd
            className={cn(
              "text-data shrink-0 tabular-nums",
              l.negative ? "text-deal" : "text-ink"
            )}
          >
            {l.value}
          </dd>
        </div>
      ))}

      {total ? (
        <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-[color:var(--c-border-strong)] pt-2">
          <dt className="min-w-0 text-[13px] font-bold text-ink">
            {total.label}
            {total.note ? (
              <span className="block text-[11px] font-normal leading-snug text-muted">
                {total.note}
              </span>
            ) : null}
          </dt>
          <dd className="text-data shrink-0 text-[15px] font-bold tabular-nums text-ink">
            {total.value}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/* ============================================================
   Fact list
   ============================================================ */

/**
 * The labelled facts beside a record — customer, vendor, address, method.
 *
 * A definition list rather than a grid of little bordered cards. Four cards to
 * carry four short strings is the pattern this redesign exists to remove: the
 * label already says what the value is, and the border adds nothing to that.
 */
export function FactList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <dl className={cn("divide-y divide-[color:var(--c-divider-2)]", className)}>
      {children}
    </dl>
  );
}

export function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-[11.5px] font-medium text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}
