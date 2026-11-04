import { requireRole } from "@/lib/auth";
import { Bike, ShieldCheck, Users } from "lucide-react";
import {
  Figure,
  FigureRow,
  StatusText,
  type Tone,
} from "@/components/admin/console";
import {
  AdminHero,
  EmptyState,
  PreviewNotice,
} from "@/components/admin/admin-ui";
import {
  DataTable,
  TableFooter,
  type Column,
} from "@/components/admin/data-table";
import {
  listEmployees,
  type EmployeeListItem,
} from "@/lib/data-access/employees";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listCitiesWithZones, listStaffZonesFor } from "@/lib/data-access/zones";
import { CreateEmployeeButton } from "./employees-manager";
import { ManagerZonesCell, type ZoneOption } from "./manager-zones-cell";

/**
 * Settings → Team. An operator creates staff logins here: a manager (the Manager
 * app, scoped to the zones assigned here and the powers granted in Feature
 * access) or a driver (delivery app). The list shows everyone who currently has
 * a privileged role. Reached from the Settings menu.
 */
export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const ROLE_TONE = {
  manager: "green",
  driver: "accent",
} as const satisfies Record<string, Tone>;

type TeamRow = EmployeeListItem & { zoneIds: string[] };

function columnsFor(zoneOptions: ZoneOption[]): Column<TeamRow>[] {
  return [...baseColumns, zoneColumn(zoneOptions), joinedColumn];
}

/** The zones a manager or rider works, editable in place (migration 0141). A
 * manager sees the orders of their zones and the riders who share one. */
function zoneColumn(options: ZoneOption[]): Column<TeamRow> {
  return {
    key: "zones",
    header: "Zones",
    cell: (e) => (
      <ManagerZonesCell
        managerId={e.id}
        zoneIds={e.zoneIds}
        options={options}
        disabled={!isSupabaseConfigured}
      />
    ),
  };
}

const baseColumns: Column<TeamRow>[] = [
  {
    key: "name",
    header: "Name",
    cell: (e) => (
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[var(--c-r)] bg-surface-2 text-ink">
          {e.role === "manager" ? (
            <ShieldCheck className="size-4" />
          ) : (
            <Bike className="size-4" />
          )}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-semibold">
              {e.fullName ?? "Unnamed"}
            </span>
          </span>
        </span>
      </div>
    ),
  },
  {
    key: "role",
    header: "Role",
    width: "w-[140px]",
    cell: (e) => (
      <StatusText tone={ROLE_TONE[e.role]}>
        {e.role === "manager" ? "Manager" : "Driver"}
      </StatusText>
    ),
  },
  {
    key: "phone",
    header: "Mobile",
    cell: (e) => (
      <span className="text-[13px] text-muted">{e.phone ?? "—"}</span>
    ),
  },
];

const joinedColumn: Column<TeamRow> = {
  key: "joined",
  header: "Joined",
  width: "w-[140px]",
  cell: (e) => (
    <span className="text-data text-[13px] text-muted">
      {e.createdAt ? dateFmt.format(new Date(e.createdAt)) : "—"}
    </span>
  ),
};

export default async function AdminEmployeesPage() {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const list = isSupabaseConfigured
    ? await listEmployees().catch(() => [])
    : [];

  // Zones are 0141: before it is applied both reads fail and the column says
  // "No zones" with Edit disabled (no options).
  const staffIds = list.map((e) => e.id);
  const [zoneMap, cities] = isSupabaseConfigured
    ? await Promise.all([
        listStaffZonesFor(staffIds).catch(() => new Map<string, string[]>()),
        listCitiesWithZones().catch(() => []),
      ])
    : [new Map<string, string[]>(), []];
  const zoneOptions: ZoneOption[] = cities.flatMap((c) =>
    c.zones.map((z) => ({ id: z.id, label: cities.length > 1 ? `${c.name} · ${z.name}` : z.name }))
  );
  const employees: TeamRow[] = list.map((e) => ({ ...e, zoneIds: zoneMap.get(e.id) ?? [] }));

  const managers = employees.filter((e) => e.role === "manager").length;
  const drivers = employees.filter((e) => e.role === "driver").length;
  const create = <CreateEmployeeButton configured={isSupabaseConfigured} />;

  return (
    <>
      <AdminHero
        backHref="/admin/settings"
        backLabel="Settings"
        title="Team"
        tag={`${employees.length} with access`}
        subtitle="Create manager and driver logins, and see who has access."
        action={create}
      />

      {!isSupabaseConfigured ? (
        <PreviewNotice>
          Connect Supabase to create and manage employees.
        </PreviewNotice>
      ) : null}


      {employees.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No employees yet"
          description="Create a manager or driver login to get started."
          action={isSupabaseConfigured ? create : undefined}
        />
      ) : (
        <>
          <FigureRow>
            <Figure
              label="Team"
              value={employees.length}
              note="People with a staff login"
            />
            <Figure
              label="Managers"
              value={managers}
              note="Their zones only"
            />
            <Figure
              label="Drivers"
              value={drivers}
              note="Delivery partner app"
            />
          </FigureRow>

          <DataTable
            caption="Team members"
            columns={columnsFor(zoneOptions)}
            rows={employees}
            rowKey={(e) => e.id}
            minWidth={720}
            footer={
              <TableFooter
                page={1}
                totalPages={1}
                hrefFor={() => "/admin/settings/employees"}
                summary={`${employees.length} member${employees.length === 1 ? "" : "s"}`}
              />
            }
          />
        </>
      )}
    </>
  );
}
