import { Empty, PageHeader, Section, StatusText, type Tone } from "@/components/admin/console";
import { PreviewNotice } from "@/components/admin/admin-ui";
import { DataTable, type Column } from "@/components/admin/data-table";
import type { AdminAnnouncement } from "@/lib/data-access/announcements";
import { formatDateTime } from "@/lib/utils/relative-time";
import { AnnouncementForm, EndAnnouncementButton } from "./announcement-form";

const STATE: Record<AdminAnnouncement["state"], { tone: Tone; label: string }> = {
  live: { tone: "green", label: "Live" },
  scheduled: { tone: "blue", label: "Scheduled" },
  ended: { tone: "neutral", label: "Ended" },
};
const AUDIENCE: Record<string, string> = { rider: "Riders", vendor: "Shops", manager: "Managers", all: "Everyone working" };

const columns: Column<AdminAnnouncement>[] = [
  {
    key: "title",
    header: "Announcement",
    role: "title",
    cell: (a) => (
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold">{a.title}</span>
        <span className="block truncate text-[11.5px] text-muted">{a.body}</span>
      </span>
    ),
  },
  { key: "audience", header: "For", width: "w-[150px]", cell: (a) => <span className="text-[12.5px]">{AUDIENCE[a.audience] ?? a.audience}</span> },
  {
    key: "when",
    header: "Runs",
    width: "w-[260px]",
    cell: (a) => (
      <span className="text-[12px] text-muted">
        {formatDateTime(a.startsAt)}
        {a.endsAt ? ` – ${formatDateTime(a.endsAt)}` : " onward"}
      </span>
    ),
  },
  { key: "state", header: "State", role: "trailing", width: "w-[120px]", cell: (a) => <StatusText tone={STATE[a.state].tone}>{STATE[a.state].label}</StatusText> },
  {
    key: "end",
    header: "",
    role: "actions",
    align: "right",
    width: "w-[110px]",
    cell: (a) => (a.state === "ended" ? null : <EndAnnouncementButton id={a.id} scheduled={a.state === "scheduled"} />),
  },
];

/** The composer and the list of what was sent (a fixture can render it). */
export function AnnouncementsView({ list, pending = false }: Readonly<{ list: AdminAnnouncement[]; pending?: boolean }>) {
  return (
    <>
      <PageHeader
        title="Announcements"
        description="Tell riders, shops or managers something. It is pinned at the top of their inbox while it runs."
      />
      {pending ? <PreviewNotice>Announcements need migration 0087 (or the Partner app&rsquo;s 0064) applied to this database.</PreviewNotice> : null}
      <AnnouncementForm />
      <Section title="Sent and scheduled" meta={`${list.length} announcement${list.length === 1 ? "" : "s"}`}>
        <DataTable
          caption="Announcements"
          columns={columns}
          rows={list}
          rowKey={(a) => a.id}
          dense
          minWidth={820}
          empty={<Empty>Nothing announced yet.</Empty>}
        />
      </Section>
    </>
  );
}
