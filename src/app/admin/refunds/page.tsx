import { requireRole } from "@/lib/auth";
import { RotateCcw } from "lucide-react";
import Link from "next/link";
import {
  getRefundTotals,
  listDecidedRefunds,
  listOpenRefunds,
  type RefundRow,
} from "@/lib/data-access/refunds";
import { RefundCard } from "@/components/admin/refund-card";
import { TableFooter } from "@/components/admin/data-table";
import { EmptyState } from "@/components/admin/admin-ui";
import {
  Empty,
  MetricRow,
  PageHeader,
  Section,
  StatusBadge,
  Tabs,
  Toolbar,
  type MetricItem,
} from "@/components/admin/console";
import { formatINR, formatWaited } from "@/lib/utils/format";
import { adminFeatureOn } from "@/lib/features/guards.server";
import { captureError } from "@/lib/obs/emit";
import { pageCountOf, toPage } from "@/lib/utils/paging";

/**
 * Admin → Refunds. The queue of money decisions, oldest ask first.
 *
 * WEB. The chrome follows the console pattern — status chip, metric strip,
 * status tabs. The figures moved *above* the queue: they are the shape of the
 * work about to be done.
 *
 * Every open refund is on the Open tab, oldest first, however many there are:
 * none may fall off a page. Decided refunds are history, so they page. The
 * figures are counted from the whole table, never from the rows on screen.
 *
 * The queue itself stays a two-column card grid rather than becoming the
 * six-column table the other queue screens use, and that is deliberate:
 *
 *   A refund row has to say, before the operator clicks anything, whether
 *   Approve moves money through Razorpay or merely records a decision that
 *   obliges a human to hand cash back. That sentence does not fit in a table
 *   cell, and this screen exists because somebody once approved a cash refund
 *   believing the gateway had handled it. A denser grid invites skimming, and
 *   skimming is the failure mode.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

type Filter = "pending" | "approved" | "denied";
const FILTERS: Filter[] = ["pending", "approved", "denied"];
const FILTER_LABEL: Record<Filter, string> = {
  pending: "Open",
  approved: "Approved",
  denied: "Denied",
};

const hrefOf = (status: Filter, page = 1) => {
  const params = new URLSearchParams();
  if (status !== "pending") params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/refunds?${qs}` : "/admin/refunds";
};

export default async function AdminRefundsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ status?: string; page?: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  // Feature access → Admin console → Refunds. Off: the nav has already dropped
  // the entry; a bookmark or a link from elsewhere lands on this notice, and
  // the decision actions refuse (app/admin/actions.ts).
  if (!(await adminFeatureOn("admin.refunds"))) {
    return (
      <div className="space-y-6">
        <PageHeader title="Refunds" description="Money to give back on cancelled paid orders." />
        <EmptyState
          icon={RotateCcw}
          title="Refunds is switched off"
          description="An admin turned this page off in Feature access. Refund requests are still recorded; they wait here until it is switched back on."
          action={
            <Link
              href="/admin/settings/feature-access"
              className="text-[13px] font-semibold text-accent underline-offset-2 hover:underline"
            >
              Open Feature access
            </Link>
          }
        />
      </div>
    );
  }

  const sp = await searchParams;
  const status: Filter = FILTERS.includes(sp.status as Filter) ? (sp.status as Filter) : "pending";
  const requested = toPage(sp.page);

  let pending: RefundRow[];
  let totals: Awaited<ReturnType<typeof getRefundTotals>>;
  let history: { rows: RefundRow[]; total: number } | null = null;
  try {
    [pending, totals, history] = await Promise.all([
      listOpenRefunds(),
      getRefundTotals(),
      status === "pending" ? Promise.resolve(null) : listDecidedRefunds(status, requested, PAGE_SIZE),
    ]);
  } catch (e) {
    captureError(e, { source: "admin-refunds/list", attrs: { event: "refunds_list_failed" } });
    return (
      <>
        <PageHeader title="Refunds" />
        <p className="text-[13px] font-medium text-deal">
          Could not load refunds. Refresh to try again.
        </p>
      </>
    );
  }

  const pendingAmount = pending.reduce((sum, r) => sum + (r.amount ?? 0), 0);

  // Which of the waiting decisions go back online by themselves. The rest are
  // cash (or an online order nobody paid for), and approving one of those obliges
  // a person to hand money back — worth knowing before opening the queue, not
  // after approving twenty of them.
  const onlineCount = pending.filter(
    (r) => r.paymentMethod === "online" && r.paymentStatus === "paid"
  ).length;
  const byHandCount = pending.length - onlineCount;

  const anything = pending.length + totals.approvedCount + totals.deniedCount > 0;
  const oldest = pending[0] ? formatWaited(pending[0].createdAt) : null;

  const tabCount: Record<Filter, number> = {
    pending: pending.length,
    approved: totals.approvedCount,
    denied: totals.deniedCount,
  };

  const metrics: MetricItem[] = [
    {
      label: "Awaiting a decision",
      value: String(pending.length),
      note: oldest ? `Oldest has waited ${oldest}` : "Nothing outstanding",
    },
    {
      label: "Value at stake",
      value: formatINR(pendingAmount),
      note: "Across the open requests",
    },
    {
      label: "Go back online",
      value: String(onlineCount),
      note: `${byHandCount} go back by hand`,
    },
    {
      label: "Approved to date",
      value: formatINR(totals.approvedAmount),
      note: `${totals.approvedCount} request${totals.approvedCount === 1 ? "" : "s"}`,
    },
  ];

  const totalPages = history ? pageCountOf(history.total, PAGE_SIZE) : 1;
  const page = Math.min(requested, totalPages);
  const shown = history ? history.rows : pending;

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Every decision is recorded against your account."
        status={
          pending.length > 0 ? (
            <StatusBadge tone="amber">{pending.length} open</StatusBadge>
          ) : (
            <StatusBadge tone="green">Nothing to decide</StatusBadge>
          )
        }
      />

      {anything ? (
        <>
          <MetricRow items={metrics} />

          {/* Says what Approve does, because it does two different things. A
              screen that implies Razorpay handles every refund is how a cash
              refund gets marked settled and never paid. Kept as prose above the
              queue rather than shortened into a chip: this is the one sentence
              on the screen that stops money going missing. */}
          <p className="rounded-[var(--c-r)] border border-line bg-surface px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
            Approving an order <strong className="text-ink">paid online</strong>{" "}
            returns the money through Razorpay. A{" "}
            <strong className="text-ink">cash order</strong> has nothing to
            reverse: approving records your decision, and any money goes back by
            hand.
          </p>

          <Toolbar>
            <Tabs
              label="Refund status"
              active={hrefOf(status)}
              items={FILTERS.map((f) => ({
                href: hrefOf(f),
                label: FILTER_LABEL[f],
                count: tabCount[f],
              }))}
            />
            {status === "pending" && byHandCount > 0 ? (
              <span className="ml-auto text-[11.5px] text-muted">
                {byHandCount} of the open requests go back by hand
              </span>
            ) : null}
          </Toolbar>

          <Section flush>
            {shown.length === 0 ? (
              <Empty>No {FILTER_LABEL[status].toLowerCase()} refunds right now.</Empty>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {shown.map((r) => (
                  <RefundCard key={r.id} refund={r} />
                ))}
              </div>
            )}
            {history && totalPages > 1 ? (
              <div className="mt-4">
                <TableFooter
                  page={page}
                  totalPages={totalPages}
                  hrefFor={(p) => hrefOf(status, p)}
                  summary={`${history.total} refunds, newest first`}
                />
              </div>
            ) : null}
          </Section>
        </>
      ) : (
        <EmptyState
          icon={RotateCcw}
          title="No refund requests"
          description="When a customer asks for a refund, or an order they paid for is cancelled, it lands here."
        />
      )}
    </>
  );
}
