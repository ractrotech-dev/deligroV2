"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Section } from "@/components/admin/console";
import { cn } from "@/lib/utils/cn";
import {
  ROLE_LABEL,
  featuresFor,
  type FeatureKey,
  type FeatureRole,
} from "@/lib/features/catalog";
import type { StoredSwitch } from "@/lib/features/flags.server";
import { setFeatureSwitchAction } from "./actions";

export interface Account {
  id: string;
  name: string;
}

type Choice = "inherit" | "on" | "off";

const ROLES: FeatureRole[] = ["vendor", "manager", "driver"];

/**
 * The switches, per role: one role-wide On/Off per feature, then exceptions
 * for a single shop (vendors) or person (managers, riders).
 *
 * Every change is saved as it is made (no Save button to forget), and the page
 * re-reads from the server afterwards so what is shown is what is stored.
 */
export function FeatureAccessPanel({
  switches,
  accounts,
  disabled,
}: {
  switches: StoredSwitch[];
  accounts: Record<FeatureRole, Account[]>;
  disabled: boolean;
}) {
  const [role, setRole] = useState<FeatureRole>("vendor");
  const [subject, setSubject] = useState<string>("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const features = featuresFor(role);
  const list = accounts[role];

  const roleWide = (key: string) =>
    switches.find((s) => s.feature === key && s.subjectKind === "role")?.enabled ?? true;
  const own = (key: string, id: string): Choice => {
    const s = switches.find((x) => x.feature === key && x.subjectKind !== "role" && x.subjectId === id);
    return s ? (s.enabled ? "on" : "off") : "inherit";
  };

  // Accounts that have at least one exception, with how many — the list an
  // operator needs to see before wondering why one shop behaves differently.
  const exceptions = useMemo(() => {
    const byId = new Map<string, number>();
    for (const s of switches) {
      if (s.subjectKind === "role" || !s.subjectId) continue;
      if (!features.some((f) => f.key === s.feature)) continue;
      byId.set(s.subjectId, (byId.get(s.subjectId) ?? 0) + 1);
    }
    return [...byId].map(([id, n]) => ({ id, n, name: list.find((a) => a.id === id)?.name ?? "Removed account" }));
  }, [switches, features, list]);

  function save(feature: FeatureKey, subjectId: string | null, enabled: boolean | null) {
    setError(null);
    startTransition(async () => {
      const res = await setFeatureSwitchAction({ feature, subjectId, enabled });
      if (!res.ok) setError(res.error ?? "Could not save.");
      router.refresh();
    });
  }

  const busy = disabled || pending;

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Role" className="flex flex-wrap gap-2">
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={role === r}
            onClick={() => {
              setRole(r);
              setSubject("");
            }}
            className={cn(
              "press min-h-11 rounded-full border px-4 text-sm font-semibold",
              role === r ? "border-accent bg-accent text-[var(--on-accent)]" : "border-line bg-surface text-ink"
            )}
          >
            {ROLE_LABEL[r]}
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-deal/30 bg-deal-soft px-3 py-2 text-sm font-semibold text-deal">
          {error}
        </p>
      ) : null}

      <Section title="For everyone" meta={`${features.length} features`}>
        <ul className="divide-y divide-line">
          {features.map((f) => {
            const on = roleWide(f.key);
            return (
              <li key={f.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">
                    {f.label} <span className="font-normal text-muted">· {f.labelHi}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">Off: {f.offMeans}</p>
                </div>
                <Segmented
                  label={f.label}
                  value={on ? "on" : "off"}
                  options={[
                    ["on", "On"],
                    ["off", "Off"],
                  ]}
                  disabled={busy}
                  onChange={(v) => save(f.key as FeatureKey, null, v === "on" ? null : false)}
                />
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title={role === "vendor" ? "Exceptions for one shop" : "Exceptions for one person"}
        meta={exceptions.length ? `${exceptions.length} with exceptions` : undefined}
      >
        <label className="block text-xs font-semibold text-muted" htmlFor="feature-subject">
          {role === "vendor" ? "Shop" : role === "manager" ? "Manager" : "Rider"}
        </label>
        <select
          id="feature-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="mt-1 min-h-11 w-full max-w-md rounded-lg border border-line bg-surface px-3 text-sm text-ink"
        >
          <option value="">Choose…</option>
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        {exceptions.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {exceptions.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => setSubject(x.id)}
                className="press min-h-9 rounded-full border border-line bg-surface-2 px-3 text-xs font-semibold text-ink"
              >
                {x.name} · {x.n}
              </button>
            ))}
          </div>
        ) : null}

        {subject ? (
          <ul className="mt-4 divide-y divide-line">
            {features.map((f) => {
              const choice = own(f.key, subject);
              const inherited = roleWide(f.key);
              return (
                <li key={f.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink">{f.label}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      Everyone: {inherited ? "on" : "off"}
                      {choice !== "inherit" ? ` · this ${role === "vendor" ? "shop" : "person"}: ${choice}` : ""}
                    </p>
                  </div>
                  <Segmented
                    label={f.label}
                    value={choice}
                    options={[
                      ["inherit", "Default"],
                      ["on", "On"],
                      ["off", "Off"],
                    ]}
                    disabled={busy}
                    onChange={(v) =>
                      save(f.key as FeatureKey, subject, v === "inherit" ? null : v === "on")
                    }
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  disabled: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-lg border border-line p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => value !== v && onChange(v)}
          className={cn(
            "press min-h-10 min-w-14 rounded-md px-3 text-xs font-semibold disabled:opacity-60",
            value === v
              ? v === "off"
                ? "bg-deal-soft text-deal"
                : v === "on"
                  ? "bg-green-soft text-green"
                  : "bg-surface-2 text-ink"
              : "text-muted"
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
