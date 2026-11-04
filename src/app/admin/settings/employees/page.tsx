import { requireRole } from "@/lib/auth";
import { Bike, ShieldCheck, UserCog, Users } from "lucide-react";
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
  listStaffLoginEmails,
  type EmployeeListItem,
} from "@/lib/data-access/employees";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listCitiesWithZones, listStaffZonesFor } from "@/lib/data-access/zones";
import { CreateEmployeeButton } from "./employees-manager";
import Link from "next/link";
import { CopyLoginEmail } from "./copy-login-email";
import { StaffAccessControls } from "./staff-access-controls";
import { ManagerZonesCell, type ZoneOption } from "./manager-zones-cell";

/**
 * Settings → Team. An operator creates staff logins here: a manager (the Manager
 * app, scoped to the zones assigned here and the powers granted in Feature
 * access) or a driver (delivery app). The list shows every admin, manager and
 * driver (developer accounts and the master account are left out). Any of them can
 * have their password reset, and each manager or driver can be deactivated, activated again, given a new
 * password or removed (the rules are on the server, data-access/staff-access.ts). Reached
 * from the Settings menu. Platform: WEB (the admin console is desktop only).
 */
export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const ROLE_LABEL = { admin: "Admin", manager: "Manager", driver: "Driver" } as const;

const ROLE_TONE = {
  admin: "blue",
  manager: "green",
  driver: "accent",
} as const satisfies Record<string, Tone>;

type TeamRow = EmployeeListItem & { zoneIds: string[]; loginEmail: string | null };

function columnsFor(zoneOptions: ZoneOption[], myId: string): Column<TeamRow>[] {
  return [...baseColumns, zoneColumn(zoneOptions), joinedColumn, accessColumn, featuresColumn, controlsColumn(myId)];
}

const accessColumn: Column<TeamRow> = {
  key: "access",
  header: "Access",
  width: "w-[100px]",
  cell: (e) => <StatusText tone={e.stopped ? "red" : "green"}>{e.stopped ? "Deactivated" : "Active"}</StatusText>,
};

/** This person's own settings in Admin → App features. */
const featuresColumn: Column<TeamRow> = {
  key: "features",
  header: "Features",
  width: "w-[90px]",
  cell: (e) => e.role === "admin" ? <span className="text-[13px] text-muted">All</span> : (
    <Link
      href={`/admin/settings/feature-access?role=${e.role}&account=${e.id}`}
      className="text-[13px] font-semibold text-accent-ink hover:underline"
    >
      Change
    </Link>
  ),
};

/** No buttons on your own row: the server refuses them, whoever you are. */
function controlsColumn(myId: string): Column<TeamRow> {
  return {
    key: "controls",
    header: "",
    align: "right",
    width: "w-[300px]",
    cell: (e) => e.id === myId ? null : (
      <StaffAccessControls id={e.id} name={e.fullName ?? "this person"} role={e.role} stopped={e.stopped} />
    ),
  };
}

/** The zones a manager or rider works, editable in place (migration 0141). A
 * manager sees the orders of their zones and the riders who share one. */
function zoneColumn(options: ZoneOption[]): Column<TeamRow> {
  return {
    key: "zones",
    header: "Zones",
    cell: (e) => e.role === "admin" ? <span className="text-[13px] text-muted">All zones</span> : (
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
          {e.role === "admin" ? (
            <UserCog className="size-4" />
          ) : e.role === "manager" ? (
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
        {ROLE_LABEL[e.role]}
      </StatusText>
    ),
  },
  {
    key: "login",
    header: "Login",
    cell: (e) => (
      <span className="block min-w-0 text-[13px]">
        {e.loginEmail ? <CopyLoginEmail email={e.loginEmail} /> : <span className="block text-ink">—</span>}
        <span className="block text-muted">{e.phone ?? "No mobile"}</span>
      </span>
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
  const me = await requireRole("admin");

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
  // A failed read costs the email on screen, not the page.
  const logins = isSupabaseConfigured
    ? await listStaffLoginEmails(staffIds).catch(() => new Map<string, string>())
    : new Map<string, string>();
  const employees: TeamRow[] = list.map((e) => ({
    ...e,
    zoneIds: zoneMap.get(e.id) ?? [],
    loginEmail: logins.get(e.id) ?? null,
  }));

  const admins = employees.filter((e) => e.role === "admin").length;
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
        subtitle="Create manager and driver logins, deactivate or remove them. Passwords can't be viewed: Reset password gives a new one to hand over."
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
              label="Admins"
              value={admins}
              note="Full access"
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
            columns={columnsFor(zoneOptions, me.id)}
            rows={employees}
            rowKey={(e) => e.id}
            minWidth={1160}
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
