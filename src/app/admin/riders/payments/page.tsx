import Link from "next/link";
import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { Empty, PageHeader, Section, StatusBadge, StatusText, Tabs, type Tone } from "@/components/admin/console";
import { DataTable, TableFooter, type Column } from "@/components/admin/data-table";
import { captureError } from "@/lib/obs/emit";
import { listRiderPayments, type RiderPaymentList } from "@/lib/data-access/admin-rider-payments";
import { decodeTimeCursor, type PaymentRequest } from "@/lib/ops/rider-contract";
import { PAYOUT_METHOD_LABELS, formatDay, formatMoney } from "@/lib/rider/admin-money";
import { istDay } from "@/lib/rider/earnings-math";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatDateTime } from "@/lib/utils/relative-time";
import { PaymentDecision } from "./payment-decision";

export const metadata: Metadata = { title: "Rider salaries · Admin · Deligro" };

/**
 * Admin → Riders → Rider salaries. WEB. Riders are on a fixed salary. Every salary
 * payment, waiting ones first:
 * the money itself moves by bank or UPI outside the app. A manager's request
 * waits here; an admin paying from a rider's Money tab finishes in one step and
 * lands here only if that step could not complete.
 *
 * Decisions go through the shared payment-request path (0152), so a payment made
 * here writes the same audit row as one made in the manager app.
 */
export const dynamic = "force-dynamic";

type Status = PaymentRequest["status"];
const STATUSES: Status[] = ["pending_approval", "approved", "rejected", "cancelled"];
const STATUS_LABEL: Record<Status, string> = {
  pending_approval: "Waiting",
  approved: "Paid",
  rejected: "Rejected",
  cancelled: "Cancelled",
};
const STATUS_TONE: Record<Status, Tone> = {
  pending_approval: "amber",
  approved: "green",
  rejected: "red",
  cancelled: "neutral",
};

const hrefOf = (status: Status, cursor?: string) => {
  const params = new URLSearchParams();
  if (status !== "pending_approval") params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `/admin/riders/payments?${qs}` : "/admin/riders/payments";
};

function methodWord(r: PaymentRequest): string {
  return r.method ? PAYOUT_METHOD_LABELS[r.method] : "-";
}

export default async function RiderPaymentsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ status?: string; cursor?: string }> }>) {
  // The layout is not a guard: the page that reads service-role data checks for itself.
  const admin = await requireRole("admin");
  const sp = await searchParams;
  const status: Status = STATUSES.includes(sp.status as Status) ? (sp.status as Status) : "pending_approval";
  const cursor = sp.cursor ? decodeTimeCursor(sp.cursor) : null;
  const today = istDay(new Date());

  const header = (
    <PageHeader title="Rider salaries" back={{ href: "/admin/riders", label: "Riders" }} />
  );

  if (!isSupabaseConfigured) {
    return (
      <>
        {header}
        <Empty>Connect Supabase to pay riders.</Empty>
      </>
    );
  }

  let list: RiderPaymentList;
  try {
    list = await listRiderPayments(admin, { status, cursor });
  } catch (e) {
    captureError(e, { source: "admin-riders/payments", attrs: { event: "rider_payments_failed" } });
    return (
      <>
        {header}
        <p className="text-[13px] font-medium text-deal">Could not load rider salaries. Refresh to try again.</p>
      </>
    );
  }
  if (list.state === "unavailable") {
    return (
      <>
        {header}
        <Empty>Rider salaries aren&apos;t set up on this database yet, so none can be paid or shown.</Empty>
      </>
    );
  }

  const columns: Column<PaymentRequest>[] = [
    {
      key: "rider",
      header: "Rider",
      cell: (r) => (
        <Link href={`/admin/riders/${r.subject.id}?tab=money`} className="text-[13px] font-semibold text-ink hover:text-accent-ink hover:underline">
          {r.subject.name}
        </Link>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      width: "w-[110px]",
      cell: (r) => <span className="text-data text-[13px] font-semibold tabular-nums">{formatMoney(r.amount)}</span>,
    },
    {
      key: "period",
      header: "Salary up to",
      width: "w-[110px]",
      cell: (r) => <span className="text-data whitespace-nowrap text-[12px] text-muted">{r.periodEnd ? formatDay(r.periodEnd) : "-"}</span>,
    },
    {
      key: "method",
      header: "How",
      width: "w-[110px]",
      cell: (r) => <span className="text-[12.5px]">{methodWord(r)}</span>,
    },
    {
      key: "asked",
      header: "Asked by",
      width: "w-[170px]",
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] text-ink">{r.requestedBy.name}</span>
          <span className="text-data whitespace-nowrap text-[11px] text-muted">{formatDateTime(r.requestedAt)}</span>
        </span>
      ),
    },
    {
      key: "note",
      header: "Note",
      cell: (r) => <span className="block min-w-0 whitespace-normal break-words text-[12px] text-muted">{r.note ?? "-"}</span>,
    },
    status === "pending_approval"
      ? {
          key: "decide",
          header: "",
          align: "right",
          width: "w-[300px]",
          cell: (r) => (
            <PaymentDecision
              requestId={r.id}
              amount={r.amount}
              periodEnd={r.periodEnd}
              today={today}
              mine={r.requestedBy.id === admin.id}
              canDecide={r.canDecide}
            />
          ),
        }
      : {
          key: "outcome",
          header: "Outcome",
          width: "w-[280px]",
          cell: (r) => (
            <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal">
              <StatusText tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusText>
              {r.decidedBy ? (
                <span className="text-[11.5px] text-muted">
                  By {r.decidedBy.name}
                  {r.selfApproved ? " (their own request)" : ""}
                  {r.decidedAt ? `, ${formatDateTime(r.decidedAt)}` : ""}
                </span>
              ) : null}
              {r.reference ? <span className="text-data truncate text-[11.5px] text-muted">{r.reference}</span> : null}
              {r.decisionNote ? <span className="text-[11.5px] text-muted">{r.decisionNote}</span> : null}
            </span>
          ),
        },
  ];

  const waiting = list.counts.pending_approval;

  return (
    <>
      <PageHeader
        title="Rider salaries"
        back={{ href: "/admin/riders", label: "Riders" }}
        status={waiting > 0 ? <StatusBadge tone="amber">{waiting} waiting</StatusBadge> : <StatusBadge tone="green">Nothing waiting</StatusBadge>}
      />

      <Tabs
        label="Payment status"
        active={hrefOf(status)}
        items={STATUSES.map((s) => ({ href: hrefOf(s), label: STATUS_LABEL[s], count: list.counts[s] }))}
      />

      <Section flush>
        <DataTable
          caption="Rider salaries"
          columns={columns}
          rows={list.items}
          rowKey={(r) => r.id}
          minWidth={1100}
          empty={<Empty>No {STATUS_LABEL[status].toLowerCase()} salary payments.</Empty>}
          footer={
            sp.cursor || list.nextCursor ? (
              <nav className="flex flex-wrap items-center justify-between gap-2" aria-label="Rider salary pages">
                <span className="text-xs text-muted">{list.counts[status]} in all, newest first</span>
                <span className="flex items-center gap-1.5">
                  {sp.cursor ? (
                    <Link href={hrefOf(status)} className="c-btn c-btn-outline">
                      Back to newest
                    </Link>
                  ) : null}
                  {list.nextCursor ? (
                    <Link href={hrefOf(status, list.nextCursor)} className="c-btn c-btn-outline">
                      Older
                    </Link>
                  ) : null}
                </span>
              </nav>
            ) : (
              <TableFooter page={1} totalPages={1} hrefFor={() => hrefOf(status)} summary={`${list.counts[status]} in all`} />
            )
          }
        />
      </Section>
    </>
  );
}
