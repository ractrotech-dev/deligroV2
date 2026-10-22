import { requireRole } from "@/lib/auth";
import {
  Empty,
  MetricRow,
  PageHeader,
  Section,
  StatusBadge,
  StatusText,
  Tabs,
  type MetricItem,
} from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { SelectFilter } from "@/components/admin/select-filter";
import { FilterForm, FilterSubmit } from "@/components/admin/admin-filters";
import { formatINR } from "@/lib/utils/format";
import {
  codDaySummary,
  codOutstandingSummary,
  listCodHandovers,
  type CodHandoverRow,
  type RiderCodOutstanding,
} from "@/lib/data-access/cod-handovers";
import {
  listOperationalExpenses,
  operationalExpenseMonthTotals,
  EXPENSE_CATEGORY_LABEL,
  EXPENSE_PAYMENT_METHOD_LABEL,
  type ExpenseCategory,
  type OperationalExpenseRow,
} from "@/lib/data-access/operational-expenses";
import {
  listCashDisputes,
  listRecentDeposits,
  type CashDisputeListing,
  type RecentDeposit,
} from "@/lib/data-access/rider-cash";
import { CashFlow } from "./cash-flow";

export const dynamic = "force-dynamic";

/**
 * Admin → Cash & expenses. The owner's view of the record that /manager/cash
 * writes to: cash-on-delivery collection, the rider → manager → owner handover
 * chain, and every operational expense (EV bike costs, rider salary, small
 * spend) that has been logged, whether the underlying payment happened offline
 * or not.
 *
 * Read-only by design. This screen exists so nothing recorded offline is also
 * invisible to the owner — it does not add an approval step, a payment
 * execution, or a reconciliation gate that does not already exist elsewhere in
 * this app. Nothing below is corrected automatically; a gap is a prompt to ask.
 *
 * ## The chain, as a chain
 *
 * The four figures at the top used to be the whole answer, which left the
 * reader to work out that "outstanding with riders" is the *gap* between two of
 * the others. The gap is the point — it is the question somebody has to go and
 * ask — so it is now drawn as the chain the money actually travels. See
 * `CashFlow`.
 *
 * ## The windows
 *
 * The handover and expense lists show the most recent `HANDOVER_WINDOW` /
 * `EXPENSE_WINDOW` rows, and the filters narrow that window rather than
 * re-querying. Each section heading says so, for the same reason the Orders
 * screen does: "4 expenses" meaning "4 of the last 80" and meaning "4, ever"
 * are very different answers to the same question.
 *
 * Outstanding figures are all-time, not reset daily, so a missing handover from
 * last week is still visible here rather than only today's.
 *
 * Platform: BOTH. Read-only, so it stays worth opening on a phone; every table
 * goes through `DataTable`, which stacks into cards below the console
 * breakpoint. Not gated `reach: "console"` for that reason — see AGENTS.md,
 * "New admin features declare a platform".
 */

/** How far back each list reaches. Stated in the UI, not implied. */
const HANDOVER_WINDOW = 80;
const EXPENSE_WINDOW = 80;

type Search = { leg?: string; category?: string };

const LEG_LABEL: Record<string, string> = {
  rider_to_manager: "Rider → manager",
  manager_to_owner: "Manager → owner",
};

/* ---------- rider outstanding ---------- */
const riderColumns: Column<RiderCodOutstanding>[] = [
  {
    key: "rider",
    header: "Rider",
    role: "title",
    cell: (r) => (
      <span className="truncate text-[12.5px] font-medium text-ink">
        {r.riderName}
      </span>
    ),
  },
  {
    key: "collected",
    header: "Collected (all-time)",
    align: "right",
    width: "w-[150px]",
    cell: (r) => (
      <span className="text-data text-[12.5px]">{formatINR(r.collected)}</span>
    ),
  },
  {
    key: "handed",
    header: "Handed to manager",
    align: "right",
    width: "w-[150px]",
    cell: (r) => (
      <span className="text-data text-[12.5px]">
        {formatINR(r.handedToManager)}
      </span>
    ),
  },
  {
    key: "outstanding",
    header: "Outstanding",
    role: "trailing",
    align: "right",
    width: "w-[130px]",
    // A negative figure means more was handed on than the rider is recorded
    // as having collected. Also worth asking about, so it is toned as a
    // problem rather than as a credit.
    cell: (r) => (
      <span
        className={
          r.outstanding < 0
            ? "text-data text-[12.5px] font-semibold text-deal"
            : "text-data text-[12.5px] font-semibold text-[color:var(--c-ink-amber)]"
        }
      >
        {formatINR(r.outstanding)}
      </span>
    ),
  },
];

/* ---------- handovers ---------- */
const handoverColumns: Column<CodHandoverRow>[] = [
  {
    key: "date",
    header: "Date",
    role: "title",
    width: "w-[104px]",
    cell: (h) => (
      <span className="text-data text-[12px] text-ink">{h.handoverDate}</span>
    ),
  },
  {
    key: "leg",
    header: "Leg",
    width: "w-[150px]",
    cell: (h) => (
      <StatusText tone={h.leg === "rider_to_manager" ? "blue" : "green"}>
        {LEG_LABEL[h.leg] ?? h.leg}
      </StatusText>
    ),
  },
  {
    key: "from",
    header: "From",
    cell: (h) => <Person name={h.fromUserName} />,
  },
  {
    key: "to",
    header: "To",
    cell: (h) => <Person name={h.toUserName} />,
  },
  {
    key: "amount",
    header: "Amount",
    role: "trailing",
    align: "right",
    width: "w-[110px]",
    cell: (h) => (
      <span className="text-data text-[12.5px] font-semibold text-ink">
        {formatINR(h.amount)}
      </span>
    ),
  },
  {
    key: "recordedBy",
    header: "Recorded by",
    width: "w-[140px]",
    cell: (h) => <Person name={h.recordedByName} muted />,
  },
  {
    key: "note",
    header: "Note",
    role: "wideOnly",
    cell: (h) => (
      <span className="truncate text-[11.5px] text-muted" title={h.note ?? ""}>
        {h.note ?? "—"}
      </span>
    ),
  },
];

/* ---------- expenses ---------- */
const expenseColumns: Column<OperationalExpenseRow>[] = [
  {
    key: "date",
    header: "Date",
    role: "title",
    width: "w-[104px]",
    cell: (e) => (
      <span className="text-data text-[12px] text-ink">{e.expenseDate}</span>
    ),
  },
  {
    key: "category",
    header: "Category",
    width: "w-[170px]",
    cell: (e) => (
      <span className="text-[12.5px] text-ink">
        {EXPENSE_CATEGORY_LABEL[e.category]}
      </span>
    ),
  },
  {
    key: "note",
    header: "Description",
    cell: (e) => (
      <span className="truncate text-[12px] text-muted" title={e.note ?? ""}>
        {e.note ?? "—"}
      </span>
    ),
  },
  {
    key: "rider",
    header: "Rider",
    width: "w-[130px]",
    cell: (e) => <Person name={e.riderName} muted />,
  },
  {
    key: "amount",
    header: "Amount",
    role: "trailing",
    align: "right",
    width: "w-[110px]",
    cell: (e) => (
      <span className="text-data text-[12.5px] font-semibold text-ink">
        {formatINR(e.amount)}
      </span>
    ),
  },
  {
    key: "paidVia",
    header: "Paid via",
    width: "w-[120px]",
    cell: (e) => (
      <span className="text-[12px] text-muted">
        {EXPENSE_PAYMENT_METHOD_LABEL[e.paymentMethod]}
      </span>
    ),
  },
  {
    key: "recordedBy",
    header: "Recorded by",
    role: "wideOnly",
    width: "w-[140px]",
    cell: (e) => <Person name={e.recordedByName} muted />,
  },
];

/* ---------- rider deposits and disputes (0085) ---------- */
const DEPOSIT_TONE: Record<string, "amber" | "green" | "red" | "neutral"> = {
  submitted: "amber",
  confirmed: "green",
  disputed: "red",
  withdrawn: "neutral",
};

const depositColumns: Column<RecentDeposit>[] = [
  {
    key: "date",
    header: "Declared",
    role: "title",
    width: "w-[104px]",
    cell: (d) => (
      <span className="text-data text-[12px] text-ink">{d.createdAt.slice(0, 10)}</span>
    ),
  },
  { key: "rider", header: "Rider", cell: (d) => <Person name={d.riderName} /> },
  {
    key: "method",
    header: "Method",
    width: "w-[90px]",
    cell: (d) => <span className="text-[12px] text-muted">{d.method === "upi" ? "UPI" : "Cash"}</span>,
  },
  {
    key: "status",
    header: "Status",
    width: "w-[120px]",
    cell: (d) => (
      <StatusText tone={DEPOSIT_TONE[d.status] ?? "neutral"}>
        {d.status.charAt(0).toUpperCase() + d.status.slice(1)}
      </StatusText>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    role: "trailing",
    align: "right",
    width: "w-[110px]",
    cell: (d) => (
      <span className="text-data text-[12.5px] font-semibold text-ink">{formatINR(d.amount)}</span>
    ),
  },
  {
    key: "note",
    header: "Manager's note",
    role: "wideOnly",
    cell: (d) => (
      <span className="truncate text-[11.5px] text-muted" title={d.decisionNote ?? ""}>
        {d.decisionNote ?? "—"}
      </span>
    ),
  },
];

const disputeColumns: Column<CashDisputeListing>[] = [
  {
    key: "day",
    header: "Day",
    role: "title",
    width: "w-[104px]",
    cell: (d) => <span className="text-data text-[12px] text-ink">{d.day}</span>,
  },
  { key: "rider", header: "Rider", cell: (d) => <Person name={d.riderName} /> },
  {
    key: "status",
    header: "Status",
    width: "w-[110px]",
    cell: (d) => (
      <StatusText tone={d.status === "open" ? "red" : "green"}>
        {d.status === "open" ? "Open" : "Resolved"}
      </StatusText>
    ),
  },
  {
    key: "claimed",
    header: "Rider says",
    role: "trailing",
    align: "right",
    width: "w-[110px]",
    cell: (d) => (
      <span className="text-data text-[12.5px] text-ink">
        {d.claimedAmount === null ? "—" : formatINR(d.claimedAmount)}
      </span>
    ),
  },
  {
    key: "message",
    header: "Message",
    role: "wideOnly",
    cell: (d) => (
      <span className="truncate text-[11.5px] text-muted" title={d.message}>
        {d.message}
      </span>
    ),
  },
];

export default async function AdminCashLedgerPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Search>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const sp = await searchParams;
  const leg =
    sp.leg === "rider_to_manager" || sp.leg === "manager_to_owner"
      ? sp.leg
      : "";
  const category = (sp.category ?? "") as ExpenseCategory | "";

  const [summary, outstanding, handovers, expenses, monthTotals] =
    await Promise.all([
      codDaySummary(),
      codOutstandingSummary(),
      listCodHandovers(HANDOVER_WINDOW),
      listOperationalExpenses(EXPENSE_WINDOW),
      operationalExpenseMonthTotals(),
    ]);

  // Rider deposits and disputes (0085) read on their own: a database without
  // that migration shows a note here instead of failing the whole ledger.
  const [deposits, disputes] = await Promise.all([
    listRecentDeposits(30).catch(() => null),
    listCashDisputes(30).catch(() => null),
  ]);

  const monthTotal = Object.values(monthTotals).reduce((sum, v) => sum + v, 0);
  const ridersWithOutstanding = outstanding.byRider.filter(
    (r) => r.outstanding !== 0
  );
  const riderNoun = ridersWithOutstanding.length === 1 ? "rider" : "riders";
  const unattributed =
    outstanding.unattributedCollected - outstanding.unattributedHandedToManager;

  const shownHandovers = leg ? handovers.filter((h) => h.leg === leg) : handovers;
  const shownExpenses = category
    ? expenses.filter((e) => e.category === category)
    : expenses;

  const stillOut =
    outstanding.outstandingWithRiders + outstanding.outstandingWithManagers;

  const href = (next: Partial<Search>) => {
    const merged = { leg: leg || undefined, category: category || undefined, ...next };
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) usp.set(k, v);
    const qs = usp.toString();
    return qs ? `/admin/cash-ledger?${qs}` : "/admin/cash-ledger";
  };

  const metrics: MetricItem[] = [
    {
      label: "Collected today (COD)",
      value: formatINR(summary.collectedToday),
      note: `${formatINR(summary.handedToManagerToday)} handed on today`,
    },
    {
      label: "Outstanding with riders",
      value: formatINR(outstanding.outstandingWithRiders),
      note: "Collected, not yet handed to a manager",
    },
    {
      label: "Outstanding with managers",
      value: formatINR(outstanding.outstandingWithManagers),
      note: "Received from riders, not yet handed to the owner",
    },
    {
      label: "Expenses this month",
      value: formatINR(monthTotal),
      note: `${EXPENSE_CATEGORY_LABEL.ev_bike_maintenance} + ${EXPENSE_CATEGORY_LABEL.ev_bike_charging}: ${formatINR(
        monthTotals.ev_bike_maintenance + monthTotals.ev_bike_charging
      )}`,
    },
  ];

  const shownExpenseTotal = shownExpenses.reduce((sum, e) => sum + e.amount, 0);

  return (
    <>
      <PageHeader
        title="Cash & expenses"
        description="COD collection, the rider → manager → owner handover chain, and EV bike / rider operating costs. The cash itself moves by hand — a manager enters it from /manager/cash as the day goes, and this screen shows only what has been recorded."
        status={
          stillOut > 0 ? (
            <StatusBadge tone="amber">
              {formatINR(stillOut)} outstanding
            </StatusBadge>
          ) : (
            <StatusBadge tone="green">Nothing outstanding</StatusBadge>
          )
        }
      />

      <MetricRow items={metrics} />

      <Section
        title="Where the cash is"
        meta="all-time, not reset daily"
        description="Balances are the differences between what has been recorded at each step, so they are only ever as right as what was entered. A figure in amber is a prompt to ask somebody, not a blocked action."
      >
        <CashFlow
          collected={outstanding.totalCollected}
          handedToManager={outstanding.totalHandedToManager}
          handedToOwner={outstanding.totalHandedToOwner}
          withRiders={outstanding.outstandingWithRiders}
          withManagers={outstanding.outstandingWithManagers}
        />
      </Section>

      <Section
        title="Rider cash outstanding"
        meta={
          ridersWithOutstanding.length
            ? `${ridersWithOutstanding.length} ${riderNoun}`
            : undefined
        }
      >
        <DataTable
          caption="Cash outstanding per rider"
          columns={riderColumns}
          rows={ridersWithOutstanding}
          rowKey={(r) => r.riderId}
          dense
          minWidth={680}
          empty={
            <Empty>
              Every rider&rsquo;s recorded collections match what they have
              handed to a manager.
            </Empty>
          }
          totals={
            unattributed !== 0
              ? {
                  // Not a total — a residual. Collected cash whose delivery has
                  // no driver on record cannot be attributed to a person, but it
                  // is still money, and dropping it would make the rows above
                  // look like the whole picture.
                  label: "Not attributed to a named rider",
                  cells: {
                    collected: formatINR(outstanding.unattributedCollected),
                    handed: formatINR(outstanding.unattributedHandedToManager),
                    outstanding: formatINR(unattributed),
                  },
                }
              : undefined
          }
        />
      </Section>

      <Section
        title="Cash handovers"
        meta={`last ${HANDOVER_WINDOW} recorded`}
        actions={
          <Tabs
            label="Handover leg"
            active={href({ leg: leg || undefined })}
            items={[
              { href: href({ leg: undefined }), label: "All", count: handovers.length },
              {
                href: href({ leg: "rider_to_manager" }),
                label: "Rider → manager",
                count: handovers.filter((h) => h.leg === "rider_to_manager").length,
              },
              {
                href: href({ leg: "manager_to_owner" }),
                label: "Manager → owner",
                count: handovers.filter((h) => h.leg === "manager_to_owner").length,
              },
            ]}
          />
        }
      >
        <DataTable
          caption="Cash handovers"
          columns={handoverColumns}
          rows={shownHandovers}
          rowKey={(h) => h.id}
          dense
          minWidth={860}
          empty={
            leg ? (
              <Empty action={{ href: href({ leg: undefined }), label: "Show all legs" }}>
                No handovers on this leg in the last {HANDOVER_WINDOW} recorded.
              </Empty>
            ) : (
              <Empty>
                No handovers recorded yet — they are logged from the manager app
                as riders hand over collected cash.
              </Empty>
            )
          }
        />
      </Section>

      <Section
        title="Rider deposits"
        meta="last 30 declared"
        description="What riders say they handed over. A deposit counts only once a manager confirms it — that writes the handover above."
      >
        <DataTable
          caption="Rider cash deposits"
          columns={depositColumns}
          rows={deposits ?? []}
          rowKey={(d) => d.id}
          dense
          minWidth={760}
          empty={
            <Empty>
              {deposits === null
                ? "Rider deposits need migration 0085."
                : "No deposits declared yet — riders declare them from the app."}
            </Empty>
          }
        />
      </Section>

      <Section
        title="Rider cash disputes"
        meta={disputes ? `${disputes.filter((d) => d.status === "open").length} open` : undefined}
        description="Days a rider says are wrong. Managers resolve them on /manager/cash."
      >
        <DataTable
          caption="Rider cash disputes"
          columns={disputeColumns}
          rows={disputes ?? []}
          rowKey={(d) => d.id}
          dense
          minWidth={700}
          empty={
            <Empty>
              {disputes === null ? "Rider cash disputes need migration 0085." : "No disputes raised."}
            </Empty>
          }
        />
      </Section>

      <Section
        title="Operational expenses"
        meta={`last ${EXPENSE_WINDOW} recorded`}
        actions={
          // `FilterForm` on its own, not wrapped in `Toolbar`: a toolbar is the
          // page's sticky control row, and there is only ever one of those.
          // This filter belongs to one section, so it sits in that section's
          // own header.
          <FilterForm action="/admin/cash-ledger" carry={{ leg: leg || undefined }}>
            <SelectFilter
              name="category"
              label="Filter by expense category"
              value={category}
              options={[
                { value: "", label: "Every category" },
                ...Object.entries(EXPENSE_CATEGORY_LABEL).map(([v, label]) => ({
                  value: v,
                  label,
                })),
              ]}
            />
            <FilterSubmit />
          </FilterForm>
        }
      >
        <DataTable
          caption="Operational expenses"
          columns={expenseColumns}
          rows={shownExpenses}
          rowKey={(e) => e.id}
          dense
          minWidth={900}
          totals={
            shownExpenses.length
              ? {
                  label: `${shownExpenses.length} expense${shownExpenses.length === 1 ? "" : "s"} shown`,
                  cells: { amount: formatINR(shownExpenseTotal) },
                }
              : undefined
          }
          empty={
            category ? (
              <Empty
                action={{
                  href: href({ category: undefined }),
                  label: "Show every category",
                }}
              >
                Nothing in that category in the last {EXPENSE_WINDOW} recorded.
              </Empty>
            ) : (
              <Empty>
                No expenses recorded yet — EV bike maintenance and charging,
                rider salary and other small spend are logged from the manager
                app.
              </Empty>
            )
          }
        />
      </Section>
    </>
  );
}

/**
 * A person's name, or an honest dash.
 *
 * Every one of these columns can be null: a handover recorded against nobody in
 * particular, an expense with no rider attached. "—" is the right answer and
 * "Unknown" is not — the row was written that way on purpose.
 */
function Person({ name, muted }: Readonly<{ name: string | null; muted?: boolean }>) {
  if (!name) {
    return <span className="text-[12px] text-[color:var(--c-faint)]">—</span>;
  }
  return (
    <span
      className={
        muted
          ? "truncate text-[12px] text-muted"
          : "truncate text-[12.5px] text-ink"
      }
    >
      {name}
    </span>
  );
}
