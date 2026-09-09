"use client";

import { useId } from "react";

/**
 * A dropdown filter that applies itself.
 *
 * The console's lists keep their state in the URL and re-query on the server,
 * which is what makes a filtered view reloadable and shareable. That leaves one
 * small job for the client: submitting the form when the value changes, so an
 * operator changing a filter does not also have to find a button.
 *
 * `requestSubmit`, not `submit` — the latter bypasses the form's own validation
 * and, more importantly here, does not fire `submit` handlers, which is the
 * difference between a form Next can intercept and a full page reload.
 *
 * Uncontrolled, seeded by `defaultValue`. The URL is the state; holding a
 * second copy in React would give two answers to one question, and the two
 * would disagree the moment a browser back button moved one of them.
 *
 * Degrades to a plain `<select>` with no JavaScript: the form still has its
 * submit button, so nothing is unreachable.
 */
export function SelectFilter({
  name,
  label,
  value,
  options,
}: {
  name: string;
  /** Shown above the control on narrow widths, and to screen readers always. */
  label: string;
  value: string;
  /** The "no filter" option is the caller's first entry, with an empty value. */
  options: { value: string; label: string }[];
}) {
  const id = useId();

  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1.5">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={value}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-8 max-w-[190px] shrink-0 truncate rounded-[var(--c-r)] border border-line bg-surface px-2 text-[12px] font-medium text-ink outline-none hover:border-[var(--c-border-hover)]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
