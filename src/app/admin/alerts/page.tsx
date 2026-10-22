import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { Empty, PageHeader, StatusText, Toolbar, type Tone } from "@/components/admin/console";
import { PreviewNotice } from "@/components/admin/admin-ui";
import { DataTable, type Column } from "@/components/admin/data-table";
import { FilterForm, FilterReset, FilterSubmit } from "@/components/admin/admin-filters";
import { SelectFilter } from "@/components/admin/select-filter";
import { listAlerts } from "@/lib/data-access/manager-alerts";
import { listCitiesWithZones } from "@/lib/data-access/zones";
import { ALERT_KINDS } from "@/lib/ops/alerts/catalog";
import { parseAlertQuery, type Alert, type AlertQuery } from "@/lib/ops/alerts-contract";
import { formatRelativeTime } from "@/lib/utils/relative-time";
import { AlertRowActions } from "./alert-row-actions";

export const metadata: Metadata = { title: "Alerts · Admin · Deligro" };

/**
 * Admin → Alerts (§14): every operational alert across zones — critical first
 * — with acknowledge and resolve. The same store the Manager app reads; the
 * engine raises and clears them from the dispatch sweep.
 *
 * Platform: BOTH. A `DataTable` at a desk, stacked cards in the phone frame;
 * the filters are a GET form, so a filtered view survives a reload.
 */
export const dynamic = "force-dynamic";

const SEVERITY_TONE: Record<string, Tone> = { critical: "red", warning: "amber", info: "blue" };
const STATUS_TONE: Record<string, Tone> = { open: "amber", acknowledged: "blue", resolved: "green" };
const STATUS_LABEL: Record<string, string> = { open: "Open", acknowledged: "Acknowledged", resolved: "Resolved" };
const KIND_LABEL = new Map(ALERT_KINDS.map((k) => [k.kind, k.label]));

export default async function AdminAlertsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | undefined>> }>) {
  await requireRole("admin");
  const sp = await searchParams;
  const params = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => !!e[1]));
  const parsed = parseAlertQuery(params);
  // A hand-edited, invalid filter falls back to the default view.
  const q = "error" in parsed ? (parseAlertQuery(new URLSearchParams()) as AlertQuery) : parsed;

  let alerts: Alert[] = [];
  let counts = { open: 0, acknowledged: 0, critical: 0 };
  let zones: { id: string; name: string }[] = [];
  let missing = false;
  if (isSupabaseConfigured) {
    try {
      const [page, cities] = await Promise.all([
        listAlerts({ all: true }, { admin: true, permissions: {} }, { ...q, limit: 100 }, new Date()),
        listCitiesWithZones(),
      ]);
      alerts = page.items;
      counts = page.counts;
      zones = cities.flatMap((c) => c.zones.map((z) => ({ id: z.id, name: `${z.name} · ${c.name}` })));
    } catch {
      missing = true;
    }
  }
  const zoneName = new Map(zones.map((z) => [z.id, z.name]));
  const filtered = params.size > 0;

  const columns: Column<Alert>[] = [
    { key: "title", header: "Alert", role: "title", cell: (a) => (
      <span className="block min-w-0">
        <span className="block truncate font-semibold text-ink">{a.title}</span>
        <span className="block truncate text-xs text-muted">{a.body}</span>
      </span>
    ) },
    { key: "severity", header: "Severity", role: "trailing", width: "w-[110px]", cell: (a) => (
      <StatusText tone={SEVERITY_TONE[a.severity] ?? "neutral"}>{a.severity === "critical" ? "Critical" : a.severity === "warning" ? "Warning" : "Info"}</StatusText>
    ) },
    { key: "kind", header: "Kind", cell: (a) => KIND_LABEL.get(a.kind) ?? a.kind },
    { key: "zone", header: "Zone", cell: (a) => (a.zoneId ? (zoneName.get(a.zoneId) ?? "—") : "Everywhere") },
    { key: "status", header: "Status", cell: (a) => <StatusText tone={STATUS_TONE[a.status] ?? "neutral"}>{STATUS_LABEL[a.status] ?? a.status}</StatusText> },
    { key: "seen", header: "Last seen", width: "w-[120px]", cell: (a) => formatRelativeTime(a.lastSeenAt) },
    { key: "actions", header: "", role: "actions", cell: (a) => <AlertRowActions id={a.id} status={a.status} /> },
  ];

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Conditions that need a person: orders stuck or late, riders short, shops down, money and cash, urgent tickets, incidents. They clear themselves when the condition goes."
        status={`${counts.open} open · ${counts.critical} critical`}
        actions={<Link href="/admin/settings/alerts" className="c-btn c-btn-outline press">Thresholds</Link>}
      />
      {!isSupabaseConfigured ? <PreviewNotice>Connect Supabase to see alerts.</PreviewNotice> : null}
      <Toolbar>
        <FilterForm action="/admin/alerts">
          <SelectFilter name="status" label="Status" value={sp.status ?? ""} options={[
            { value: "", label: "Open and acknowledged" },
            { value: "open", label: "Open" },
            { value: "acknowledged", label: "Acknowledged" },
            { value: "resolved", label: "Resolved (last 7 days)" },
          ]} />
          <SelectFilter name="severity" label="Severity" value={sp.severity ?? ""} options={[
            { value: "", label: "Any severity" },
            { value: "critical", label: "Critical" },
            { value: "warning", label: "Warning" },
            { value: "info", label: "Info" },
          ]} />
          <SelectFilter name="kind" label="Kind" value={sp.kind ?? ""} options={[
            { value: "", label: "Every kind" },
            ...ALERT_KINDS.filter((k) => k.evaluated !== "phase9").map((k) => ({ value: k.kind, label: k.label })),
          ]} />
          <SelectFilter name="zone" label="Zone" value={sp.zone ?? ""} options={[{ value: "", label: "Every zone" }, ...zones.map((z) => ({ value: z.id, label: z.name }))]} />
          <FilterSubmit />
          {filtered ? <FilterReset href="/admin/alerts" /> : null}
        </FilterForm>
      </Toolbar>
      {missing ? (
        <Empty>Alerts need migrations 0165–0167 applied to this database.</Empty>
      ) : (
        <DataTable
          caption="Alerts"
          columns={columns}
          rows={alerts}
          rowKey={(a) => a.id}
          empty={<Empty action={filtered ? { href: "/admin/alerts", label: "Clear filters" } : undefined}>No alerts match.</Empty>}
        />
      )}
    </>
  );
}
