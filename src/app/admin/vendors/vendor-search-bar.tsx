"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { fieldCls } from "@/components/ui/field";
import { PAGE_SIZES } from "./page-sizes";

const SORTS: { value: string; label: string }[] = [
  { value: "recent", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name A–Z" },
  { value: "status", label: "Status" },
];

/**
 * Search / filter / sort / page-size for the vendor table. Everything lives in
 * the URL, so the server component reads `searchParams` and the state survives
 * refresh and the browser back button. The text box is debounced; the selects
 * apply at once.
 *
 * Status is deliberately NOT here — it is the tab row above, which is the same
 * `?status=` parameter. Two controls writing one value is how a filter bar and
 * a tab row end up disagreeing about what you are looking at.
 */
export function VendorSearchBar({ categories }: { categories: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");
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

  const category = params.get("category") ?? "";
  const sort = params.get("sort") ?? "recent";
  const per = params.get("per") ?? String(PAGE_SIZES[0]);

  return (
    <div
      className={
        pending
          ? "flex min-w-0 flex-1 flex-wrap items-center gap-2 opacity-70 transition-opacity"
          : "flex min-w-0 flex-1 flex-wrap items-center gap-2"
      }
    >
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search shop, owner, mobile or handle…"
          className={`${fieldCls} pl-8 pr-8`}
          aria-label="Search vendors"
        />
        {q ? (
          <button
            type="button"
            onClick={() => setQ("")}
            className="press absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted hover:text-ink"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(e) => push({ category: e.target.value || null, page: null })}
          className={`${fieldCls} w-auto max-w-[150px] px-2 text-[12px]`}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => push({ sort: e.target.value })}
          className={`${fieldCls} w-auto px-2 text-[12px]`}
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
          className={`${fieldCls} w-auto px-2 text-[12px]`}
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
