"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import {
  VENDOR_GAPS,
  VENDOR_OPEN_STATES,
  VENDOR_RATES,
} from "@/lib/vendor-status";
import { PAGE_SIZES } from "./page-sizes";

const SORTS: { value: string; label: string }[] = [
  { value: "recent", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name A–Z" },
  { value: "status", label: "Status" },
];

const selectCls =
  "h-8 rounded-[var(--c-r)] border border-line bg-surface px-2 text-[12px] font-medium text-ink outline-none hover:border-[var(--c-border-hover)]";

interface FilterGroup {
  param: string;
  label: string;
  /** The first choice in the dropdown, meaning no filter. */
  any: string;
  options: readonly { value: string; label: string }[];
}

/**
 * Search and filters for the vendor table. Everything lives in the URL, so the
 * server component reads `searchParams` and the state survives refresh and the
 * browser back button. The text box is debounced; the selects apply at once.
 *
 * Search stays out in the open because it is used constantly. The filters are
 * folded into one panel, and whichever are on show as chips that can be removed
 * one at a time, so the row only takes up space for filters actually in use.
 *
 * Status is deliberately NOT here — it is the tab row above, which is the same
 * `?status=` parameter. Two controls writing one value is how a filter bar and
 * a tab row end up disagreeing about what you are looking at.
 */
export function VendorSearchBar({ categories }: Readonly<{ categories: string[] }>) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstRun = useRef(true);

  const push = (next: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") sp.delete(key);
      else sp.set(key, value);
    }
    start(() => router.replace(`${pathname}?${sp.toString()}`, { scroll: false }));
  };

  // Debounce the text box; skip the initial mount so a fresh load doesn't push.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const id = setTimeout(() => {
      if ((params.get("q") ?? "") !== q) push({ q: q || null, page: null });
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // The panel closes on a click outside it or on Escape.
  useEffect(() => {
    if (!panelOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setPanelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [panelOpen]);

  const groups: FilterGroup[] = [
    {
      param: "category",
      label: "Category",
      any: "All categories",
      options: categories.map((c) => ({ value: c, label: c })),
    },
    { param: "gap", label: "Setup", any: "Any setup", options: VENDOR_GAPS },
    { param: "rate", label: "Commission", any: "Any commission", options: VENDOR_RATES },
    { param: "open", label: "Open or closed", any: "Open or closed", options: VENDOR_OPEN_STATES },
  ];

  const active = groups.flatMap((group) => {
    const value = params.get(group.param);
    if (!value) return [];
    const option = group.options.find((o) => o.value === value);
    return [{ group, value, label: option?.label ?? value }];
  });

  const clearAll = () =>
    push({
      ...Object.fromEntries(groups.map((g) => [g.param, null])),
      page: null,
    });

  const sort = params.get("sort") ?? "recent";
  const per = params.get("per") ?? String(PAGE_SIZES[0]);

  return (
    <div
      className={
        pending
          ? "flex w-full min-w-0 items-start gap-2 opacity-70 transition-opacity"
          : "flex w-full min-w-0 items-start gap-2"
      }
    >
      <div className="flex h-8 w-[320px] shrink-0 items-center gap-2 rounded-[var(--c-r)] border border-line bg-surface px-2.5 focus-within:border-[var(--c-border-hover)]">
        <Search className="size-3.5 shrink-0 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search shop, owner, mobile or handle…"
          className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
          aria-label="Search vendors"
        />
        {q ? (
          <button
            type="button"
            onClick={() => setQ("")}
            className="shrink-0 text-muted hover:text-ink"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      <div ref={panelRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
          aria-haspopup="dialog"
          className="c-btn c-btn-outline h-8"
        >
          <SlidersHorizontal className="size-3.5" />
          Filters
          {active.length > 0 ? (
            <span className="text-data rounded-full bg-accent px-1.5 text-[10.5px] font-semibold text-white">
              {active.length}
            </span>
          ) : null}
          <ChevronDown className="size-3 text-muted" />
        </button>

        {panelOpen ? (
          <div
            role="dialog"
            aria-label="Filter vendors"
            className="absolute left-0 top-full z-30 mt-1.5 w-[440px] rounded-[var(--c-r)] border border-line bg-surface p-3 shadow-lg"
          >
            <div className="grid grid-cols-2 gap-3">
              {groups.map((group) => (
                <label key={group.param} className="block space-y-1">
                  <span className="block text-[11px] font-semibold text-muted">
                    {group.label}
                  </span>
                  <select
                    value={params.get(group.param) ?? ""}
                    onChange={(e) =>
                      push({ [group.param]: e.target.value || null, page: null })
                    }
                    className={`${selectCls} w-full`}
                  >
                    <option value="">{group.any}</option>
                    {group.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-[color:var(--c-divider)] pt-2.5">
              {active.length > 0 ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[11.5px] font-semibold text-muted hover:text-ink"
                >
                  Clear all
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="c-btn c-btn-outline h-7"
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {active.length > 0 ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {active.map(({ group, label }) => (
            <span
              key={group.param}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--c-r)] bg-surface-2 pl-2.5 pr-1.5 text-[12px] text-ink"
            >
              <span className="text-muted">{group.label}:</span>
              <span className="font-medium">{label}</span>
              <button
                type="button"
                onClick={() => push({ [group.param]: null, page: null })}
                className="text-muted hover:text-ink"
                aria-label={`Remove the ${group.label} filter`}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <select
          value={sort}
          onChange={(e) => push({ sort: e.target.value })}
          className={selectCls}
          aria-label="Sort vendors"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <select
          value={per}
          onChange={(e) =>
            push({
              per:
                e.target.value === String(PAGE_SIZES[0]) ? null : e.target.value,
              page: null,
            })
          }
          className={selectCls}
          aria-label="Rows per page"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} per page
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
