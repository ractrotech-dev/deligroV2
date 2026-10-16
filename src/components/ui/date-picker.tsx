"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * A single calendar control for every "pick a date" field in the app —
 * settlements, reports, order history — replacing the browser's native
 * `<input type="date">`. The native picker cannot be restyled (it renders
 * outside the page, in whatever theme the OS is in) and jumping more than a
 * couple of months means clicking a ‹ arrow that many times.
 *
 * Same contract as the native input it replaces — `value`/`onChange` as a
 * plain `YYYY-MM-DD` string, `""` for empty — so every existing call site
 * swaps in without touching its own state or server action.
 *
 * Two views: the day grid (default), and a year/month jump screen reached by
 * tapping the "June 2026" header — a scrollable list of years next to a
 * 12-month grid, so reaching a year six months or six years away is one or two
 * taps rather than a long run of ‹ clicks.
 *
 * All calendar math is done in UTC against Y/M/D integers pulled straight out
 * of the value string, never through a locally-parsed `Date` — the browser's
 * own timezone must never be able to shift a selected day by one.
 */

export interface DatePickerProps {
  /** `YYYY-MM-DD`, or `""` for no date selected. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  /** How far back the year list scrolls. Default: 15 years before today. */
  minYear?: number;
  /** How far forward the year list scrolls. Default: 2 years after today. */
  maxYear?: number;
}

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

const VALUE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseValue(value: string): Ymd | null {
  const match = VALUE_RE.exec(value);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toValue(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Days in month `m` (1-12) of year `y`, via the "day 0 of next month" trick. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 0 (Sun) .. 6 (Sat) for the 1st of month `m`. */
function firstWeekday(y: number, m: number): number {
  return new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
}

const IST_TODAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "Today" in IST — every date this app quotes is an IST calendar day. */
function todayIst(): Ymd {
  // en-CA formats as YYYY-MM-DD.
  return parseValue(IST_TODAY_FMT.format(new Date()))!;
}

const LABEL_FMT = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const HEADER_FMT = new Intl.DateTimeFormat("en-IN", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const MONTH_LABELS = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, i, 1))
  )
);

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function sameDay(a: Ymd | null, b: Ymd): boolean {
  return a !== null && a.y === b.y && a.m === b.m && a.d === b.d;
}

/** The selected day is filled; today is ringed so it can be found again. */
function dayTone(isSelected: boolean, isToday: boolean): string {
  if (isSelected) return "bg-accent font-semibold text-[var(--on-accent)]";
  if (isToday) {
    return "font-semibold text-accent-ink ring-1 ring-inset ring-accent/40";
  }
  return "text-ink hover:bg-surface-2";
}

export function DatePicker({
  value,
  onChange,
  disabled,
  className,
  placeholder = "Select date",
  minYear,
  maxYear,
}: Readonly<DatePickerProps>) {
  const today = useMemo(() => todayIst(), []);
  const selected = useMemo(() => parseValue(value), [value]);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"days" | "months">("days");
  const [cursor, setCursor] = useState<{ y: number; m: number }>(
    () => selected ?? { y: today.y, m: today.m }
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const yearListRef = useRef<HTMLDivElement>(null);
  const yearBtnRefs = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (view !== "months") return;
    yearBtnRefs.current.get(cursor.y)?.scrollIntoView({ block: "center" });
  }, [view, cursor.y]);

  const yLow = minYear ?? today.y - 15;
  const yHigh = maxYear ?? today.y + 2;
  const years = useMemo(() => {
    const list: number[] = [];
    for (let y = yLow; y <= yHigh; y++) list.push(y);
    return list;
  }, [yLow, yHigh]);

  const cells = useMemo(() => {
    const first = firstWeekday(cursor.y, cursor.m);
    const total = daysInMonth(cursor.y, cursor.m);
    const out: (number | null)[] = [];
    for (let i = 0; i < first; i++) out.push(null);
    for (let d = 1; d <= total; d++) out.push(d);
    return out;
  }, [cursor.y, cursor.m]);

  function shiftMonth(delta: number) {
    setCursor((c) => {
      let m = c.m + delta;
      let y = c.y;
      if (m < 1) {
        m = 12;
        y -= 1;
      } else if (m > 12) {
        m = 1;
        y += 1;
      }
      return { y, m };
    });
  }

  function pick(d: number) {
    onChange(toValue(cursor.y, cursor.m, d));
    setOpen(false);
  }

  function pickMonth(m: number) {
    setCursor((c) => ({ ...c, m }));
    setView("days");
  }

  const label = selected
    ? LABEL_FMT.format(new Date(Date.UTC(selected.y, selected.m - 1, selected.d)))
    : placeholder;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Re-anchor the browsed month to the selected date on every open —
          // never mid-browse, or picking a month in the year view would snap
          // back under the user.
          if (next) {
            setView("days");
            setCursor(selected ?? { y: today.y, m: today.m });
          }
        }}
        className={cn(
          "press flex h-11 w-full items-center gap-2 rounded-xl border border-line bg-bg px-3 text-left text-[13.5px]",
          selected ? "text-ink" : "text-muted",
          "disabled:opacity-50",
          className
        )}
      >
        <Calendar className="size-4 shrink-0 text-muted" />
        <span className="truncate">{label}</span>
      </button>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-[300px] rounded-xl border border-line bg-surface p-3 shadow-[var(--shadow-lg)]">
          {view === "days" ? (
            <>
              <div className="mb-2 flex items-center justify-between">
                <button
                  type="button"
                  aria-label="Previous month"
                  onClick={() => shiftMonth(-1)}
                  className="press flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setView("months")}
                  className="press rounded-lg px-2 py-1 text-[13px] font-semibold text-ink hover:bg-surface-2"
                >
                  {HEADER_FMT.format(new Date(Date.UTC(cursor.y, cursor.m - 1, 1)))}
                </button>
                <button
                  type="button"
                  aria-label="Next month"
                  onClick={() => shiftMonth(1)}
                  className="press flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-y-1 text-center">
                {WEEKDAY_LABELS.map((w) => (
                  <span
                    key={w}
                    className="text-[10.5px] font-semibold uppercase text-muted"
                  >
                    {w}
                  </span>
                ))}
                {cells.map((d, i) => {
                  if (d === null) return <span key={`b${i}`} />;
                  const isSelected = sameDay(selected, { y: cursor.y, m: cursor.m, d });
                  const isToday = sameDay(today, { y: cursor.y, m: cursor.m, d });
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => pick(d)}
                      className={cn(
                        "press mx-auto flex size-8 items-center justify-center rounded-full text-[12.5px] tabular-nums",
                        dayTone(isSelected, isToday)
                      )}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>

              <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2.5">
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                  }}
                  className="press rounded-lg px-2 py-1 text-[12px] font-semibold text-muted hover:bg-surface-2 hover:text-ink"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCursor({ y: today.y, m: today.m });
                    onChange(toValue(today.y, today.m, today.d));
                    setOpen(false);
                  }}
                  className="press rounded-lg px-2 py-1 text-[12px] font-semibold text-accent-ink hover:bg-surface-2"
                >
                  Today
                </button>
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <div
                ref={yearListRef}
                className="flex max-h-[220px] w-16 shrink-0 flex-col overflow-y-auto"
              >
                {years.map((y) => (
                  <button
                    key={y}
                    type="button"
                    ref={(el) => {
                      if (el) yearBtnRefs.current.set(y, el);
                      else yearBtnRefs.current.delete(y);
                    }}
                    onClick={() => setCursor((c) => ({ ...c, y }))}
                    className={cn(
                      "press shrink-0 rounded-lg px-2 py-1.5 text-left text-[12.5px] tabular-nums",
                      y === cursor.y
                        ? "bg-accent-soft font-semibold text-accent-ink"
                        : "text-ink hover:bg-surface-2"
                    )}
                  >
                    {y}
                  </button>
                ))}
              </div>
              <div className="grid grow grid-cols-3 gap-1.5 content-start">
                {MONTH_LABELS.map((label, i) => {
                  const m = i + 1;
                  const isCursor = m === cursor.m;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => pickMonth(m)}
                      className={cn(
                        "press rounded-lg py-2 text-[12.5px] font-medium",
                        isCursor
                          ? "bg-accent-soft font-semibold text-accent-ink"
                          : "text-ink hover:bg-surface-2"
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
