import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { Empty, PageHeader, StatusText, Toolbar } from "@/components/admin/console";
import { PreviewNotice } from "@/components/admin/admin-ui";
import { DataTable, type Column } from "@/components/admin/data-table";
import { FilterForm, FilterReset, FilterSubmit } from "@/components/admin/admin-filters";
import { SelectFilter } from "@/components/admin/select-filter";
import { listAudit } from "@/lib/data-access/manager-audit";
import { listCitiesWithZones } from "@/lib/data-access/zones";
import { AUDIT_ACTIONS, auditActionDef } from "@/lib/ops/audit-catalog";
import { auditDiff, parseAuditQuery, type AuditEntry, type AuditQuery } from "@/lib/ops/alerts-contract";
import { formatRelativeTime } from "@/lib/utils/relative-time";

export const metadata: Metadata = { title: "Audit log · Admin · Deligro" };

/**
 * Admin → Audit log (§16): every audited action by managers and admins —
 * who, what, on which record, in which zone, why, and what changed. Read only;
 * nobody can edit it (0141 refuses even the service role). Contact and bank
 * details never appear: the RPCs leave them out and the reader redacts them
 * as a backstop.
 *
 * Platform: BOTH. Filters are a GET form; 100 most recent matching entries.
 */
export const dynamic = "force-dynamic";

const GROUPS = [...new Set(AUDIT_ACTIONS.map((a) => a.group))];
const PREFIX_OF_GROUP: Record<string, string> = Object.fromEntries(
  GROUPS.map((g) => [g, AUDIT_ACTIONS.find((a) => a.group === g)!.code.split(".")[0]])
);

function value(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export default async function AdminAuditPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | undefined>> }>) {
  await requireRole("admin");
  const sp = await searchParams;
  const params = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => !!e[1]));
  const parsed = parseAuditQuery(params);
  // A hand-edited, invalid filter falls back to the default view.
  const q = "error" in parsed ? (parseAuditQuery(new URLSearchParams()) as AuditQuery) : parsed;

  let entries: AuditEntry[] = [];
  let zones: { id: string; name: string }[] = [];
  let missing = false;
  if (isSupabaseConfigured) {
    try {
      const [page, cities] = await Promise.all([listAudit({ all: true }, { ...q, limit: 100 }), listCitiesWithZones()]);
      entries = page.items;
      zones = cities.flatMap((c) => c.zones.map((z) => ({ id: z.id, name: `${z.name} · ${c.name}` })));
    } catch {
      missing = true;
    }
  }
  const zoneName = new Map(zones.map((z) => [z.id, z.name]));
  const filtered = params.size > 0;

  const columns: Column<AuditEntry>[] = [
    { key: "action", header: "Action", role: "title", cell: (e) => {
      const def = auditActionDef(e.action);
      return (
        <span className="block min-w-0">
          <span className="block font-semibold text-ink">{def?.label ?? e.action}</span>
          <span className="block truncate text-xs text-muted">{e.entityType} {e.entityId}</span>
        </span>
      );
    } },
    { key: "who", header: "By", cell: (e) => `${e.actor.name} (${e.actor.role})` },
    { key: "zone", header: "Zone", cell: (e) => (e.zoneId ? (zoneName.get(e.zoneId) ?? "—") : "Platform") },
    { key: "reason", header: "Reason", cell: (e) => e.reason ?? "—" },
    { key: "change", header: "Change", role: "wideOnly", cell: (e) => {
      const diff = auditDiff(e.before, e.after).slice(0, 4);
      if (diff.length === 0) return "—";
      return (
        <span className="block text-xs">
          {diff.map((d) => (
            <span key={d.path} className="block truncate">
              <span className="text-muted">{d.path}:</span> {value(d.before)} → {value(d.after)}
            </span>
          ))}
        </span>
      );
    } },
    { key: "at", header: "When", role: "trailing", width: "w-[120px]", cell: (e) => (
      <span title={new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}>
        {auditActionDef(e.action)?.sensitive ? <StatusText tone="amber">{formatRelativeTime(e.at)}</StatusText> : formatRelativeTime(e.at)}
      </span>
    ) },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every audited action by managers and admins, newest first. Sensitive actions (money, accounts, personal data) are marked."
      />
      {!isSupabaseConfigured ? <PreviewNotice>Connect Supabase to read the audit log.</PreviewNotice> : null}
      <Toolbar>
        <FilterForm action="/admin/audit">
          <SelectFilter name="action" label="Area" value={sp.action ?? ""} options={[
            { value: "", label: "Everything" },
            ...GROUPS.map((g) => ({ value: `${PREFIX_OF_GROUP[g]}.*`, label: g })),
          ]} />
          <SelectFilter name="zone" label="Zone" value={sp.zone ?? ""} options={[{ value: "", label: "Every zone" }, ...zones.map((z) => ({ value: z.id, label: z.name }))]} />
          <FilterSubmit />
          {filtered ? <FilterReset href="/admin/audit" /> : null}
        </FilterForm>
      </Toolbar>
      {missing ? (
        <Empty>The audit log needs migration 0141 applied to this database.</Empty>
      ) : (
        <DataTable
          caption="Audit log"
          columns={columns}
          rows={entries}
          rowKey={(e) => String(e.id)}
          empty={<Empty action={filtered ? { href: "/admin/audit", label: "Clear filters" } : undefined}>No entries match.</Empty>}
        />
      )}
    </>
  );
}
