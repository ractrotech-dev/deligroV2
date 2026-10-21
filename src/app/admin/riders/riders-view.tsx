import Link from "next/link";
import { Bike } from "lucide-react";
import { Empty, PageHeader, StatusText, Toolbar, type Tone } from "@/components/admin/console";
import { PreviewNotice } from "@/components/admin/admin-ui";
import { DataTable, TableFooter, type Column } from "@/components/admin/data-table";
import { FilterChips, SearchForm } from "@/components/admin/admin-filters";
import type { AdminRiderRow, RiderPhase } from "@/lib/data-access/admin-riders";
import { formatMoney } from "@/lib/rider/admin-money";
import { initials } from "@/lib/utils/format";

type Search = { q?: string; filter?: string };

const PHASES: { value: RiderPhase; label: string }[] = [
  { value: "online", label: "Online" },
  { value: "break", label: "On break" },
  { value: "stale", label: "No position" },
  { value: "offline", label: "Offline" },
];

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

const columns: Column<AdminRiderRow>[] = [
  {
    key: "rider",
    header: "Rider",
    role: "title",
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
    cell: (r) => <StatusText tone={PHASE_TONE[r.phase]}>{PHASE_LABEL[r.phase]}</StatusText>,
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
    header: "Owed",
    align: "right",
    role: "trailing",
    width: "w-[120px]",
    cell: (r) =>
      r.pending === null ? (
        <span className="text-data text-[13px] text-muted" title="Rider money (migration 0083) is not applied yet">
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
    role: "actions",
    align: "right",
    width: "w-[170px]",
    cell: (r) => (
      <span className="inline-flex gap-2">
        <Link href={`/admin/riders/${r.id}`} className="c-btn-quiet press">
          Overview
        </Link>
        <Link href={`/admin/riders/${r.id}?tab=money`} className="c-btn-affirm press">
          Money
        </Link>
      </span>
    ),
  },
];

export type RidersSearch = Search;

/** The Riders list, from rows already read (so a fixture can render it). */
export function RidersView({
  riders,
  sp,
  failed = false,
}: Readonly<{ riders: AdminRiderRow[]; sp: Search; failed?: boolean }>) {
  const q = (sp.q ?? "").trim();
  const needle = q.toLowerCase();
  const filter =
    sp.filter === "owed" || PHASES.some((p) => p.value === sp.filter) ? (sp.filter as string) : null;

  const rows = riders.filter((r) => {
    if (filter === "owed" ? !(r.pending !== null && r.pending !== 0) : filter && r.phase !== filter) return false;
    if (!needle) return true;
    return [r.name, r.phone, r.riderCode].some((v) => (v ?? "").toLowerCase().includes(needle));
  });

  const count = (phase: RiderPhase) => riders.filter((r) => r.phase === phase).length;
  const owedCount = riders.filter((r) => r.pending !== null && r.pending !== 0).length;
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
        description="Who is on the road, what they are carrying, and what they are owed."
        actions={
          <Link href="/admin/riders/incentives" className="c-btn c-btn-outline press">
            Incentive rules
          </Link>
        }
      />

      {failed ? (
        <PreviewNotice>
          <strong>The rider list could not be read.</strong> Reload in a moment; the problem has been logged.
        </PreviewNotice>
      ) : null}
      {moneyMissing ? (
        <PreviewNotice>
          Rider money (migration <code className="rounded bg-surface-2 px-1">0083</code>) is not applied to this
          database yet, so the Owed column shows a dash rather than ₹0.
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
              ...PHASES.map((p) => ({ value: p.value as string, label: p.label, count: count(p.value) })),
              ...(moneyMissing ? [] : [{ value: "owed", label: "Owed money", count: owedCount }]),
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
        minWidth={820}
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
                Rider logins are created under Team. They appear here as soon as they exist.
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
