import { Bike, ShieldCheck, Users } from "lucide-react";
import {
  StatusText,
  type Tone,
} from "@/components/admin/console";
import {
  AdminHero,
  EmptyState,
  PreviewNotice,
} from "@/components/admin/admin-ui";
import { ConsoleOnly } from "@/components/admin/console-only";
import { StatTile, StatTiles } from "@/components/admin/console-ui";
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
import { CreateEmployeeButton } from "./employees-manager";

/**
 * Settings → Team. An operator creates staff logins here: a manager (full admin
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

export default async function AdminEmployeesPage() {
  const employees = isSupabaseConfigured
    ? await listEmployees().catch(() => [])
    : [];

  const managers = employees.filter((e) => e.role === "manager").length;
  const drivers = employees.filter((e) => e.role === "driver").length;
  const create = <CreateEmployeeButton configured={isSupabaseConfigured} />;

  const columns: Column<EmployeeListItem>[] = [
    {
      key: "name",
      header: "Name",
      role: "title",
      cell: (e) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink">
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
              <span className="shrink-0 @3xl:hidden">
                <StatusText tone={ROLE_TONE[e.role]}>
                  {e.role === "manager" ? "Manager" : "Driver"}
                </StatusText>
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted @3xl:hidden">
              {e.phone ?? "No mobile"}
            </span>
          </span>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      role: "wideOnly",
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
      role: "wideOnly",
      cell: (e) => (
        <span className="text-[13px] text-muted">{e.phone ?? "—"}</span>
      ),
    },
    {
      key: "joined",
      header: "Joined",
      role: "trailing",
      width: "w-[140px]",
      cell: (e) => (
        <span className="text-data text-[13px] text-muted">
          {e.createdAt ? dateFmt.format(new Date(e.createdAt)) : "—"}
        </span>
      ),
    },
  ];

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

      {/* The one explanation for the Create button that drops out of the header
          on a phone. Reading the list is the phone job; issuing a credential is
          not. */}
      <ConsoleOnly
        tool="Creating an employee"
        why="A new login's temporary password is shown once and never again, so it wants a screen you can copy from. Reading the team list works fine here."
      />

      {employees.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No employees yet"
          description="Create a manager or driver login to get started."
          action={isSupabaseConfigured ? create : undefined}
        />
      ) : (
        <>
          <StatTiles>
            <StatTile
              label="Team"
              value={employees.length}
              note="People with a staff login"
            />
            <StatTile
              label="Managers"
              value={managers}
              note="Admin panel access"
            />
            <StatTile
              label="Drivers"
              value={drivers}
              note="Delivery partner app"
            />
          </StatTiles>

          <DataTable
            caption="Team members"
            columns={columns}
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
