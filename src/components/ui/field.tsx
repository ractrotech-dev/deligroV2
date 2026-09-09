import { cn } from "@/lib/utils/cn";

/**
 * Shared form primitives, promoted from the copy-pasted `field`/`Labeled`/
 * `Section`/`Toggle` helpers that lived in banner-form and settings-form. This
 * module has no "use client" so it can render in either a Server or Client
 * Component; the event-handler props (Toggle's onChange) are only ever supplied
 * from a client form.
 *
 * Each primitive carries a stable `ui-*` hook class alongside its utilities.
 * That is what lets the ops console restyle the whole form vocabulary to its
 * own proportions from one block in globals.css (`.console-theme .ui-field`,
 * `.ui-section`, `.ui-btn`) instead of every screen shipping a console variant
 * of every input. The utilities remain the default, so the customer app, the
 * vendor portal and the admin phone frame are unaffected.
 */

export const fieldCls =
  "ui-field w-full rounded-xl bg-surface-2 px-3.5 py-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50";

export const labelCls = "ui-label text-xs font-semibold text-muted";

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="ui-fieldrow block space-y-1.5">
      <span className={labelCls}>
        {label}
        {required ? <span className="text-deal"> *</span> : null}
      </span>
      {children}
      {hint ? (
        <span className="ui-hint block text-[11px] text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export function Section({
  title,
  description,
  right,
  className,
  children,
}: {
  title?: string;
  description?: string;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("ui-section card space-y-4 p-4", className)}>
      {title || right ? (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {title ? (
              <h2 className="ui-section-title text-heading text-[15px]">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-xs text-muted">{description}</p>
            ) : null}
          </div>
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The switch control on its own — a real checkbox with the track as its next
 * sibling (see `.c-switch` in globals.css), so forms still submit without
 * client state and work before hydration.
 *
 * Exported because the settings screen lays its rows out differently but needs
 * an identical control; a second implementation there is how two screens end up
 * with two different-looking switches.
 */
export function Switch({
  name,
  id,
  defaultChecked,
  checked,
  disabled,
  onChange,
}: {
  name?: string;
  id?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <>
      <input
        id={id}
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        checked={checked}
        disabled={disabled}
        onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
        className="sr-only"
      />
      {/* The input is `sr-only`, so this pill is the whole visible control and
          the only thing anyone aims at. A bare <span> is inert: it toggles
          nothing unless a <label> reaches it.

          Given an `id` the pill becomes its own label, so it works wherever a
          consumer puts it. Without that, `Row` in settings-form.tsx — which
          closes its <label> before the control — left every switch on
          /admin/settings/platform dead to clicks while `.c-switch`'s
          `cursor: pointer` advertised otherwise. Only the label text toggled
          them, master switch included.

          Without an `id` it stays an inert span: the one consumer in that shape
          is `Toggle` below, which already wraps text and pill in a single
          <label>, and a nested <label> is invalid HTML.

          Either way the pill remains the input's immediate next sibling — all
          of the checked, disabled and focus styling is `input:checked +
          .c-switch` in globals.css. Asserted by scripts/qa/switch-affordance.ts. */}
      {id ? (
        <label htmlFor={id} className="c-switch" />
      ) : (
        <span className="c-switch" aria-hidden="true" />
      )}
    </>
  );
}

/** A labelled switch. Uncontrolled (defaultChecked) or controlled (checked + onChange). */
export function Toggle({
  name,
  label,
  description,
  defaultChecked,
  checked,
  onChange,
}: {
  name?: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className="ui-toggle flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-surface-2 px-3.5 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        {description ? (
          <span className="block text-xs text-muted">{description}</span>
        ) : null}
      </span>
      <Switch
        name={name}
        defaultChecked={defaultChecked}
        checked={checked}
        onChange={onChange}
      />
    </label>
  );
}
