import Link from "next/link";
import { StatusText } from "@/components/admin/console";
import { Users } from "lucide-react";
import {
  listCustomers,
  type AdminCustomerRow,
} from "@/lib/data-access/admin-customers";
import { AdminHero, EmptyState } from "@/components/admin/admin-ui";
import { StatTile, StatTiles } from "@/components/admin/console-ui";
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
 * support call needs — who they are, how to reach them, what they have ordered
 * — and the search runs over the loaded page rather than querying the whole
 * table by phone number.
 *
 * The design's segment and lifetime-value columns are not here: `profiles`
 * carries neither, and neither is derivable from the order count this list
 * already loads. Inventing a "VIP" tier from a row count would be a label the
 * business never defined, printed next to a real person's phone number.
 */
export const dynamic = "force-dynamic";

/** How many profiles the directory loads. Stated in the UI, not implied. */
const WINDOW = 200;

type Search = { q?: string; filter?: string };

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const [sp, customers] = await Promise.all([
    searchParams,
    isSupabaseConfigured
      ? listCustomers(WINDOW)
      : Promise.resolve<AdminCustomerRow[]>([]),
  ]);
  const q = (sp.q ?? "").trim();
  const needle = q.toLowerCase();
  const filter = sp.filter === "new" || sp.filter === "ordered" ? sp.filter : null;

  const rows = customers.filter((c) => {
    if (filter === "new" && !c.isNew) return false;
    if (filter === "ordered" && c.orders === 0) return false;
    if (!needle) return true;
    return (
      c.name.toLowerCase().includes(needle) ||
      (c.phone ?? "").toLowerCase().includes(needle)
    );
  });

  const newCount = customers.filter((c) => c.isNew).length;
  const ordered = customers.filter((c) => c.orders > 0).length;
  const totalOrders = customers.reduce((sum, c) => sum + c.orders, 0);
  const avgOrders =
    ordered > 0 ? (totalOrders / ordered).toFixed(1) : "0";

  const href = (next: Partial<Search>) => {
    const usp = new URLSearchParams();
    const merged = { q, filter: filter ?? undefined, ...next };
    if (merged.q) usp.set("q", merged.q);
    if (merged.filter) usp.set("filter", merged.filter);
    const query = usp.toString();
    return query ? `/admin/customers?${query}` : "/admin/customers";
  };

  const columns: Column<AdminCustomerRow>[] = [
    {
      key: "name",
      header: "Customer",
      role: "title",
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
      role: "trailing",
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
      role: "actions",
      align: "right",
      width: "w-[92px]",
      cell: (c) => (
        <Link href={`/admin/customers/${c.id}`} className="c-btn-affirm press">
          Profile
        </Link>
      ),
    },
  ];

  const filtered = Boolean(q || filter);

  return (
    <>
      <AdminHero
        title="Customers"
        tag={`${customers.length} loaded`}
        subtitle="Newest signups first · ordering history and contact details"
      />

      {customers.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <SearchForm
            action="/admin/customers"
            defaultValue={q}
            placeholder="Name or phone number"
            carry={{ filter: filter ?? undefined }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FilterChips
              label="Customer filter"
              options={[
                { value: "new", label: "New this week", count: newCount },
                { value: "ordered", label: "Has ordered", count: ordered },
              ]}
              active={filter}
              hrefFor={(v) => href({ filter: v ?? undefined })}
            />
            <p className="text-xs text-muted">
              The {WINDOW} most recent signups
            </p>
          </div>
        </div>
      ) : null}

      <DataTable
        caption="Customers"
        columns={columns}
        rows={rows}
        rowKey={(c) => c.id}
        rowHref={(c) => `/admin/customers/${c.id}`}
        minWidth={640}
        footer={
          <TableFooter
            page={1}
            totalPages={1}
            hrefFor={() => "/admin/customers"}
            summary={
              filtered
                ? `${rows.length} of ${customers.length} loaded`
                : `${customers.length} customer${customers.length === 1 ? "" : "s"} loaded`
            }
          />
        }
        empty={
          <EmptyState
            icon={Users}
            title={filtered ? "No customer matches" : "No customers yet"}
            description={
              filtered
                ? `Nothing in the ${customers.length} most recent signups matches.`
                : "Everyone who signs up in the customer app appears here, newest first."
            }
            action={
              filtered ? (
                <Link href="/admin/customers" className="c-btn c-btn-outline press">
                  Clear filters
                </Link>
              ) : null
            }
          />
        }
      />

      {customers.length > 0 ? (
        <StatTiles>
          <StatTile
            label="New this week"
            value={newCount}
            note="Signed up in the last 7 days"
          />
          <StatTile
            label="Have ordered"
            value={ordered}
            note={`${customers.length - ordered} have not ordered yet`}
          />
          <StatTile
            label="Avg orders"
            value={avgOrders}
            note="Per customer who has ordered"
          />
        </StatTiles>
      ) : null}
    </>
  );
}
