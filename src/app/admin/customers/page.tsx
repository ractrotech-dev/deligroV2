import { requireRole } from "@/lib/auth";
import Link from "next/link";
import { Figure, FigureRow, StatusText } from "@/components/admin/console";
import { Users } from "lucide-react";
import {
  getCustomerFigures,
  listCustomers,
  type AdminCustomerRow,
  type CustomerFilter,
} from "@/lib/data-access/admin-customers";
import { AdminHero, EmptyState } from "@/components/admin/admin-ui";
import {
  DataTable,
  TableFooter,
  type Column,
} from "@/components/admin/data-table";
import { FilterChips, SearchForm } from "@/components/admin/admin-filters";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { initials } from "@/lib/utils/format";

/**
 * Admin → Customers. The live directory of everyone who has signed up, newest
 * first, so a brand-new registration shows up at the top with a "New" tag.
 * Read-only: the source of truth is `public.profiles`, populated on signup.
 *
 * This is real customer PII on an operator's screen. It stays scoped to what a
 * support call needs — who they are, how to reach them, what they have ordered.
 * Search and paging run in the database, so they cover every customer.
 *
 * The design's segment and lifetime-value columns are not here: `profiles`
 * carries neither, and neither is derivable from the order count this list
 * already loads. Inventing a "VIP" tier from a row count would be a label the
 * business never defined, printed next to a real person's phone number.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const nf = new Intl.NumberFormat("en-IN");

type Search = { q?: string; filter?: string; page?: string };

const columns: Column<AdminCustomerRow>[] = [
  {
    key: "name",
    header: "Customer",
    cell: (c) => (
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-[11px] font-bold text-accent-ink">
          {initials(c.name)}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold">{c.name}</span>
            {c.isNew ? (
              <StatusText tone="green" className="shrink-0">New</StatusText>
            ) : null}
          </span>
          <span className="text-data block truncate text-[11.5px] text-muted">
            {c.phone ?? "No phone on file"}
          </span>
        </span>
      </div>
    ),
  },
  {
    key: "joined",
    header: "Joined",
    width: "w-[150px]",
    cell: (c) => (
      <span className="text-data whitespace-nowrap text-[11.5px] text-muted">
        {c.joinedAt}
      </span>
    ),
  },
  {
    key: "orders",
    header: "Orders",
    align: "right",
    width: "w-[90px]",
    cell: (c) => (
      <span
        className={
          c.orders > 0
            ? "text-data text-[13px] font-semibold tabular-nums"
            : "text-data text-[13px] tabular-nums text-muted"
        }
      >
        {c.orders}
      </span>
    ),
  },
  {
    key: "actions",
    header: "",
    align: "right",
    width: "w-[92px]",
    cell: (c) => (
      <Link href={`/admin/customers/${c.id}`} className="c-btn-affirm">
        Profile
      </Link>
    ),
  },
];

export default async function AdminCustomersPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Search>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const filter: CustomerFilter | null = sp.filter === "new" || sp.filter === "ordered" ? sp.filter : null;
  const page = Math.max(1, Number(sp.page) || 1);

  const [result, figures] = isSupabaseConfigured
    ? await Promise.all([listCustomers({ q, filter, page, pageSize: PAGE_SIZE }), getCustomerFigures()])
    : [{ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE }, { total: null, newThisWeek: null, haveOrdered: null, orders: null }];

  const count = (n: number | null) => (n === null ? "—" : nf.format(n));
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const notOrdered = figures.total !== null && figures.haveOrdered !== null ? figures.total - figures.haveOrdered : null;
  const avgOrders =
    figures.orders !== null && figures.haveOrdered ? (figures.orders / figures.haveOrdered).toFixed(1) : figures.orders === null ? "—" : "0";

  const href = (next: Partial<Search>) => {
    const usp = new URLSearchParams();
    const merged: Search = { q, filter: filter ?? undefined, ...next };
    if (merged.q) usp.set("q", merged.q);
    if (merged.filter) usp.set("filter", merged.filter);
    if (merged.page && merged.page !== "1") usp.set("page", merged.page);
    const query = usp.toString();
    return query ? `/admin/customers?${query}` : "/admin/customers";
  };

  const filtered = Boolean(q || filter);
  const noun = result.total === 1 ? "customer" : "customers";

  return (
    <>
      <AdminHero
        title="Customers"
        tag={`${count(figures.total)} total`}
        subtitle="Newest signups first · ordering history and contact details"
      />

      <div className="flex flex-col gap-2.5">
        <SearchForm
          action="/admin/customers"
          defaultValue={q}
          placeholder="Name or phone number"
          carry={{ filter: filter ?? undefined }}
        />
        <FilterChips
          label="Customer filter"
          options={[
            { value: "new", label: "New this week", count: figures.newThisWeek ?? 0 },
            { value: "ordered", label: "Has ordered", count: figures.haveOrdered ?? 0 },
          ]}
          active={filter}
          hrefFor={(v) => href({ filter: v ?? undefined })}
        />
      </div>

      <DataTable
        caption="Customers"
        columns={columns}
        rows={result.rows}
        rowKey={(c) => c.id}
        rowHref={(c) => `/admin/customers/${c.id}`}
        minWidth={640}
        footer={
          <TableFooter
            page={result.page}
            totalPages={totalPages}
            hrefFor={(n) => href({ page: String(n) })}
            summary={`${nf.format(result.total)} ${noun}${filtered ? " found" : ""}`}
          />
        }
        empty={
          <EmptyState
            icon={Users}
            title={filtered ? "No customer matches" : "No customers yet"}
            description={
              filtered
                ? "Nobody matches this search."
                : "Everyone who signs up in the customer app appears here, newest first."
            }
            action={
              filtered ? (
                <Link href="/admin/customers" className="c-btn c-btn-outline">
                  Clear filters
                </Link>
              ) : null
            }
          />
        }
      />

      <FigureRow>
        <Figure label="Customers" value={count(figures.total)} note="Everyone who has signed up" />
        <Figure label="New this week" value={count(figures.newThisWeek)} note="Signed up in the last 7 days" />
        <Figure
          label="Have ordered"
          value={count(figures.haveOrdered)}
          note={notOrdered === null ? "At least one order" : `${nf.format(notOrdered)} have not ordered yet`}
        />
        <Figure label="Avg orders" value={avgOrders} note="Per customer who has ordered" />
      </FigureRow>
    </>
  );
}
