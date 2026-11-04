import { requireRole } from "@/lib/auth";
import type { ManagerScope } from "@/lib/auth/manager-scope";

const ALL_ZONES: ManagerScope = { all: true };
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
  listCashPeople,
  listCodHandovers,
  type CodHandoverRow,
  type ManagerCodOutstanding,
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
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";

/** A list that loaded, or why it did not: 0085 missing is a known state, anything else is a fault. */
type Loaded<T> = { rows: T[]; state: "ok" } | { rows: T[]; state: "pending" | "failed" };
async function load<T>(read: () => Promise<T[]>): Promise<Loaded<T>> {
  try {
    return { rows: await read(), state: "ok" };
  } catch (e) {
    return { rows: [], state: isRiderSchemaPending(e) ? "pending" : "failed" };
  }
}
const unavailable = (state: "pending" | "failed", what: string) =>
  state === "pending" ? `${what} need migration 0085.` : `Could not load ${what.toLowerCase()}. Try again.`;
import { CashFlow } from "./cash-flow";
import { CashReceivedForm, ConfirmHandoverButton, DepositDecision } from "./cash-actions";

export const dynamic = "force-dynamic";

/**
 * Admin → Cash & expenses. The owner's view of the record that /manager/cash
 * writes to: cash-on-delivery collection, the rider → manager → owner handover
 * chain, and every operational expense (EV bike costs, rider salary, small
 * spend) that has been logged, whether the underlying payment happened offline
 * or not.
 *
 * Platform: WEB (the admin panel is desktop only).
 *
 * This screen exists so nothing recorded offline is also invisible to the owner,
 * and it is where the owner confirms cash they received (rule book, "Rider cash"):
 * a rider's declared deposit, cash handed over directly by a rider, and cash from
 * a manager. One confirmation is enough and each one records who confirmed. There
 * is no payment execution here. Nothing below is corrected automatically; a gap is
 * a prompt to ask.
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
 */

/** How far back each list reaches. Stated in the UI, not implied. */
const HANDOVER_WINDOW = 80;
const EXPENSE_WINDOW = 80;

type Search = { leg?: string; category?: string };

const LEG_LABEL: Record<string, string> = {
  rider_to_manager: "Rider → manager",
  rider_to_owner: "Rider → owner",
  manager_to_owner: "Manager → owner",
};

/* ---------- rider outstanding ---------- */
const riderColumns: Column<RiderCodOutstanding>[] = [
  {
    key: "rider",
    header: "Rider",
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
    key: "owner",
    header: "Handed to owner",
    align: "right",
    width: "w-[140px]",
    cell: (r) => (
      <span className="text-data text-[12.5px]">
        {formatINR(r.handedToOwner)}
      </span>
    ),
  },
  {
    key: "outstanding",
    header: "Outstanding",
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

/* ---------- manager outstanding ---------- */
const managerColumns: Column<ManagerCodOutstanding>[] = [
  {
    key: "manager",
    header: "Manager",
    cell: (m) => <span className="truncate text-[12.5px] font-medium text-ink">{m.managerName}</span>,
  },
  {
    key: "received",
    header: "Received from riders",
    align: "right",
    width: "w-[170px]",
    cell: (m) => <span className="text-data text-[12.5px]">{formatINR(m.received)}</span>,
  },
  {
    key: "handedOn",
    header: "Handed to owner",
    align: "right",
    width: "w-[150px]",
    cell: (m) => <span className="text-data text-[12.5px]">{formatINR(m.handedOn)}</span>,
  },
  {
    key: "outstanding",
    header: "Outstanding",
    align: "right",
    width: "w-[130px]",
    cell: (m) => (
      <span
        className={
          m.outstanding < 0
            ? "text-data text-[12.5px] font-semibold text-deal"
            : "text-data text-[12.5px] font-semibold text-[color:var(--c-ink-amber)]"
        }
      >
        {formatINR(m.outstanding)}
      </span>
    ),
  },
];

/* ---------- handovers ---------- */
const handoverColumns: Column<CodHandoverRow>[] = [
  {
    key: "date",
    header: "Date",
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
    // A manager's own row has always left "from" empty: whoever wrote it gave the cash.
    cell: (h) => <Person name={h.fromUserName ?? (h.leg === "manager_to_owner" ? h.recordedByName : null)} />,
  },
  {
    key: "to",
    header: "To",
    cell: (h) => <Person name={h.toUserName} />,
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    width: "w-[110px]",
    cell: (h) => (
      <span className="text-data text-[12.5px] font-semibold text-ink">
        {formatINR(h.amount)}
      </span>
    ),
  },
  {
    key: "confirmedBy",
    header: "Confirmed by",
    width: "w-[170px]",
    cell: (h) =>
      h.confirmedByName ? (
        <Person name={h.confirmedByName} muted />
      ) : (
        <ConfirmHandoverButton handoverId={h.id} />
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
    width: "w-[104px]",
    cell: (d) => (
      <span className="text-data text-[12px] text-ink">{d.createdAt.slice(0, 10)}</span>
    ),
  },
  { key: "rider", header: "Rider", cell: (d) => <Person name={d.riderName} /> },
  {
    key: "method",
    header: "Method",
    width: "w-[150px]",
    cell: (d) => (
      <span className="text-[12px] text-muted" title={d.note ?? ""}>
        {d.method === "upi" ? "UPI" : "Cash"}
        {d.reference ? ` · ${d.reference}` : ""}
      </span>
    ),
  },
  {
    key: "named",
    header: "Rider says to",
    width: "w-[130px]",
    cell: (d) => <Person name={d.namedName} muted />,
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
    align: "right",
    width: "w-[110px]",
    cell: (d) => (
      <span className="text-data text-[12.5px] font-semibold text-ink">{formatINR(d.amount)}</span>
    ),
  },
  {
    key: "decidedBy",
    header: "Decided by",
    width: "w-[140px]",
    cell: (d) => <Person name={d.decidedByName} muted />,
  },
  {
    key: "note",
    header: "Note",
    cell: (d) => (
      <span className="truncate text-[11.5px] text-muted" title={d.decisionNote ?? ""}>
        {d.decisionNote ?? "—"}
      </span>
    ),
  },
  {
    key: "act",
    header: "",
    align: "right",
    width: "w-[170px]",
    cell: (d) => (d.status === "submitted" ? <DepositDecision depositId={d.id} /> : null),
  },
];

const disputeColumns: Column<CashDisputeListing>[] = [
  {
    key: "day",
    header: "Day",
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
    sp.leg === "rider_to_manager" || sp.leg === "rider_to_owner" || sp.leg === "manager_to_owner"
      ? sp.leg
      : "";
  const category = (sp.category ?? "") as ExpenseCategory | "";

  const [summary, outstanding, handovers, expenses, monthTotals, people] =
    await Promise.all([
      // The admin ledger is every zone's.
      codDaySummary(ALL_ZONES),
      codOutstandingSummary(ALL_ZONES),
      listCodHandovers(ALL_ZONES, HANDOVER_WINDOW),
      listOperationalExpenses(ALL_ZONES, EXPENSE_WINDOW),
      operationalExpenseMonthTotals(ALL_ZONES),
      listCashPeople(),
    ]);

  // Rider deposits and disputes (0085) read on their own: a database without
  // that migration shows a note here instead of failing the whole ledger.
  const [deposits, disputes] = await Promise.all([
    load(() => listRecentDeposits(30)),
    load(() => listCashDisputes(30)),
  ]);

  const monthTotal = Object.values(monthTotals).reduce((sum, v) => sum + v, 0);
  const ridersWithOutstanding = outstanding.byRider.filter(
    (r) => r.outstanding !== 0
  );
  const riderNoun = ridersWithOutstanding.length === 1 ? "rider" : "riders";
  const managersWithOutstanding = outstanding.byManager.filter((m) => m.outstanding !== 0);
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
      note: `${formatINR(summary.handedToManagerToday + summary.riderToOwnerToday)} handed on today`,
    },
    {
      label: "Outstanding with riders",
      value: formatINR(outstanding.outstandingWithRiders),
      note: "Collected, not yet handed to a manager or the owner",
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
        description="COD collection, cash from riders and managers, and EV bike / rider operating costs. The cash moves by hand. A manager or the owner confirms what they received, and one confirmation is enough."
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
          riderToOwner={outstanding.totalRiderToOwner}
          withRiders={outstanding.outstandingWithRiders}
          withManagers={outstanding.outstandingWithManagers}
        />
      </Section>

      <Section
        title="Cash you received"
        description="Cash a rider or a manager gave you directly. Record it here so their balance goes down. If the rider declared a deposit, confirm that below instead."
      >
        <CashReceivedForm riders={people.riders} managers={people.managers} />
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
              handed over.
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
        title="Manager cash outstanding"
        meta={managersWithOutstanding.length ? `${managersWithOutstanding.length} holding` : undefined}
      >
        <DataTable
          caption="Cash outstanding per manager"
          columns={managerColumns}
          rows={managersWithOutstanding}
          rowKey={(m) => m.managerId}
          dense
          minWidth={620}
          empty={<Empty>No manager is holding cash on record.</Empty>}
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
                href: href({ leg: "rider_to_owner" }),
                label: "Rider → owner",
                count: handovers.filter((h) => h.leg === "rider_to_owner").length,
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
          minWidth={1020}
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
        description="What riders say they handed over. It counts once a manager or you confirm it. The first confirmation stands."
      >
        <DataTable
          caption="Rider cash deposits"
          columns={depositColumns}
          rows={deposits.rows}
          rowKey={(d) => d.id}
          dense
          minWidth={1040}
          empty={
            <Empty>
              {deposits.state !== "ok"
                ? unavailable(deposits.state, "Rider deposits")
                : "No deposits declared yet — riders declare them from the app."}
            </Empty>
          }
        />
      </Section>

      <Section
        title="Rider cash disputes"
        meta={disputes.state === "ok" ? `${disputes.rows.filter((d) => d.status === "open").length} open` : undefined}
        description="Days a rider says are wrong. Managers resolve them on /manager/cash."
      >
        <DataTable
          caption="Rider cash disputes"
          columns={disputeColumns}
          rows={disputes.rows}
          rowKey={(d) => d.id}
          dense
          minWidth={700}
          empty={
            <Empty>
              {disputes.state !== "ok" ? unavailable(disputes.state, "Rider cash disputes") : "No disputes raised."}
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
