import Link from "next/link";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * Filter controls for the console's list screens.
 *
 * Both are plain server-rendered elements — a GET form and a row of links —
 * rather than client components holding state. The filter *is* the URL here:
 * a filtered list has to survive a reload, be shareable with the colleague you
 * are on the phone to, and re-query on the server. State in a `"use client"`
 * component would give up all three.
 */

/** Hidden inputs that carry the rest of the query through a search submit. */
function Carried({ params }: { params: Record<string, string | undefined> }) {
  return (
    <>
      {Object.entries(params).map(([key, value]) =>
        value ? (
          <input key={key} type="hidden" name={key} value={value} />
        ) : null
      )}
    </>
  );
}

export function SearchForm({
  action,
  defaultValue,
  placeholder,
  carry = {},
  name = "q",
}: {
  action: string;
  defaultValue?: string;
  placeholder: string;
  /** Other active filters, preserved when the search is submitted. */
  carry?: Record<string, string | undefined>;
  name?: string;
}) {
  return (
    <form
      action={action}
      method="get"
      role="search"
      className="flex min-w-0 flex-1 items-center gap-2"
    >
      <Carried params={carry} />
      <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5">
        <Search className="size-3.5 shrink-0 text-muted" />
        <input
          type="search"
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
        />
      </div>
      <button
        type="submit"
        className="press h-9 shrink-0 rounded-lg bg-ink px-3.5 text-xs font-semibold text-[color:var(--surface)]"
      >
        Search
      </button>
    </form>
  );
}

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

/** A row of mutually-exclusive filter chips. `null` value = "All". */
export function FilterChips({
  options,
  active,
  hrefFor,
  label,
}: {
  options: FilterOption[];
  active: string | null;
  hrefFor: (value: string | null) => string;
  label: string;
}) {
  return (
    <div
      className="no-scrollbar flex items-center gap-2 overflow-x-auto"
      role="group"
      aria-label={label}
    >
      <Chip href={hrefFor(null)} on={active === null}>
        All
      </Chip>
      {options.map((o) => (
        <Chip key={o.value} href={hrefFor(o.value)} on={active === o.value}>
          {o.label}
          {typeof o.count === "number" ? (
            <span className="text-data ml-1.5 opacity-70">{o.count}</span>
          ) : null}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  href,
  on,
  children,
}: {
  href: string;
  on: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={on ? "true" : undefined}
      className={cn(
        "press inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-[11px] py-1.5 text-xs font-semibold transition-colors",
        on
          ? // Not `text-bg`: in the console the page background is warm paper,
            // so text-bg on an ink chip would be a dirty off-white on black.
            "border-ink bg-ink text-[color:var(--surface)]"
          : "border-line bg-surface text-ink hover:border-[var(--c-border-hover)]"
      )}
    >
      {children}
    </Link>
  );
}


/* ============================================================
   Filter bar
   ============================================================ */

/**
 * The console's list controls: one GET form carrying a search box and any
 * number of dropdowns.
 *
 * One form, not several. Each control writes into the same query string, so a
 * vendor filter applied on top of a payment filter keeps both — which is what
 * separate forms got wrong, each submitting only its own field and silently
 * dropping the others.
 *
 * Still server-rendered, still URL-as-state: a filtered list survives a reload,
 * can be sent to the colleague you are on the phone to, and re-queries on the
 * server. The only client code involved is `SelectFilter`, which submits this
 * form on change so an operator does not have to reach for a button. Without
 * JavaScript the submit button does the same job, so nothing here depends on it.
 */
export function FilterForm({
  action,
  carry = {},
  children,
}: {
  action: string;
  /** Filters not represented by a control here, preserved across a submit. */
  carry?: Record<string, string | undefined>;
  children: React.ReactNode;
}) {
  return (
    <form
      action={action}
      method="get"
      role="search"
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
    >
      <Carried params={carry} />
      {children}
    </form>
  );
}

/** The search box, for use inside a `FilterForm`. */
export function SearchField({
  defaultValue,
  placeholder,
  name = "q",
}: {
  defaultValue?: string;
  placeholder: string;
  name?: string;
}) {
  return (
    <div className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-[var(--c-r)] border border-line bg-surface px-2.5 focus-within:border-[var(--c-border-hover)]">
      <Search className="size-3.5 shrink-0 text-muted" />
      <input
        type="search"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
      />
    </div>
  );
}

/** The submit, for browsers with no JavaScript and for anyone who prefers it. */
export function FilterSubmit({ label = "Apply" }: { label?: string }) {
  return (
    <button
      type="submit"
      className="c-btn c-btn-outline press h-8 shrink-0"
    >
      {label}
    </button>
  );
}

/**
 * A "clear everything" link. Rendered by the caller only when something is
 * actually filtered — an always-present Clear on an unfiltered list is a button
 * that does nothing, and an operator learns to stop believing it.
 */
export function FilterReset({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="press shrink-0 text-[11.5px] font-semibold text-muted hover:text-ink"
    >
      Clear filters
    </Link>
  );
}
