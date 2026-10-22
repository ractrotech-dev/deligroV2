import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isUuid } from "@/lib/auth/manager-scope";
import { Empty, PageHeader, StatusText, Toolbar } from "@/components/admin/console";
import { PreviewNotice } from "@/components/admin/admin-ui";
import { DataTable, type Column } from "@/components/admin/data-table";
import { FilterForm, FilterSubmit } from "@/components/admin/admin-filters";
import { SelectFilter } from "@/components/admin/select-filter";
import { listRules } from "@/lib/data-access/manager-alerts";
import { listCitiesWithZones } from "@/lib/data-access/zones";
import type { AlertRule } from "@/lib/ops/alerts-contract";
import { RuleEditor } from "./rule-editor";

export const metadata: Metadata = { title: "Alert thresholds · Admin · Deligro" };

/**
 * Settings → Alert thresholds (§14 "configurable thresholds"). With no zone
 * picked: the platform defaults every zone inherits (admins only). With a
 * zone: that zone's own rules, each overriding the default until reset.
 * Every change is audited (alert_rule.set / alert_rule.reset). Fraud and
 * service-level alerts stay off until Phase 9 switches them on.
 */
export const dynamic = "force-dynamic";

export default async function AlertThresholdsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ zone?: string }> }>) {
  await requireRole("admin");
  const { zone: rawZone } = await searchParams;
  const zone = rawZone && isUuid(rawZone) ? rawZone.toLowerCase() : null;

  let rules: AlertRule[] = [];
  let zones: { id: string; name: string }[] = [];
  let missing = false;
  if (isSupabaseConfigured) {
    try {
      const [r, cities] = await Promise.all([listRules(zone), listCitiesWithZones()]);
      rules = r;
      zones = cities.flatMap((c) => c.zones.map((z) => ({ id: z.id, name: `${z.name} · ${c.name}` })));
    } catch {
      missing = true;
    }
  }

  const columns: Column<AlertRule>[] = [
    { key: "label", header: "Alert", role: "title", cell: (r) => (
      <span className="block min-w-0">
        <span className="block font-semibold text-ink">{r.label}</span>
        <span className="block text-xs text-muted">{r.description}</span>
      </span>
    ) },
    { key: "source", header: "Rule", width: "w-[140px]", cell: (r) =>
      zone === null ? <StatusText tone="neutral">Default</StatusText>
        : r.inherited ? <StatusText tone="neutral">Inherited</StatusText>
        : <StatusText tone="blue">This zone</StatusText> },
    { key: "edit", header: "Setting", role: "actions", cell: (r) => <RuleEditor key={`${zone}:${r.kind}`} rule={r} zoneId={zone} /> },
  ];

  return (
    <>
      <PageHeader
        back={{ href: "/admin/alerts", label: "Alerts" }}
        title="Alert thresholds"
        description={zone === null
          ? "Platform defaults. Every zone uses these unless it has its own rule."
          : "This zone's rules. A rule here overrides the default until you reset it."}
      />
      {!isSupabaseConfigured ? <PreviewNotice>Connect Supabase to change thresholds.</PreviewNotice> : null}
      <Toolbar>
        <FilterForm action="/admin/settings/alerts">
          <SelectFilter name="zone" label="Zone" value={zone ?? ""} options={[{ value: "", label: "Platform defaults" }, ...zones.map((z) => ({ value: z.id, label: z.name }))]} />
          <FilterSubmit />
        </FilterForm>
      </Toolbar>
      {missing ? (
        <Empty>Alert thresholds need migration 0166 applied to this database.</Empty>
      ) : (
        <DataTable caption="Alert thresholds" columns={columns} rows={rules} rowKey={(r) => r.kind} />
      )}
    </>
  );
}
