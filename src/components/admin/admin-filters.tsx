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

/**
 * A row of mutually-exclusive views. `null` value = "All".
 *
 * Rendered as the console's segmented tabs rather than as a row of pill chips.
 * They are the same thing — one of these is on at a time, and picking one
 * re-cuts the list below — and the tab strip says that where a row of
 * equally-weighted capsules only says "here are some words". This is the
 * `Tabs` markup from the console kit; the two are kept as separate components
 * because this one is a value-and-callback API that eleven screens already
 * pass their own `hrefFor` to, and `Tabs` takes hrefs directly.
 *
 * The selected state is `aria-current`, which is what `.c-tab` styles off — so
 * the visual state and the state announced to a screen reader cannot diverge.
 */
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
    <nav className="c-tabs no-scrollbar" aria-label={label}>
      <Chip href={hrefFor(null)} on={active === null}>
        All
      </Chip>
      {options.map((o) => (
        <Chip key={o.value} href={hrefFor(o.value)} on={active === o.value}>
          {o.label}
          {typeof o.count === "number" ? (
            <span className="c-tab-count text-data">{o.count}</span>
          ) : null}
        </Chip>
      ))}
    </nav>
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
      className={cn("c-tab", "press")}
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
