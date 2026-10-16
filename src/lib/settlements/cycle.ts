/**
 * How often a vendor is paid out — and, from that, which dates a new
 * settlement should default to.
 *
 * The cycle does not schedule anything. Nothing in this app moves money on a
 * timer; a person still builds the batch and records the UTR. What the cycle
 * removes is the guesswork about WHICH range to build, which is where the real
 * mistakes were: a fortnight typed in by hand either double-pays the overlap or
 * silently strands the gap.
 *
 * Pure and client-safe — the admin form, the settlement screen and the reports
 * all derive the same period from it.
 */

export const SETTLEMENT_CYCLES = ["weekly", "monthly"] as const;
export type SettlementCycle = (typeof SETTLEMENT_CYCLES)[number];

export const DEFAULT_SETTLEMENT_CYCLE: SettlementCycle = "weekly";

export function isSettlementCycle(v: unknown): v is SettlementCycle {
  return (
    typeof v === "string" &&
    (SETTLEMENT_CYCLES as readonly string[]).includes(v)
  );
}

/** Plain-English label for the admin screens. */
export const CYCLE_LABEL: Record<SettlementCycle, string> = {
  weekly: "Every week",
  monthly: "Every month",
};

/** What the vendor sees on a statement. */
export const CYCLE_NOTE: Record<SettlementCycle, string> = {
  weekly: "Paid once a week, Monday to Sunday.",
  monthly: "Paid once a month, on the calendar month.",
};

/* ------------------------------------------------------------------
 * IST calendar maths.
 *
 * Deliberately string-based rather than Date-based. A settlement period is a
 * pair of IST calendar days, and the existing ledger already stores them as
 * "YYYY-MM-DD" strings parsed by parseIstDateInput(). Converting to a Date and
 * back to get "the Monday before last" is where an off-by-one timezone hour
 * turns into an off-by-one DAY of orders — either paid twice or never.
 * ------------------------------------------------------------------ */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for an instant, in IST. */
export function istDay(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function fromKey(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

function toKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Shift a "YYYY-MM-DD" by whole days, staying on the calendar. */
function shiftDay(key: string, days: number): string {
  const { y, m, d } = fromKey(key);
  const utc = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(utc).toISOString().slice(0, 10);
}

/** Day of week for a calendar key: 0 = Sunday. */
function weekdayOf(key: string): number {
  const { y, m, d } = fromKey(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the week containing `key`. */
function mondayOf(key: string): string {
  const wd = weekdayOf(key);
  // Sunday (0) belongs to the week that started six days earlier, not the one
  // about to start — an ISO week runs Monday to Sunday.
  return shiftDay(key, wd === 0 ? -6 : 1 - wd);
}

function firstOfMonth(key: string): string {
  const { y, m } = fromKey(key);
  return toKey(y, m, 1);
}

function lastOfMonth(key: string): string {
  const { y, m } = fromKey(key);
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return toKey(y, m, last);
}

export interface CyclePeriod {
  /** Inclusive first day, "YYYY-MM-DD". */
  from: string;
  /** Inclusive last day, "YYYY-MM-DD". */
  to: string;
  label: string;
}

/**
 * The period a settlement built *today* should cover: the last COMPLETE cycle.
 *
 * Complete, not current, on purpose. Building the week you are standing in
 * settles a Monday-to-Wednesday stub and leaves Thursday-to-Sunday to be caught
 * by a later batch that has to start mid-week — which is exactly the manual
 * date-typing this is meant to replace. The admin can still override both dates.
 */
export function lastCompletePeriod(
  cycle: SettlementCycle,
  today: string = istDay()
): CyclePeriod {
  if (cycle === "monthly") {
    const thisMonthStart = firstOfMonth(today);
    const prevMonthEnd = shiftDay(thisMonthStart, -1);
    const from = firstOfMonth(prevMonthEnd);
    return { from, to: prevMonthEnd, label: "Last full month" };
  }
  const thisMonday = mondayOf(today);
  const from = shiftDay(thisMonday, -7);
  return { from, to: shiftDay(thisMonday, -1), label: "Last full week" };
}

/** The cycle currently running — what a mid-period preview would cover. */
export function currentPeriod(
  cycle: SettlementCycle,
  today: string = istDay()
): CyclePeriod {
  if (cycle === "monthly") {
    return {
      from: firstOfMonth(today),
      to: lastOfMonth(today),
      label: "This month",
    };
  }
  const monday = mondayOf(today);
  return { from: monday, to: shiftDay(monday, 6), label: "This week" };
}

/**
 * The first day on which the current period can be settled in full — i.e. the
 * day after it ends. Shown as "Next payout" on the vendor screen.
 */
export function nextPayoutDay(
  cycle: SettlementCycle,
  today: string = istDay()
): string {
  return shiftDay(currentPeriod(cycle, today).to, 1);
}

const dayFmt = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "16 Aug 2026" from a calendar key. Never a timezone-shifted day. */
export function formatDayKey(key: string): string {
  const { y, m, d } = fromKey(key);
  return dayFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

