"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  Bike,
  Check,
  Copy,
  KeyRound,
  Loader2,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, fieldCls } from "@/components/ui/field";
import { cn } from "@/lib/utils/cn";
import { createEmployeeAction } from "./actions";
import type { EmployeeRole } from "@/lib/data-access/employees";

const ROLE_META: Record<
  EmployeeRole,
  { label: string; blurb: string; icon: typeof ShieldCheck }
> = {
  manager: {
    label: "Manager",
    blurb: "Manager app — their zones and the permissions you grant",
    icon: ShieldCheck,
  },
  driver: {
    label: "Rider",
    blurb: "Delivery partner app only",
    icon: Bike,
  },
};

export function CreateEmployeeButton({
  configured,
  role,
}: Readonly<{
  configured: boolean;
  /** Adds this role only, with no choice to make: the Riders page's "Add rider". */
  role?: EmployeeRole;
}>) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!configured}
        className="c-btn c-btn-dark disabled:pointer-events-none disabled:opacity-50"
      >
        <UserPlus className="size-3.5" strokeWidth={2.4} /> {role ? `Add ${ROLE_META[role].label.toLowerCase()}` : "Create employee"}
      </button>
      {open ? (
        <CreateEmployeeDialog
          fixedRole={role}
          onClose={() => setOpen(false)}
          onCreated={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function CreateEmployeeDialog({
  fixedRole,
  onClose,
  onCreated,
}: Readonly<{
  fixedRole?: EmployeeRole;
  onClose: () => void;
  onCreated: () => void;
}>) {
  const router = useRouter();
  const [role, setRole] = useState<EmployeeRole>(fixedRole ?? "manager");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ password: string; email: string; phone: string } | null>(
    null
  );
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      const res = await createEmployeeAction({
        role,
        fullName,
        email,
        phone: phone || null,
        password: password || null,
      });
      if (!res.ok || !res.password) {
        setError(res.error ?? "Couldn't create the employee.");
        return;
      }
      setCreated({ password: res.password, email: email.trim(), phone: phone.trim() });
      router.refresh();
    });
  }

  function dismiss() {
    if (created) onCreated();
    else onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (created) onCreated();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [created, onCreated, onClose]);

  const overlay = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={dismiss}
        className="absolute inset-0 bg-ink/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-[var(--c-r)] border border-line bg-surface shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-heading">
            {fixedRole
              ? created
                ? `${ROLE_META[fixedRole].label} added`
                : `Add ${ROLE_META[fixedRole].label.toLowerCase()}`
              : created
                ? "Employee created"
                : "Create employee"}
          </h2>
          <button
            type="button"
            onClick={dismiss}
            className="grid size-9 place-items-center rounded-full bg-surface-2 text-muted"
          >
            <X className="size-5" />
          </button>
        </div>

        {created ? (
          <div className="overflow-y-auto p-5">
            <CreatedPanel
              role={role}
              email={created.email}
              phone={created.phone}
              password={created.password}
              onDone={dismiss}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="grid gap-4 overflow-y-auto px-5 py-4 grid-cols-2">
              {fixedRole ? null : <div className="col-span-2">
                <span className="text-xs font-semibold text-muted">Role</span>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {(Object.keys(ROLE_META) as EmployeeRole[]).map((r) => {
                    const meta = ROLE_META[r];
                    const Icon = meta.icon;
                    const active = role === r;
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRole(r)}
                        className={cn(
                          "rounded-[var(--c-r)] border p-2.5 text-left transition-colors",
                          active
                            ? "border-accent bg-accent-soft"
                            : "border-line bg-surface-2"
                        )}
                      >
                        <Icon
                          className={
                            "size-4 " + (active ? "text-accent" : "text-muted")
                          }
                        />
                        <p className="mt-1.5 text-sm font-bold text-ink">
                          {meta.label}
                        </p>
                        <p className="text-[11px] text-muted">{meta.blurb}</p>
                      </button>
                    );
                  })}
                </div>
              </div>}

              <Field label="Full name" required>
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Priya Sharma"
                  className={fieldCls}
                />
              </Field>

              <Field label="Email" required hint="Used to sign in to the portal.">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  autoCapitalize="none"
                  className={fieldCls}
                />
              </Field>

              <Field
                label="Mobile"
                hint="Optional. Enables OTP sign-in for this employee."
              >
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className={fieldCls}
                />
              </Field>

              <Field
                label="Password"
                hint="Leave blank to auto-generate a one-time password to hand off."
              >
                <input
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Auto-generated"
                  autoCapitalize="none"
                  className={fieldCls}
                />
              </Field>

              {error ? (
                <p className="text-sm font-medium text-deal col-span-2">
                  {error}
                </p>
              ) : null}
            </div>

            <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
              <Button size="sm" variant="secondary" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button size="sm" disabled={pending} onClick={submit}>
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <>
                    <UserPlus className="size-3.5" /> Create{" "}
                    {ROLE_META[role].label.toLowerCase()}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // Portalled to the body: the console's content column is a container and a
  // scroll parent, so a dialog rendered in place would be trapped by it.
  if (typeof document === "undefined") return overlay;
  return createPortal(overlay, document.body);
}

function CreatedPanel({
  role,
  email,
  phone,
  password,
  onDone,
}: Readonly<{
  role: EmployeeRole;
  email: string;
  phone: string;
  password: string;
  onDone: () => void;
}>) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-[var(--c-r)] bg-green/10 px-3.5 py-3 text-sm font-medium text-green">
        <Check className="size-4 shrink-0" />
        <span>
          {ROLE_META[role].label} account is ready. Share these credentials — the
          password is only shown once.
        </span>
      </div>

      <CopyRow label="Email" value={email} />
      {phone ? <CopyRow label="Mobile" value={phone} /> : null}
      <CopyRow label="Temporary password" value={password} mono icon />

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function CopyRow({
  label,
  value,
  mono,
  icon,
}: Readonly<{
  label: string;
  value: string;
  mono?: boolean;
  icon?: boolean;
}>) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      /* clipboard blocked — the value is visible to read/type */
    }
  }
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <div className="flex items-center gap-2 rounded-[var(--c-r)] bg-surface-2 p-2.5">
        {icon ? <KeyRound className="size-4 shrink-0 text-muted" /> : null}
        <code
          className={
            "flex-1 break-all px-1 text-[15px] font-semibold text-ink " +
            (mono ? "text-data" : "")
          }
        >
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-muted hover:text-ink"
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? (
            <Check className="size-4 text-green" />
          ) : (
            <Copy className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}
