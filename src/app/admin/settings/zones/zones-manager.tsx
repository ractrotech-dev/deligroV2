"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Section, StatusText, Empty } from "@/components/admin/console";
import { Button } from "@/components/ui/button";
import { Field, fieldCls } from "@/components/ui/field";
import type { CityZones, Zone } from "@/lib/data-access/zones";
import {
  createCityAction,
  createZoneAction,
  updateZoneAction,
  type ZoneActionResult,
} from "./actions";

/**
 * Add cities and zones, and edit a zone's centre, radius and active state.
 * Every change is saved by its own button and re-read from the server.
 */
export function ZonesManager({
  cities,
  disabled,
}: Readonly<{ cities: CityZones[]; disabled: boolean }>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  function run(action: () => Promise<ZoneActionResult>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? "Couldn't save.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  const busy = disabled || pending;

  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="rounded-xl border border-deal/30 bg-deal-soft px-3.5 py-3 text-sm font-semibold text-deal">
          {error}
        </p>
      ) : null}

      {cities.length === 0 ? <Empty>No cities yet. Add the first one below.</Empty> : null}

      {cities.map((city) => (
        <Section
          key={city.id}
          title={city.name}
          meta={`${city.zones.length} zone${city.zones.length === 1 ? "" : "s"}`}
        >
          {city.zones.length === 0 ? (
            <Empty>No zones in {city.name} yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {city.zones.map((z) => (
                <li key={z.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">
                        {z.name}
                        {z.isDefault ? <span className="ml-2 text-xs font-normal text-muted">Default</span> : null}
                      </p>
                      <p className="text-data mt-0.5 text-xs text-muted">
                        {z.centerLat.toFixed(4)}, {z.centerLng.toFixed(4)} · {z.radiusKm} km
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusText tone={z.isActive ? "green" : "neutral"}>
                        {z.isActive ? "Active" : "Off"}
                      </StatusText>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => setEditing(editing === z.id ? null : z.id)}
                      >
                        {editing === z.id ? "Close" : "Edit"}
                      </Button>
                    </div>
                  </div>
                  {editing === z.id ? (
                    <ZoneEditor
                      zone={z}
                      busy={busy}
                      onSave={(v) => run(() => updateZoneAction({ id: z.id, ...v }), () => setEditing(null))}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ))}

      <Section title="Add a zone" description="A zone is a circle around a centre point. Shops are placed in zones; managers are assigned to them.">
        <NewZoneForm cities={cities} busy={busy} onCreate={(v) => run(() => createZoneAction(v))} />
      </Section>

      <Section title="Add a city">
        <NewCityForm busy={busy} onCreate={(name) => run(() => createCityAction({ name }))} />
      </Section>
    </div>
  );
}

interface ZoneValues {
  name: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  isActive: boolean;
}

function ZoneEditor({
  zone,
  busy,
  onSave,
}: Readonly<{ zone: Zone; busy: boolean; onSave: (v: ZoneValues) => void }>) {
  const [v, setV] = useState({
    name: zone.name,
    centerLat: String(zone.centerLat),
    centerLng: String(zone.centerLng),
    radiusKm: String(zone.radiusKm),
    isActive: zone.isActive,
  });
  return (
    <form
      className="admin-measure mt-3 grid gap-3 @3xl:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          name: v.name,
          centerLat: Number(v.centerLat),
          centerLng: Number(v.centerLng),
          radiusKm: Number(v.radiusKm),
          isActive: v.isActive,
        });
      }}
    >
      <Field label="Name" required>
        <input className={fieldCls} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required />
      </Field>
      <Field label="Radius (km)" required>
        <input className={fieldCls} inputMode="decimal" value={v.radiusKm} onChange={(e) => setV({ ...v, radiusKm: e.target.value })} required />
      </Field>
      <Field label="Centre latitude" required>
        <input className={fieldCls} inputMode="decimal" value={v.centerLat} onChange={(e) => setV({ ...v, centerLat: e.target.value })} required />
      </Field>
      <Field label="Centre longitude" required>
        <input className={fieldCls} inputMode="decimal" value={v.centerLng} onChange={(e) => setV({ ...v, centerLng: e.target.value })} required />
      </Field>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={v.isActive}
          disabled={zone.isDefault}
          onChange={(e) => setV({ ...v, isActive: e.target.checked })}
        />
        Active{zone.isDefault ? " (the default zone is always active)" : ""}
      </label>
      <div className="@3xl:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save zone"}
        </Button>
      </div>
    </form>
  );
}

function NewZoneForm({
  cities,
  busy,
  onCreate,
}: Readonly<{
  cities: CityZones[];
  busy: boolean;
  onCreate: (v: { cityId: string; name: string; centerLat: number; centerLng: number; radiusKm: number }) => void;
}>) {
  const [cityId, setCityId] = useState(cities[0]?.id ?? "");
  const [name, setName] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("5");
  if (cities.length === 0) return <Empty>Add a city first.</Empty>;
  return (
    <form
      className="admin-measure grid gap-3 @3xl:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ cityId, name, centerLat: Number(lat), centerLng: Number(lng), radiusKm: Number(radius) });
      }}
    >
      <Field label="City" required>
        <select className={fieldCls} value={cityId} onChange={(e) => setCityId(e.target.value)}>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Zone name" required>
        <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bemetara West" required />
      </Field>
      <Field label="Centre latitude" required>
        <input className={fieldCls} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="21.7157" required />
      </Field>
      <Field label="Centre longitude" required>
        <input className={fieldCls} inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="81.5335" required />
      </Field>
      <Field label="Radius (km)" required hint="0.5 to 50 km">
        <input className={fieldCls} inputMode="decimal" value={radius} onChange={(e) => setRadius(e.target.value)} required />
      </Field>
      <div className="@3xl:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Add zone"}
        </Button>
      </div>
    </form>
  );
}

function NewCityForm({ busy, onCreate }: Readonly<{ busy: boolean; onCreate: (name: string) => void }>) {
  const [name, setName] = useState("");
  return (
    <form
      className="admin-measure flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(name);
        setName("");
      }}
    >
      <div className="min-w-0 flex-1">
        <Field label="City name" required>
          <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
      </div>
      <Button type="submit" disabled={busy}>
        Add city
      </Button>
    </form>
  );
}
