import Link from "next/link";
import { Empty, PageHeader, StatusText, Toolbar, type Tone } from "@/components/admin/console";
import { PreviewNotice } from "@/components/admin/admin-ui";
import { DataTable, type Column } from "@/components/admin/data-table";
import { FilterForm, FilterReset, FilterSubmit } from "@/components/admin/admin-filters";
import { SelectFilter } from "@/components/admin/select-filter";
import { EmergencyBanner } from "@/components/ops/emergency-banner";
import type { EmergencyItem } from "@/components/ops/emergency-types";
import type { StaffTicketRow } from "@/lib/data-access/support";
import {
  PICKUP_REPORT_CATEGORIES,
  RIDER_TICKET_CATEGORIES,
  SAFETY_CATEGORIES,
  TICKET_STATUSES,
  categoryLabel,
  statusLabel,
  type TicketFilter,
} from "@/lib/support/rules";
import { formatRelativeTime } from "@/lib/utils/relative-time";

export const STATUS_TONE: Record<string, Tone> = {
  open: "amber",
  in_progress: "blue",
  waiting_on_requester: "accent",
  escalated: "red",
  resolved: "green",
  closed: "neutral",
};

const PRIORITY_TONE: Record<string, Tone> = { emergency: "red", high: "amber", normal: "neutral" };
const PRIORITY_LABEL: Record<string, string> = { emergency: "Emergency", high: "High", normal: "Normal" };
const ROLE_LABEL: Record<string, string> = { rider: "Rider", vendor: "Shop", customer: "Customer", manager: "Manager" };

/** Staff wording for the requester's statuses ("Waiting for your reply" is the rider's). */
export function staffStatusLabel(status: string): string {
  return status === "waiting_on_requester" ? "Waiting on them" : statusLabel(status);
}

const isLiveEmergency = (r: StaffTicketRow) =>
  r.priority === "emergency" && !["resolved", "closed"].includes(r.status);

const columns: Column<StaffTicketRow>[] = [
  {
    key: "ticket",
    header: "Ticket",
    role: "title",
    cell: (r) => (
      <span className="min-w-0">
        <span className={`block truncate text-[13px] font-semibold ${isLiveEmergency(r) ? "text-deal" : ""}`}>
          #{r.number} · {r.subject}
        </span>
        <span className="block truncate text-[11.5px] text-muted">
          {r.requesterName} · {ROLE_LABEL[r.requesterRole] ?? r.requesterRole}
          {r.orderCode ? ` · order ${r.orderCode}` : ""}
        </span>
      </span>
    ),
  },
  { key: "category", header: "Category", width: "w-[200px]", cell: (r) => <span className="text-[12.5px]">{r.categoryLabel}</span> },
  {
    key: "priority",
    header: "Priority",
    width: "w-[120px]",
    cell: (r) => <StatusText tone={PRIORITY_TONE[r.priority] ?? "neutral"}>{PRIORITY_LABEL[r.priority] ?? r.priority}</StatusText>,
  },
  {
    key: "status",
    header: "Status",
    role: "trailing",
    width: "w-[160px]",
    cell: (r) => <StatusText tone={STATUS_TONE[r.status] ?? "neutral"}>{staffStatusLabel(r.status)}</StatusText>,
  },
  {
    key: "updated",
    header: "Last activity",
    width: "w-[140px]",
    cell: (r) => <span className="text-[12px] text-muted">{formatRelativeTime(r.updatedAt)}</span>,
  },
  {
    key: "open",
    header: "",
    role: "actions",
    align: "right",
    width: "w-[90px]",
    cell: (r) => (
      <Link href={`/admin/support/${r.id}`} className="c-btn-quiet press">
        Open
      </Link>
    ),
  },
];

const CATEGORY_OPTIONS = [
  { value: "", label: "Every category" },
  ...[...RIDER_TICKET_CATEGORIES, ...SAFETY_CATEGORIES, ...PICKUP_REPORT_CATEGORIES].map((c) => ({ value: c, label: categoryLabel(c) })),
];

/** The desk, from rows already read (a fixture can render it). */
export function SupportView({
  tickets,
  emergencies,
  filter,
  pending = false,
  poll = true,
}: Readonly<{
  tickets: StaffTicketRow[];
  emergencies: EmergencyItem[];
  filter: TicketFilter;
  pending?: boolean;
  /** The banner reads the live feed every few seconds; a fixture turns it off. */
  poll?: boolean;
}>) {
  const filtered = Object.keys(filter).length > 0;
  return (
    <>
      <PageHeader
        title="Support"
        description="Tickets and incidents from riders and shops. Emergencies stay pinned on top until they are resolved."
        actions={
          <Link href="/admin/announcements" className="c-btn c-btn-outline press">
            Announcements
          </Link>
        }
      />

      {pending ? <PreviewNotice>Support tickets need migration 0087 applied to this database.</PreviewNotice> : null}

      <EmergencyBanner items={emergencies} poll={poll} basePath="/admin/support" className="mb-4" />

      <Toolbar>
        <FilterForm action="/admin/support">
          <SelectFilter
            name="role"
            label="Who raised it"
            value={filter.role ?? ""}
            options={[
              { value: "", label: "Everyone" },
              { value: "rider", label: "Riders" },
              { value: "vendor", label: "Shops" },
              { value: "customer", label: "Customers" },
            ]}
          />
          <SelectFilter name="category" label="Category" value={filter.category ?? ""} options={CATEGORY_OPTIONS} />
          <SelectFilter
            name="priority"
            label="Priority"
            value={filter.priority ?? ""}
            options={[
              { value: "", label: "Any priority" },
              { value: "emergency", label: "Emergency" },
              { value: "high", label: "High" },
              { value: "normal", label: "Normal" },
            ]}
          />
          <SelectFilter
            name="status"
            label="Status"
            value={filter.status ?? ""}
            options={[{ value: "", label: "Any status" }, ...TICKET_STATUSES.map((s) => ({ value: s, label: staffStatusLabel(s) }))]}
          />
          <FilterSubmit />
          {filtered ? <FilterReset href="/admin/support" /> : null}
        </FilterForm>
      </Toolbar>

      <DataTable
        caption="Support tickets"
        columns={columns}
        rows={tickets}
        rowKey={(r) => r.id}
        rowHref={(r) => `/admin/support/${r.id}`}
        rowTone={(r) => (isLiveEmergency(r) ? "alert" : null)}
        dense
        minWidth={900}
        empty={
          filtered ? (
            <Empty action={{ href: "/admin/support", label: "Clear filters" }}>No ticket matches these filters.</Empty>
          ) : (
            <Empty>No tickets yet. Riders raise them from Help and Safety in the app.</Empty>
          )
        }
      />
    </>
  );
}
