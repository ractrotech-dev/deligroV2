import { RotateCcw } from "lucide-react";
import { listRefunds, type RefundRow } from "@/lib/data-access/refunds";
import { RefundCard } from "@/components/admin/refund-card";
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

/**
 * Admin → Refunds. The queue of money decisions, oldest ask first.
 *
 * The chrome follows the console pattern — status chip, metric strip, status
 * tabs. The figures moved *above* the queue: they are the shape of the work
 * about to be done, and under a two-column grid of forty requests they were
 * three scrolls past the point of being read.
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

type Filter = "pending" | "approved" | "denied";
const FILTERS: Filter[] = ["pending", "approved", "denied"];
const FILTER_LABEL: Record<Filter, string> = {
  pending: "Open",
  approved: "Approved",
  denied: "Denied",
};

export default async function AdminRefundsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const [sp, refunds] = await Promise.all([searchParams, listRefunds()]);
  const status = FILTERS.includes(sp.status as Filter)
    ? (sp.status as Filter)
    : null;

  const pending = refunds.filter((r) => r.status === "pending");
  const pendingAmount = pending.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const approved = refunds.filter((r) => r.status === "approved");
  const approvedAmount = approved.reduce((sum, r) => sum + (r.amount ?? 0), 0);

  // Which of the waiting decisions the gateway can actually carry out. The rest
  // are cash (or an online order nobody paid for), and approving one of those
  // obliges a person to hand money back — worth knowing before opening the
  // queue, not after approving twenty of them.
  const gatewayCount = pending.filter(
    (r) => r.paymentMethod === "online" && r.paymentStatus === "paid"
  ).length;
  const manualCount = pending.length - gatewayCount;

  const oldest = oldestPending(pending);
  const shown = status ? refunds.filter((r) => r.status === status) : refunds;

  const counts = FILTERS.map((f) => ({
    value: f,
    label: FILTER_LABEL[f],
    count: refunds.filter((r) => r.status === f).length,
  })).filter((f) => f.count > 0);

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
      label: "Gateway can reverse",
      value: String(gatewayCount),
      note: `${manualCount} need settling by hand`,
    },
    {
      label: "Approved to date",
      value: formatINR(approvedAmount),
      note: `${approved.length} request${approved.length === 1 ? "" : "s"}`,
    },
  ];

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Disputes waiting on an ops decision. Every decision is recorded against your account."
        status={
          pending.length > 0 ? (
            <StatusBadge tone="amber">{pending.length} open</StatusBadge>
          ) : (
            <StatusBadge tone="green">Queue clear</StatusBadge>
          )
        }
      />

      {refunds.length === 0 ? (
        <EmptyState
          icon={RotateCcw}
          title="No refund requests"
          description="When a customer requests a refund — or an order they paid for is cancelled — it lands here for your review."
        />
      ) : (
        <>
          <MetricRow items={metrics} />

          {/* Says what Approve does, because it does two different things. A
              screen that implies the gateway handles every refund is how a cash
              refund gets marked settled and never paid. Kept as prose above the
              queue rather than shortened into a chip: this is the one sentence
              on the screen that stops money going missing. */}
          <p className="rounded-[var(--c-r)] border border-line bg-surface px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
            Approving an order that was <strong className="text-ink">paid
            online</strong> returns the money through Razorpay and records the
            gateway&apos;s refund id. A <strong className="text-ink">cash
            order</strong> has nothing to reverse: approving records your
            decision, and the money is settled off-platform by hand.
          </p>

          {counts.length > 1 ? (
            <Toolbar>
              <Tabs
                label="Refund status"
                active={status ? `/admin/refunds?status=${status}` : "/admin/refunds"}
                items={[
                  { href: "/admin/refunds", label: "All", count: refunds.length },
                  ...counts.map((c) => ({
                    href: `/admin/refunds?status=${c.value}`,
                    label: c.label,
                    count: c.count,
                  })),
                ]}
              />
              <span className="ml-auto text-[11.5px] text-muted">
                {manualCount > 0
                  ? `${manualCount} of the open requests must be settled by hand`
                  : "Every open request can be reversed through the gateway"}
              </span>
            </Toolbar>
          ) : null}

          <Section flush>
            {shown.length === 0 ? (
              <Empty action={{ href: "/admin/refunds", label: "Show all" }}>
                No {status ? FILTER_LABEL[status].toLowerCase() : ""} refunds
                right now.
              </Empty>
            ) : (
              <div className="grid gap-3 @3xl:grid-cols-2 @3xl:gap-4">
                {shown.map((r) => (
                  <RefundCard key={r.id} refund={r} />
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}

/** How long the longest-waiting open request has been sitting. */
function oldestPending(pending: RefundRow[]): string | null {
  if (!pending.length) return null;
  const first = [...pending].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )[0];
  return formatWaited(first.createdAt);
}
