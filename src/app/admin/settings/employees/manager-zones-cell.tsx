"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { setManagerZonesAction } from "../zones/actions";

export interface ZoneOption {
  id: string;
  label: string;
}

/**
 * Which zones a manager works. Shows them as text; Edit opens a checklist that
 * replaces the whole set on Save. A manager with none sees nothing in the
 * Manager app, and the cell says so in red.
 */
export function ManagerZonesCell({
  managerId,
  zoneIds,
  options,
  disabled,
}: Readonly<{ managerId: string; zoneIds: string[]; options: ZoneOption[]; disabled: boolean }>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(zoneIds);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const names = options.filter((o) => zoneIds.includes(o.id)).map((o) => o.label);

  if (!open) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span className={names.length ? "truncate text-[13px] text-ink" : "text-[13px] font-semibold text-deal"}>
          {names.length ? names.join(", ") : "No zones — sees nothing"}
        </span>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || options.length === 0}
          onClick={() => {
            setPicked(zoneIds);
            setError(null);
            setOpen(true);
          }}
        >
          Edit
        </Button>
      </div>
    );
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-semibold text-muted">Zones</legend>
      {options.map((o) => (
        <label key={o.id} className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={picked.includes(o.id)}
            onChange={(e) =>
              setPicked(e.target.checked ? [...picked, o.id] : picked.filter((z) => z !== o.id))
            }
          />
          {o.label}
        </label>
      ))}
      {error ? <p className="text-xs font-semibold text-deal">{error}</p> : null}
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await setManagerZonesAction({ managerId, zoneIds: picked });
              if (!res.ok) {
                setError(res.error ?? "Couldn't save.");
                return;
              }
              setOpen(false);
              router.refresh();
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
