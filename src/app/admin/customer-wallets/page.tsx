import Link from "next/link";
import { Wallet } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { AdminHero, EmptyState } from "@/components/admin/admin-ui";
import { Figure, FigureRow, Section, StatusText } from "@/components/admin/console";
import { DataTable, TableFooter, type Column } from "@/components/admin/data-table";
import { FilterChips, FilterForm, SearchForm } from "@/components/admin/admin-filters";
import {
  getWalletSummary,
  listWalletCustomers,
  listWalletMovements,
  type WalletCustomerRow,
  type WalletMovementRow,
  type WalletSort,
} from "@/lib/data-access/admin-wallets";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isDayKey } from "@/lib/rider/earnings-math";
import { formatINR } from "@/lib/utils/format";
import { shortOrderId } from "@/lib/utils/order-map";
import { signedRupees, WALLET_KINDS, walletKindLabel, type WalletKind } from "@/lib/wallet/money";

/**
 * Admin → Customer wallets. What Deligro holds for customers, who holds it, and every
 * point added, used or corrected. Platform: WEB (admin is a desktop console). Reads
 * only: a balance is corrected on the customer's own page, with a written reason.
 * Search, sort and paging run in the database, so they cover every customer.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const nf = new Intl.NumberFormat("en-IN");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = {
  view?: string;
  q?: string;
  sort?: string;
  points?: string;
  page?: string;
  kind?: string;
  person?: string;
  customer?: string;
  from?: string;
  to?: string;
};

const customerColumns: Column<WalletCustomerRow>[] = [
  {
    key: "name",
    header: "Customer",
    cell: (c) => (
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold">{c.name}</span>
        <span className="text-data block truncate text-[11.5px] text-muted">{c.phone ?? "No phone on file"}</span>
      </span>
    ),
  },
  {
    key: "joined",
    header: "Joined",
    width: "w-[170px]",
    cell: (c) => <span className="text-data whitespace-nowrap text-[11.5px] text-muted">{c.joinedAt}</span>,
  },
  {
    key: "balance",
    header: "Balance",
    align: "right",
    width: "w-[120px]",
    cell: (c) => (
      <span className={c.balance > 0 ? "text-data text-[13px] font-semibold tabular-nums" : "text-data text-[13px] tabular-nums text-muted"}>
        {formatINR(c.balance)}
      </span>
    ),
  },
  {
    key: "history",
    header: "",
    align: "right",
    width: "w-[150px]",
    cell: (c) => (
      <Link href={`/admin/customer-wallets?view=movements&customer=${c.id}`} className="text-[12px] font-semibold text-ink underline">
        Movements
      </Link>
    ),
  },
];

const movementColumns: Column<WalletMovementRow>[] = [
  {
    key: "at",
    header: "When",
    width: "w-[150px]",
    cell: (m) => <span className="text-data whitespace-nowrap text-[11.5px] text-muted">{m.at}</span>,
  },
  {
    key: "customer",
    header: "Customer",
    cell: (m) => (
      <Link href={`/admin/customers/${m.customerId}`} className="min-w-0 hover:underline">
        <span className="block truncate text-[13px] font-semibold">{m.customerName}</span>
        <span className="text-data block truncate text-[11.5px] text-muted">{m.customerPhone ?? ""}</span>
      </Link>
    ),
  },
  {
    key: "kind",
    header: "Type",
    width: "w-[190px]",
    cell: (m) => (
      <StatusText tone={m.amount > 0 ? "green" : m.kind === "admin_correction" ? "amber" : "neutral"}>
        {walletKindLabel(m.kind)}
      </StatusText>
    ),
  },
  {
    key: "why",
    header: "Reason",
    cell: (m) => <span className="block max-w-[320px] truncate text-[12px] text-muted" title={m.reason}>{m.reason}</span>,
  },
  {
    key: "order",
    header: "Order",
    width: "w-[100px]",
    cell: (m) =>
      m.orderId ? (
        <Link href={`/admin/orders/${m.orderId}`} className="text-data text-[12px] underline">
          #{shortOrderId(m.orderId)}
        </Link>
      ) : (
        <span className="text-[11.5px] text-[color:var(--c-faint)]">—</span>
      ),
  },
  {
    key: "actor",
    header: "Who",
    width: "w-[150px]",
    cell: (m) => (
      <span className="min-w-0">
        <span className="block truncate text-[12px]">{m.actorName}</span>
        {m.actorRole ? <span className="block truncate text-[11px] capitalize text-muted">{m.actorRole === "driver" ? "rider" : m.actorRole}</span> : null}
      </span>
    ),
  },
  {
    key: "amount",
    header: "Points",
    align: "right",
    width: "w-[90px]",
    cell: (m) => (
      <span className={`text-data text-[13px] font-semibold tabular-nums ${m.amount > 0 ? "text-green" : ""}`}>
        {signedRupees(m.amount)}
      </span>
    ),
  },
  {
    key: "after",
    header: "Balance after",
    align: "right",
    width: "w-[110px]",
    cell: (m) => (
      <span className="text-data text-[12.5px] tabular-nums text-muted">
        {m.balanceAfter === null ? "—" : formatINR(m.balanceAfter)}
      </span>
    ),
  },
];

function isKind(v: string | undefined): v is WalletKind {
  return WALLET_KINDS.includes(v as WalletKind);
}

export default async function CustomerWalletsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Search> }>) {
  await requireRole("admin");
  const sp = await searchParams;
  const view = sp.view === "movements" ? "movements" : "customers";
  const page = Math.max(1, Number(sp.page) || 1);
  const q = (sp.q ?? "").trim();
  const sort: WalletSort = sp.sort === "name" || sp.sort === "joined" ? sp.sort : "balance";
  const withPoints = sp.points === "1";
  const kind = isKind(sp.kind) ? sp.kind : null;
  const person = (sp.person ?? "").trim();
  const customerId = sp.customer && UUID.test(sp.customer) ? sp.customer : null;
  const from = sp.from && isDayKey(sp.from) ? sp.from : "";
  const to = sp.to && isDayKey(sp.to) ? sp.to : "";

  const summary = isSupabaseConfigured ? await getWalletSummary() : null;
  const migrated = summary !== null;

  const customers =
    migrated && view === "customers"
      ? await listWalletCustomers({ q, sort, withPoints, page, pageSize: PAGE_SIZE })
      : { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE };
  const movements =
    migrated && view === "movements"
      ? await listWalletMovements({ kind, customerId, person, from, to, page, pageSize: PAGE_SIZE })
      : { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE };

  const money = (n: number | undefined) => (n === undefined ? "—" : formatINR(n));

  const customersHref = (next: Partial<Search>) => {
    const usp = new URLSearchParams();
    const merged: Search = { q, sort, points: withPoints ? "1" : undefined, ...next };
    if (merged.q) usp.set("q", merged.q);
    if (merged.sort && merged.sort !== "balance") usp.set("sort", merged.sort);
    if (merged.points) usp.set("points", merged.points);
    if (merged.page && merged.page !== "1") usp.set("page", merged.page);
    const query = usp.toString();
    return query ? `/admin/customer-wallets?${query}` : "/admin/customer-wallets";
  };
  const movementsHref = (next: Partial<Search>) => {
    const usp = new URLSearchParams({ view: "movements" });
    const merged: Search = { kind: kind ?? undefined, person, customer: customerId ?? undefined, from, to, ...next };
    if (merged.kind) usp.set("kind", merged.kind);
    if (merged.person) usp.set("person", merged.person);
    if (merged.customer) usp.set("customer", merged.customer);
    if (merged.from) usp.set("from", merged.from);
    if (merged.to) usp.set("to", merged.to);
    if (merged.page && merged.page !== "1") usp.set("page", merged.page);
    return `/admin/customer-wallets?${usp.toString()}`;
  };

  return (
    <>
      <AdminHero
        title="Customer wallets"
        tag={summary ? `${formatINR(summary.held)} held` : undefined}
        subtitle="Points customers hold with Deligro. 1 point = ₹1. They never expire and can't be taken out as cash."
      />

      {migrated ? null : (
        <p role="status" className="text-sm text-muted">
          The wallet needs migration 0198. Until then there is nothing to show here.
        </p>
      )}

      <FigureRow>
        <Figure label="Held for customers" value={money(summary?.held)} note="Cash Deligro holds that is theirs" />
        <Figure label="Added this month" value={money(summary?.addedThisMonth)} note="Change added by riders" />
        <Figure label="Used this month" value={money(summary?.usedThisMonth)} note="On orders, less anything returned" />
        <Figure label="Customers with points" value={summary ? nf.format(summary.customers) : "—"} note="Balance above zero" />
      </FigureRow>

      <nav className="c-tabs no-scrollbar" aria-label="Wallet view">
        <Link href="/admin/customer-wallets" className="c-tab" aria-current={view === "customers" ? "page" : undefined}>
          Customers
        </Link>
        <Link href="/admin/customer-wallets?view=movements" className="c-tab" aria-current={view === "movements" ? "page" : undefined}>
          All movements
        </Link>
      </nav>

      {view === "customers" ? (
        <Section title="Customers">
          <div className="flex flex-col gap-2.5">
            <SearchForm
              action="/admin/customer-wallets"
              defaultValue={q}
              placeholder="Name or phone number"
              carry={{ sort: sort === "balance" ? undefined : sort, points: withPoints ? "1" : undefined }}
            />
            <FilterChips
              label="Customers shown"
              options={[{ value: "1", label: "Has points", count: summary?.customers ?? 0 }]}
              active={withPoints ? "1" : null}
              hrefFor={(v) => customersHref({ points: v ?? undefined, page: "1" })}
            />
            <FilterChips
              label="Sort"
              options={[
                { value: "name", label: "Name A to Z" },
                { value: "joined", label: "Newest" },
              ]}
              active={sort === "balance" ? null : sort}
              hrefFor={(v) => customersHref({ sort: v ?? "balance", page: "1" })}
            />
          </div>
          <DataTable
            caption="Customer wallets"
            columns={customerColumns}
            rows={customers.rows}
            rowKey={(c) => c.id}
            rowHref={(c) => `/admin/customers/${c.id}`}
            minWidth={720}
            footer={
              <TableFooter
                page={customers.page}
                totalPages={Math.max(1, Math.ceil(customers.total / PAGE_SIZE))}
                hrefFor={(n) => customersHref({ page: String(n) })}
                summary={`${nf.format(customers.total)} customer${customers.total === 1 ? "" : "s"}`}
              />
            }
            empty={<EmptyState icon={Wallet} title="No customer matches" description="Nobody matches this search." />}
          />
        </Section>
      ) : (
        <Section title="All movements" description="Every point added, used, returned or corrected, with who, when and which order.">
          <FilterForm action="/admin/customer-wallets" carry={{ view: "movements", customer: customerId ?? undefined }}>
            <label className="text-[12px] font-semibold">
              Type{" "}
              <select name="kind" defaultValue={kind ?? ""} className="c-field">
                <option value="">All types</option>
                {WALLET_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {walletKindLabel(k)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[12px] font-semibold">
              Person{" "}
              <input name="person" defaultValue={person} className="c-field" placeholder="Name or phone number" />
            </label>
            <label className="text-[12px] font-semibold">
              From{" "}
              <input type="date" name="from" defaultValue={from} className="c-field" />
            </label>
            <label className="text-[12px] font-semibold">
              To{" "}
              <input type="date" name="to" defaultValue={to} className="c-field" />
            </label>
            <button type="submit" className="c-btn c-btn-dark">
              Filter
            </button>
          </FilterForm>
          {customerId ? (
            <p className="text-[12.5px] text-muted">
              One customer only.{" "}
              <Link href={movementsHref({ customer: undefined, page: "1" })} className="underline">
                Show everyone
              </Link>
            </p>
          ) : null}
          <DataTable
            caption="Wallet movements"
            columns={movementColumns}
            rows={movements.rows}
            rowKey={(m) => m.id}
            minWidth={1080}
            footer={
              <TableFooter
                page={movements.page}
                totalPages={Math.max(1, Math.ceil(movements.total / PAGE_SIZE))}
                hrefFor={(n) => movementsHref({ page: String(n) })}
                summary={`${nf.format(movements.total)} movement${movements.total === 1 ? "" : "s"}`}
              />
            }
            empty={<EmptyState icon={Wallet} title="No movements" description="Nothing matches these filters." />}
          />
        </Section>
      )}
    </>
  );
}
