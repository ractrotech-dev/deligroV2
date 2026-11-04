import { requireRole } from "@/lib/auth";
import { notFound } from "next/navigation";
import {
  PageHeader,
  Section,
  StatusBadge,
  type Tone,
} from "@/components/admin/console";
import {
  PayHero,
  PayoutOrderList,
  PayoutTotals,
  PayToCard,
} from "@/components/admin/payout-breakdown";
import {
  getSettlement,
  type SettlementStatus,
} from "@/lib/data-access/admin-settlements";
import { oldCashRuleShortfall } from "@/lib/settlements/math";
import { formatINR } from "@/lib/utils/format";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { ConsoleOnly } from "@/components/admin/console-only";
import { SettlementActions } from "./settlement-actions";
import { ReversalActions } from "./reversal-actions";
import { adminMayApproveOwn, pendingRequestFor } from "@/lib/data-access/settlement-requests";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<SettlementStatus, Tone> = {
  draft: "amber",
  paid: "green",
  void: "neutral",
};

const STATUS_LABEL: Record<SettlementStatus, string> = {
  draft: "Not finished",
  paid: "Paid",
  void: "Cancelled",
};

/** One payment: how much, where it goes, what to do next, and the orders in it. */
export default async function SettlementDetailPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  const admin = await requireRole("admin");

  if (!isSupabaseConfigured) notFound();

  const { id } = await params;
  let settlement;
  let pendingRequest: Awaited<ReturnType<typeof pendingRequestFor>> = null;
  let mayApproveOwn = false;
  try {
    [settlement, pendingRequest, mayApproveOwn] = await Promise.all([getSettlement(id), pendingRequestFor(id), adminMayApproveOwn(admin.id)]);
  } catch {
    notFound();
  }
  if (!settlement) notFound();

  const payout = settlement.payout;
  const shop = settlement.restaurantName;

  let title: string | undefined;
  if (settlement.status === "paid") title = `Paid to ${shop}`;
  if (settlement.status === "void") title = `Cancelled payment to ${shop}`;

  // Refunds on earlier, already-paid orders, taken back in this payment.
  const linesTotal = settlement.lines.reduce((sum, l) => sum + l.contribution, 0);
  const corrections = settlement.lines.length
    ? Math.max(0, linesTotal - settlement.netPayable - settlement.mismatch)
    : 0;
  const shortfall =
    settlement.status === "paid" ? oldCashRuleShortfall(settlement.lines) : 0;

  return (
    <>
      <PageHeader
        title={shop}
        back={{ href: "/admin/settlements", label: "Settlements" }}
        status={
          <StatusBadge tone={STATUS_TONE[settlement.status]}>
            {STATUS_LABEL[settlement.status]}
          </StatusBadge>
        }
      />

      <PayHero
        shop={shop}
        title={title}
        amount={settlement.netPayable}
        orderCount={settlement.orderCount}
        note={settlement.periodLabel}
      >
        {settlement.status === "draft" ? <PayToCard payout={payout} /> : null}
        {settlement.paymentRef ? (
          <p className="text-[13px] text-muted">
            Payment reference{" "}
            <span className="text-data font-medium text-ink">
              {settlement.paymentRef}
            </span>
          </p>
        ) : null}
        {settlement.notes ? (
          <p className="text-[13px] text-muted">{settlement.notes}</p>
        ) : null}
      </PayHero>

      {shortfall > 0 ? (
        <p className="rounded-[var(--c-r)] border border-deal/30 bg-deal-soft px-3.5 py-2.5 text-[13px] leading-snug text-deal">
          This payment used the old cash rule, so the shop got{" "}
          <span className="text-data font-semibold tabular-nums">
            {formatINR(shortfall)}
          </span>{" "}
          less than it should have.
        </p>
      ) : null}

      {settlement.status === "draft" ? (
        <SettlementActions
          id={settlement.id}
          netPayable={settlement.netPayable}
          pendingRequest={pendingRequest}
          viewerId={admin.id}
          mayApproveOwn={mayApproveOwn}
        />
      ) : null}
      {settlement.status === "paid" ? (
        <ConsoleOnly
          tool="Reversing a payout"
          why="Reversing a paid payout needs a second person and a check with the bank — a desk job, not a phone one."
        >
          <ReversalActions
            id={settlement.id}
            pendingRequest={pendingRequest}
            viewerId={admin.id}
            mayApproveOwn={mayApproveOwn}
          />
        </ConsoleOnly>
      ) : null}

      <details className="group rounded-xl border border-line bg-surface p-3.5">
        <summary className="press flex min-h-8 cursor-pointer list-none items-center justify-between text-[14px] font-medium text-ink">
          How we got {formatINR(Math.abs(settlement.netPayable))}
          <span className="text-[13px] font-normal text-muted group-open:hidden">
            Show
          </span>
          <span className="hidden text-[13px] font-normal text-muted group-open:inline">
            Hide
          </span>
        </summary>
        <div className="mt-2">
          <PayoutTotals
            totals={{
              foodGross: settlement.foodGross,
              commission: settlement.commission,
              commissionGst: settlement.commissionGst,
              otherCharges: settlement.otherCharges,
              refundsRecovered: settlement.refundsRecovered,
              netPayable: settlement.netPayable,
            }}
            commissionPct={payout.commissionPct}
            commissionGstPct={payout.commissionGstPct}
            corrections={corrections}
            mismatch={settlement.mismatch}
          />
        </div>
      </details>

      {settlement.lines.length > 0 ? (
        <Section title="Orders">
          <PayoutOrderList
            lines={settlement.lines}
            commissionPct={payout.commissionPct}
            commissionGstPct={payout.commissionGstPct}
          />
        </Section>
      ) : null}
      {settlement.lines.length === 0 && settlement.status === "void" ? (
        <p className="c-empty">
          This payment was cancelled, so its orders can be paid again.
        </p>
      ) : null}
    </>
  );
}
