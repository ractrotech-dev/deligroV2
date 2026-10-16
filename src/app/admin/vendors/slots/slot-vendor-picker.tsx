"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { AssignableVendor } from "@/lib/data-access/vendor-positions";

/**
 * The per-slot shop picker: a button carrying the current occupant, opening a
 * search box over the vendor list.
 *
 * It replaces a native `<select>`, which stopped being usable the moment the
 * catalogue outgrew a screenful — a dropdown of three hundred shops can only be
 * scrolled or type-ahead-guessed one letter at a time. Search here matches name,
 * slug and category, because an operator filling a slot thinks "the bakery on
 * Station Road" as often as they think of the registered shop name.
 *
 * Deliberately hand-rolled rather than pulled in: it is one listbox on one
 * screen, and it needs to survive the board's 8-second refresh. Client state
 * (open, query, highlight) persists across router.refresh() because the board
 * re-renders rather than remounts — so a background poll cannot yank the list
 * out from under someone mid-search.
 */

/** Roughly the popover's height — used to decide whether to open upward. */
const PANEL_PX = 330;

export interface PickerRow {
  /** null = the "empty this slot" row. */
  id: string | null;
  label: string;
  hint: string | null;
  /** The slot this shop already holds, when it isn't this one. */
  heldSlot: number | null;
  status: string | null;
}

export function SlotVendorPicker({
  position,
  currentId,
  currentName,
  vendors,
  disabled,
  onPick,
}: {
  position: number;
  currentId: string | null;
  currentName: string | null;
  vendors: AssignableVendor[];
  disabled?: boolean;
  onPick: (vendorId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [dropUp, setDropUp] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = useMemo<PickerRow[]>(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? vendors.filter(
          (v) =>
            v.name.toLowerCase().includes(needle) ||
            v.slug.toLowerCase().includes(needle) ||
            (v.category ?? "").toLowerCase().includes(needle)
        )
      : vendors;

    const list: PickerRow[] = matched.map((v) => ({
      id: v.id,
      label: v.name,
      hint: v.category ?? `/${v.slug}`,
      heldSlot: v.position != null && v.position !== position ? v.position : null,
      status: v.status !== "active" ? v.status : null,
    }));

    // "Empty this slot" leads the list, and only when there is something to
    // empty — an unfilled slot offering to unfill itself is a dead row.
    if (currentId) {
      list.unshift({
        id: null,
        label: "Empty this slot",
        hint: null,
        heldSlot: null,
        status: null,
      });
    }
    return list;
  }, [vendors, query, position, currentId]);

  // A narrowing search can strand the highlight past the end of the list.
  // Derived rather than corrected in an effect: the clamp is a fact about the
  // current rows, so there is nothing to synchronise and no extra render.
  const active = Math.min(highlight, Math.max(0, rows.length - 1));

  /**
   * Opening is an event, not a synchronisation — so the reset, the highlight
   * and the flip decision all happen here, in one batched update, rather than
   * in an effect that would re-render the panel a second time to place it.
   */
  const openPanel = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    setDropUp(
      Boolean(
        rect && rect.bottom + PANEL_PX > window.innerHeight && rect.top > PANEL_PX
      )
    );
    setQuery("");
    setHighlight(0);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  /**
   * Focus the search box the moment it mounts — the point of opening it.
   * Stable identity, or React would detach and re-attach the ref (and re-focus)
   * on every keystroke and every 8-second board refresh.
   */
  const searchRef = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el;
    el?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // A scrolled page leaves the panel behind its button, so close instead of
    // chasing it. Capture phase, because the console's main area is the
    // scroller — but scrolling the option list itself bubbles to window too,
    // and closing the panel someone is scrolling would be absurd.
    const onScroll = (e: Event) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (row: PickerRow) => {
    close();
    // Re-picking the shop already in the slot is a no-op, not a write.
    if (row.id === currentId) return;
    onPick(row.id);
  };

  // Bound to the search box, and to the toggle button only while the panel is
  // open. It used to sit on the wrapper div, where Enter on the closed toggle
  // (or on "Clear search") was swallowed and picked the highlighted row —
  // "Empty this slot" on a filled slot.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + rows.length) % rows.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) choose(row);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={open ? onKeyDown : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Shop in slot ${position}`}
        className={cn(
          "press flex h-9 w-[190px] items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-left text-[13px] transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-accent"
        )}
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            currentName ? "font-semibold" : "text-muted"
          )}
        >
          {currentName ?? "Empty"}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open ? (
        <div
          className={cn(
            "absolute right-0 z-20 w-[268px] overflow-hidden rounded-xl border border-line bg-surface shadow-lg",
            dropUp ? "bottom-full mb-1.5" : "top-full mt-1.5"
          )}
        >
          <div className="relative border-b border-[color:var(--c-divider)]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search shop, category or slug…"
              aria-label={`Search a shop for slot ${position}`}
              className="h-10 w-full bg-transparent pl-9 pr-8 text-[13px] outline-none placeholder:text-muted"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="press absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-muted">
              No shop matches &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            <ul
              ref={listRef}
              role="listbox"
              aria-label={`Shops for slot ${position}`}
              className="max-h-[260px] overflow-y-auto py-1"
            >
              {rows.map((row, index) => {
                const selected = row.id === currentId;
                return (
                  <li
                    key={row.id ?? "__empty"}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => choose(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        choose(row);
                      }
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12.5px]",
                      index === active && "bg-[var(--c-hover)]",
                      row.id === null &&
                        "border-b border-[color:var(--c-divider)] font-semibold text-muted"
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-semibold">{row.label}</span>
                        {row.heldSlot != null ? (
                          <span className="text-data shrink-0 rounded-full bg-accent-soft px-1.5 text-[10px] font-bold text-accent-ink">
                            #{row.heldSlot}
                          </span>
                        ) : null}
                        {row.status ? (
                          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted">
                            {row.status}
                          </span>
                        ) : null}
                      </span>
                      {row.hint ? (
                        <span className="block truncate text-[11px] text-muted">
                          {row.hint}
                        </span>
                      ) : null}
                    </span>
                    {selected ? (
                      <Check className="size-3.5 shrink-0 text-accent" />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
