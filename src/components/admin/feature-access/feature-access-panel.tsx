"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils/cn";
import { formatDateTime } from "@/lib/utils/relative-time";
import {
  featureDef,
  featuresFor,
  isDefaultOn,
  isFeatureKey,
  type FeatureKey,
  type FeatureRole,
} from "@/lib/features/catalog";
import type { StoredSwitch } from "@/lib/features/flags.server";
import type { SwitchInput, SwitchResult } from "@/lib/features/switch-types";
import { Segmented } from "./segmented";

type Choice = "inherit" | "on" | "off";

/**
 * The role-wide state of one feature. No role-wide row = the feature's default,
 * which is OFF for the sensitive manager powers.
 */
function roleWideOn(switches: StoredSwitch[], key: string): boolean {
  const fallback = isFeatureKey(key) ? isDefaultOn(featureDef(key)) : true;
  return switches.find((s) => s.feature === key && s.subjectKind === "role")?.enabled ?? fallback;
}

function ownSwitch(switches: StoredSwitch[], key: string, id: string): StoredSwitch | undefined {
  return switches.find((x) => x.feature === key && x.subjectKind !== "role" && x.subjectId === id);
}

/**
 * One shop's or one person's switches: Same as everyone / On / Off per feature,
 * with what everyone gets, what this account ends up with, and who set it. On a
 * customer's, rider's or shop's own page.
 */
function SubjectSwitches({
  role,
  subjectId,
  switches,
  busy,
  onSave,
  className,
}: Readonly<{
  role: FeatureRole;
  subjectId: string;
  switches: StoredSwitch[];
  busy: boolean;
  onSave: (feature: FeatureKey, subjectId: string, enabled: boolean | null) => void;
  className?: string;
}>) {
  const subjectNoun = role === "vendor" ? "shop" : "person";
  return (
    <ul className={cn("divide-y divide-line", className)}>
      {featuresFor(role).map((f) => {
        const own = ownSwitch(switches, f.key, subjectId);
        const choice: Choice = !own ? "inherit" : own.enabled ? "on" : "off";
        const inherited = roleWideOn(switches, f.key);
        const effective = choice === "inherit" ? inherited : choice === "on";
        return (
          <li key={f.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">
                {f.label}
                <span className={cn("ml-2 text-xs font-semibold", effective ? "text-green" : "text-deal")}>
                  {effective ? "On" : "Off"}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-muted">
                Everyone: {inherited ? "on" : "off"}
                {choice !== "inherit" ? ` · this ${subjectNoun}: ${choice}` : ""}
                {own?.changedBy ? ` · set by ${own.changedBy}` : ""}
                {own?.changedBy && own.changedAt ? `, ${formatDateTime(own.changedAt)}` : ""}
                {effective ? "" : ` · ${f.offMeans}`}
              </p>
              {f.pending ? <p className="mt-0.5 text-xs font-semibold text-ink">{f.pending}</p> : null}
            </div>
            <Segmented
              label={f.label}
              value={choice}
              options={[
                ["inherit", "Same as everyone"],
                ["on", "On"],
                ["off", "Off"],
              ]}
              disabled={busy || Boolean(f.pending)}
              onChange={(v) => onSave(f.key as FeatureKey, subjectId, v === "inherit" ? null : v === "on")}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A single account's switches with their own save state: the Access panel on
 * Admin → Customers, Riders and Vendors → one account.
 */
export function AccountSwitchesPanel({
  role,
  subjectId,
  switches,
  disabled,
  save: saveSwitch,
}: Readonly<{
  role: FeatureRole;
  subjectId: string;
  switches: StoredSwitch[];
  disabled: boolean;
  save: (input: SwitchInput) => Promise<SwitchResult>;
}>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function save(feature: FeatureKey, subject: string | null, enabled: boolean | null) {
    setError(null);
    startTransition(async () => {
      const res = await saveSwitch({ feature, subjectId: subject, enabled });
      if (!res.ok) setError(res.error ?? "Could not save.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="rounded-lg border border-deal/30 bg-deal-soft px-3 py-2 text-sm font-semibold text-deal">
          {error}
        </p>
      ) : null}
      <SubjectSwitches role={role} subjectId={subjectId} switches={switches} busy={disabled || pending} onSave={save} />
    </div>
  );
}
