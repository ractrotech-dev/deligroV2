import Link from "next/link";
import { Bike } from "lucide-react";
import { Empty, PageHeader, StatusText, Toolbar, type Tone } from "@/components/admin/console";
import { PreviewNotice } from "@/components/admin/admin-ui";
import { DataTable, TableFooter, type Column } from "@/components/admin/data-table";
import { FilterChips, SearchForm } from "@/components/admin/admin-filters";
import type { AdminRiderRow, RiderPhase } from "@/lib/data-access/admin-riders";
import type { ReviewFlags } from "@/lib/data-access/admin-rider-profile";
import { formatMoney } from "@/lib/rider/admin-money";
import { CreateEmployeeButton } from "@/app/admin/settings/employees/employees-manager";
import { RiderAccountButton } from "./rider-account";
import { initials } from "@/lib/utils/format";

type Search = { q?: string; filter?: string };

/**
 * The four filters. Older addresses (?filter=online, ?filter=review and so on)
 * still work: each lands on the filter that now covers it.
 */
type View = "duty" | "owed" | "check" | "offline";
const FILTER_OF = new Map<string, View>([
  ["duty", "duty"],
  ["online", "duty"],
  ["break", "duty"],
  ["stale", "duty"],
  ["offline", "offline"],
  ["owed", "owed"],
  ["check", "check"],
  ["review", "check"],
  ["expiring", "check"],
]);

const PHASE_TONE: Record<RiderPhase, Tone> = {
  online: "green",
  break: "amber",
  stale: "amber",
  offline: "neutral",
};
const PHASE_LABEL: Record<RiderPhase, string> = {
  online: "Online",
  break: "On break",
  stale: "Online, no recent position",
  offline: "Offline",
};

/** A list row with its 0086 review flags (null before 0086, or no rider_profiles row). */
type ListRow = AdminRiderRow & { review: ReviewFlags | null; loginEmail: string | null; stopped: boolean };

const VERIFICATION_TONE: Record<string, Tone> = { verified: "neutral", pending: "amber", rejected: "red", unverified: "neutral" };
const VERIFICATION_LABEL: Record<string, string> = {
  verified: "Verified",
  pending: "To review",
  rejected: "Rejected",
  unverified: "Not verified",
};

function reviewNote(f: ReviewFlags): string | null {
  const parts = [
    f.pendingDocuments > 0 ? `${f.pendingDocuments} ${f.pendingDocuments === 1 ? "document" : "documents"}` : null,
    f.pendingChanges > 0 ? `${f.pendingChanges} ${f.pendingChanges === 1 ? "change" : "changes"}` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")} waiting` : null;
}

/** Whether a rider has paperwork for someone to look at. */
const needsChecking = (f: ReviewFlags | null) => !!f && (f.needsReview || f.expiringDocuments > 0);

/** Verification and documents, as the one thing to know about them. */
function Paperwork({ review: f }: Readonly<{ review: ReviewFlags | null }>) {
  if (!f) return <span className="text-[12.5px] text-muted">-</span>;
  const waiting = reviewNote(f);
  const expiring = f.expiringDocuments > 0 ? `${f.expiringDocuments} expiring` : null;
  const headline = waiting ?? expiring ?? (f.verification === "verified" ? null : VERIFICATION_LABEL[f.verification] ?? f.verification);
  if (!headline) return <span className="text-[12.5px] text-muted">All good</span>;
  const tone = waiting || expiring ? (f.verification === "rejected" ? "red" : "amber") : VERIFICATION_TONE[f.verification] ?? "neutral";
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <StatusText tone={tone}>{headline}</StatusText>
      {waiting && expiring ? <span className="text-[11.5px] text-muted">{expiring}</span> : null}
    </span>
  );
}

const columns: Column<ListRow>[] = [
  {
    key: "rider",
    header: "Rider",
    cell: (r) => (
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-[11px] font-bold text-accent-ink">
          {initials(r.name ?? "Rider")}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold">{r.name ?? "Unnamed rider"}</span>
          <span className="text-data block truncate text-[11.5px] text-muted">
            {[r.riderCode, r.phone].filter(Boolean).join(" · ") || "No phone on file"}
          </span>
        </span>
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    width: "w-[210px]",
    cell: (r) =>
      r.stopped ? <StatusText tone="red">Deactivated</StatusText> : <StatusText tone={PHASE_TONE[r.phase]}>{PHASE_LABEL[r.phase]}</StatusText>,
  },
  {
    key: "paperwork",
    header: "Documents",
    width: "w-[190px]",
    cell: (r) => <Paperwork review={r.review} />,
  },
  {
    key: "order",
    header: "On delivery",
    width: "w-[130px]",
    cell: (r) =>
      r.activeOrderId ? (
        <Link
          href={`/admin/orders/${r.activeOrderId}`}
          className="text-data text-[12.5px] font-semibold text-accent-ink hover:underline"
        >
          {r.activeOrderCode}
        </Link>
      ) : (
        <span className="text-[12.5px] text-muted">None</span>
      ),
  },
  {
    key: "today",
    header: "Delivered today",
    align: "right",
    width: "w-[130px]",
    cell: (r) => (
      <span className={r.deliveredToday > 0 ? "text-data text-[13px] font-semibold tabular-nums" : "text-data text-[13px] tabular-nums text-muted"}>
        {r.deliveredToday}
      </span>
    ),
  },
  {
    key: "owed",
    header: "To pay",
    align: "right",
    width: "w-[120px]",
    cell: (r) =>
      r.pending === null ? (
        <span className="text-data text-[13px] text-muted" title="Rider money isn't set up yet">
          -
        </span>
      ) : (
        <span
          className={
            r.pending < 0
              ? "text-data text-[13px] font-semibold tabular-nums text-deal"
              : r.pending > 0
                ? "text-data text-[13px] font-semibold tabular-nums"
                : "text-data text-[13px] tabular-nums text-muted"
          }
        >
          {formatMoney(r.pending)}
        </span>
      ),
  },
  {
    key: "actions",
    header: "",
    align: "right",
    width: "w-[170px]",
    cell: (r) => (
      <span className="inline-flex gap-2">
        <RiderAccountButton id={r.id} name={r.name ?? "this rider"} email={r.loginEmail} phone={r.phone} stopped={r.stopped} />
        <Link href={`/admin/riders/${r.id}?tab=salary`} className="c-btn-affirm">
          Salary
        </Link>
      </span>
    ),
  },
];

export type RidersSearch = Search;

/** The Riders list, from rows already read (so a fixture can render it). */
export function RidersView({
  riders: base,
  sp,
  failed = false,
  flags = {},
  logins = {},
  stopped = [],
  canAdd = false,
}: Readonly<{
  riders: AdminRiderRow[];
  sp: Search;
  failed?: boolean;
  /** 0086 review flags by rider id; empty before 0086. */
  flags?: Record<string, ReviewFlags>;
  /** The email each rider signs in with, by rider id. */
  logins?: Record<string, string>;
  /** Ids of deactivated riders. */
  stopped?: string[];
  /** Whether a rider can be added here (false in demo mode). */
  canAdd?: boolean;
}>) {
  const riders: ListRow[] = base.map((r) => ({ ...r, review: flags[r.id] ?? null, loginEmail: logins[r.id] ?? null, stopped: stopped.includes(r.id) }));
  const hasFlags = Object.keys(flags).length > 0;
  const q = (sp.q ?? "").trim();
  const needle = q.toLowerCase();
  const filter: View | null = FILTER_OF.get(sp.filter ?? "") ?? null;

  const inView = (r: ListRow, view: View) =>
    view === "duty"
      ? r.phase !== "offline"
      : view === "offline"
        ? r.phase === "offline"
        : view === "owed"
          ? r.pending !== null && r.pending !== 0
          : needsChecking(r.review);

  const rows = riders.filter((r) => {
    if (filter && !inView(r, filter)) return false;
    if (!needle) return true;
    return [r.name, r.phone, r.riderCode].some((v) => (v ?? "").toLowerCase().includes(needle));
  });

  const count = (view: View) => riders.filter((r) => inView(r, view)).length;
  const moneyMissing = riders.length > 0 && riders.every((r) => r.pending === null);

  const href = (next: Partial<Search>) => {
    const usp = new URLSearchParams();
    const merged = { q, filter: filter ?? undefined, ...next };
    if (merged.q) usp.set("q", merged.q);
    if (merged.filter) usp.set("filter", merged.filter);
    const query = usp.toString();
    return query ? `/admin/riders?${query}` : "/admin/riders";
  };
  const filtered = Boolean(q || filter);

  return (
    <>
      <PageHeader
        title="Riders"
        description="Who is working, and who needs paying."
        actions={
          <>
            <Link href="/admin/riders/payments" className="c-btn c-btn-outline">
              Rider salaries
            </Link>
            <CreateEmployeeButton configured={canAdd} role="driver" />
          </>
        }
      />

      {failed ? (
        <PreviewNotice>
          <strong>The rider list could not be read.</strong> Reload in a moment; the problem has been logged.
        </PreviewNotice>
      ) : null}
      {moneyMissing ? (
        <PreviewNotice>
          Rider money isn&apos;t set up on this database yet, so the To pay column shows a dash rather than ₹0.
        </PreviewNotice>
      ) : null}

      {riders.length > 0 ? (
        <Toolbar>
          <SearchForm
            action="/admin/riders"
            defaultValue={q}
            placeholder="Name, phone or rider ID"
            carry={{ filter: filter ?? undefined }}
          />
          <FilterChips
            label="Rider filter"
            options={[
              { value: "duty", label: "On duty", count: count("duty") },
              ...(moneyMissing ? [] : [{ value: "owed", label: "To pay", count: count("owed") }]),
              ...(hasFlags ? [{ value: "check", label: "Documents to check", count: count("check") }] : []),
              { value: "offline", label: "Offline", count: count("offline") },
            ]}
            active={filter}
            hrefFor={(v) => href({ filter: v ?? undefined })}
          />
        </Toolbar>
      ) : null}

      <DataTable
        caption="Riders"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowHref={(r) => `/admin/riders/${r.id}`}
        minWidth={960}
        footer={
          <TableFooter
            page={1}
            totalPages={1}
            hrefFor={() => "/admin/riders"}
            summary={filtered ? `${rows.length} of ${riders.length} riders` : `${riders.length} ${riders.length === 1 ? "rider" : "riders"}`}
          />
        }
        empty={
          riders.length === 0 && !failed ? (
            <div className="rounded-[var(--c-r)] border border-dashed border-line px-4 py-10 text-center">
              <Bike className="mx-auto size-6 text-muted" aria-hidden="true" />
              <p className="mt-2 text-sm font-semibold">No riders yet</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
                Use Add rider to create the first one.
              </p>
            </div>
          ) : (
            <Empty action={filtered ? { href: "/admin/riders", label: "Clear filters" } : undefined}>
              {filtered ? `No rider matches among the ${riders.length}.` : "No riders to show."}
            </Empty>
          )
        }
      />
    </>
  );
}
