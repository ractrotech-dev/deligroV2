"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Section, StatusText } from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { Switch } from "@/components/ui/field";
import type { CityZones, Zone, ZoneCounts } from "@/lib/data-access/zones";
import { saveDeliveryRadiusAction } from "../actions";
import { createCityAction, createZoneAction, updateZoneAction, type ZoneActionResult } from "./actions";

type Row = Zone & { cityName: string };

/** What the form under the Zones heading is doing. At most one thing at a time. */
type Open = { kind: "new-zone" } | { kind: "new-city" } | { kind: "edit"; zone: Row } | null;

const LABEL = "block space-y-1 text-[12.5px]";
const LABEL_TEXT = "block font-medium text-muted";

export function ZonesManager({
  cities,
  counts,
  radiusKm,
  disabled,
}: Readonly<{
  cities: CityZones[];
  /** Null when the counts couldn't be read; the columns then show a dash. */
  counts: Record<string, ZoneCounts> | null;
  /** Null when the saved value couldn't be read. */
  radiusKm: number | null;
  disabled: boolean;
}>) {
  const [open, setOpen] = useState<Open>(null);

  const rows: Row[] = cities.flatMap((c) => c.zones.map((z) => ({ ...z, cityName: c.name })));
  const emptyCities = cities.filter((c) => c.zones.length === 0).map((c) => c.name);

  const count = (id: string, key: keyof ZoneCounts) => counts?.[id]?.[key] ?? "—";

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Zone",
      cell: (z) => (
        <span className="font-semibold text-ink">
          {z.name}
          {z.isDefault ? <span className="ml-2 text-xs font-normal text-muted">Default</span> : null}
        </span>
      ),
    },
    { key: "city", header: "City", cell: (z) => z.cityName },
    { key: "radius", header: "Zone radius", align: "right", cell: (z) => `${z.radiusKm} km` },
    { key: "shops", header: "Shops", align: "right", cell: (z) => count(z.id, "shops") },
    { key: "managers", header: "Managers", align: "right", cell: (z) => count(z.id, "managers") },
    { key: "riders", header: "Riders", align: "right", cell: (z) => count(z.id, "riders") },
    {
      key: "status",
      header: "Status",
      cell: (z) => <StatusText tone={z.isActive ? "green" : "neutral"}>{z.isActive ? "Active" : "Off"}</StatusText>,
    },
    {
      key: "edit",
      header: "",
      align: "right",
      cell: (z) => (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen({ kind: "edit", zone: z })}
          className="c-btn c-btn-outline disabled:opacity-50"
        >
          Edit
        </button>
      ),
    },
  ];

  return (
    <>
      <Section flush title="Delivery radius">
        <RadiusForm saved={radiusKm} disabled={disabled} />
      </Section>

      <Section
        title="Zones"
        meta={`${rows.length} zone${rows.length === 1 ? "" : "s"}`}
        description="Zones group shops and staff. Managers see only the zones you give them on Team. A zone doesn't change where customers can order; only the delivery radius does."
        actions={
          <div className="flex gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setOpen({ kind: "new-city" })}
              className="c-btn c-btn-outline disabled:opacity-50"
            >
              Add city
            </button>
            <button
              type="button"
              disabled={disabled || cities.length === 0}
              onClick={() => setOpen({ kind: "new-zone" })}
              className="c-btn c-btn-dark disabled:opacity-50"
            >
              Add zone
            </button>
          </div>
        }
      >
        {open?.kind === "new-city" ? <CityForm onClose={() => setOpen(null)} /> : null}
        {open?.kind === "new-zone" ? <ZoneForm cities={cities} onClose={() => setOpen(null)} /> : null}
        {open?.kind === "edit" ? <ZoneForm key={open.zone.id} zone={open.zone} cities={cities} onClose={() => setOpen(null)} /> : null}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(z) => z.id}
          empty={cities.length === 0 ? "No cities yet. Add a city first." : "No zones yet."}
        />

        {emptyCities.length > 0 && rows.length > 0 ? (
          <p className="mt-2 text-[12.5px] text-muted">No zones yet in {emptyCities.join(", ")}.</p>
        ) : null}
      </Section>
    </>
  );
}

/** Saves with the action, then re-reads the page. Keeps the error beside the form. */
function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save(action: () => Promise<ZoneActionResult>, after?: () => void) {
    setError(null);
    start(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? "Couldn't save.");
        return;
      }
      after?.();
      router.refresh();
    });
  }
  return { pending, error, save };
}

function Problem({ text }: Readonly<{ text: string | null }>) {
  if (!text) return null;
  return (
    <p role="alert" className="text-[12.5px] font-medium text-deal">
      {text}
    </p>
  );
}

function RadiusForm({ saved, disabled }: Readonly<{ saved: number | null; disabled: boolean }>) {
  const { pending, error, save } = useSave();
  const [value, setValue] = useState(saved === null ? "" : String(saved));

  if (saved === null) {
    return <p className="text-[13px] text-muted">The delivery radius can&apos;t be read right now. Reload to try again.</p>;
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        save(() => saveDeliveryRadiusAction({ radiusKm: Number(value) }));
      }}
    >
      <div className="flex items-center gap-2 text-[13.5px] text-ink">
        <label htmlFor="delivery-radius">Customers can order within</label>
        <input
          id="delivery-radius"
          className="c-field text-data w-[72px] tabular-nums"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled || pending}
          required
        />
        <span>km of Bemetara city centre.</span>
        <button
          type="submit"
          disabled={disabled || pending || Number(value) === saved || value.trim() === ""}
          className="c-btn c-btn-dark ml-2 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-[12.5px] text-muted">0 removes the limit.</p>
      <Problem text={error} />
    </form>
  );
}

/** Add a zone, or edit `zone` when it is given. */
function ZoneForm({
  zone,
  cities,
  onClose,
}: Readonly<{ zone?: Row; cities: CityZones[]; onClose: () => void }>) {
  const { pending, error, save } = useSave();
  const [cityId, setCityId] = useState(zone?.cityId ?? cities[0]?.id ?? "");
  const [name, setName] = useState(zone?.name ?? "");
  const [radius, setRadius] = useState(String(zone?.radiusKm ?? 5));
  const [lat, setLat] = useState(zone ? String(zone.centerLat) : "");
  const [lng, setLng] = useState(zone ? String(zone.centerLng) : "");
  const [active, setActive] = useState(zone?.isActive ?? true);

  const submit = () => {
    const values = { name, centerLat: Number(lat), centerLng: Number(lng), radiusKm: Number(radius) };
    save(
      () => (zone ? updateZoneAction({ id: zone.id, isActive: active, ...values }) : createZoneAction({ cityId, ...values })),
      onClose
    );
  };

  return (
    <form
      className="mb-3 space-y-3 border-b border-line pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-[13px] font-semibold text-ink">{zone ? `Edit ${zone.name}` : "Add a zone"}</p>
      <div className="grid grid-cols-[1fr_1.4fr_0.7fr_1fr_1fr] gap-3">
        <label className={LABEL}>
          <span className={LABEL_TEXT}>City</span>
          {zone ? (
            <span className="block py-1 text-[12.5px] text-ink">{zone.cityName}</span>
          ) : (
            <select className="c-field c-field-wide" value={cityId} onChange={(e) => setCityId(e.target.value)}>
              {cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className={LABEL}>
          <span className={LABEL_TEXT}>Zone name</span>
          <input className="c-field c-field-wide" value={name} onChange={(e) => setName(e.target.value)} placeholder="Bemetara West" required autoFocus />
        </label>
        <label className={LABEL}>
          <span className={LABEL_TEXT}>Zone radius (km)</span>
          <input className="c-field c-field-wide text-data" inputMode="decimal" value={radius} onChange={(e) => setRadius(e.target.value)} required />
        </label>
        <label className={LABEL}>
          <span className={LABEL_TEXT}>Centre latitude</span>
          <input className="c-field c-field-wide text-data" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="21.7157" required />
        </label>
        <label className={LABEL}>
          <span className={LABEL_TEXT}>Centre longitude</span>
          <input className="c-field c-field-wide text-data" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="81.5335" required />
        </label>
      </div>
      <div className="flex items-center gap-3">
        {zone ? (
          <label className="mr-2 flex items-center gap-2 text-[12.5px] text-ink">
            <Switch checked={active} disabled={zone.isDefault} onChange={setActive} />
            {zone.isDefault ? "Active (the default zone stays on)" : "Active"}
          </label>
        ) : null}
        <button type="submit" disabled={pending} className="c-btn c-btn-dark disabled:opacity-50">
          {pending ? "Saving…" : zone ? "Save zone" : "Add zone"}
        </button>
        <button type="button" onClick={onClose} disabled={pending} className="c-btn c-btn-outline disabled:opacity-50">
          Cancel
        </button>
        <Problem text={error} />
      </div>
    </form>
  );
}

function CityForm({ onClose }: Readonly<{ onClose: () => void }>) {
  const { pending, error, save } = useSave();
  const [name, setName] = useState("");
  return (
    <form
      className="mb-3 space-y-3 border-b border-line pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        save(() => createCityAction({ name }), onClose);
      }}
    >
      <div className="flex items-end gap-3">
        <label className={`${LABEL} w-[320px]`}>
          <span className={LABEL_TEXT}>City name</span>
          <input className="c-field c-field-wide" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <button type="submit" disabled={pending} className="c-btn c-btn-dark disabled:opacity-50">
          {pending ? "Saving…" : "Add city"}
        </button>
        <button type="button" onClick={onClose} disabled={pending} className="c-btn c-btn-outline disabled:opacity-50">
          Cancel
        </button>
      </div>
      <Problem text={error} />
    </form>
  );
}
