import { requireRole } from "@/lib/auth";
import Link from "next/link";
import { ListOrdered, Plus, Star, Tags, TriangleAlert } from "lucide-react";
import {
  getVendorCounts,
  listVendors,
  storefrontGaps,
  type VendorListItem,
  type VendorStatus,
} from "@/lib/data-access/admin-vendors";
import {
  listVendorRanking,
  type VendorRanking,
} from "@/lib/data-access/admin-vendor-ranking";
import { listCategories } from "@/lib/data-access/vendor-categories";
import {
  Empty,
  MetricRow,
  PageHeader,
  Section,
  Tabs,
  Toolbar,
  type MetricItem,
} from "@/components/admin/console";
import { VendorAvatar } from "@/components/admin/vendor-avatar";
import { AdminQuickLink } from "@/components/admin/admin-quick-link";
import {
  DataTable,
  TableFooter,
  type Column,
} from "@/components/admin/data-table";
import { formatINR } from "@/lib/utils/format";
import { PAGE_SIZES } from "./page-sizes";
import { VendorSearchBar } from "./vendor-search-bar";
import { VendorMasterSwitch } from "./vendor-master-switch";
import { VendorPasswordCell } from "./vendor-password-cell";
import { VendorRowActions, VendorStatusToggle } from "./vendor-row-actions";
import {
  VENDOR_GAPS,
  VENDOR_OPEN_STATES,
  VENDOR_RATES,
  pickFilter,
} from "@/lib/vendor-status";

/**
 * Admin → Vendors: the partner directory, as a table.
 *
 * This used to be a grid of profile cards. Each one was about 280px tall, so a
 * roster of forty shops was a page you scrolled for a minute — and the facts an
 * operator actually opens this screen for (who is waiting, what is this shop's
 * number, what is their password) were spread across three regions of a card
 * that mostly held whitespace. A directory is a table. One row per shop, the
 * columns you can scan down, and the decorative half deleted.
 *
 * The status filter is promoted to tabs, on a row of their own. Everything else
 * that narrows the list sits in the Filters panel on the row below. The last
 * column is the on/off switch, with the master switch in its header. There is no
 * approvals queue:
 * vendors cannot sign themselves up, so a shop is live the moment an admin or a
 * manager adds it (see docs/RULE-BOOK.md).
 */
export const dynamic = "force-dynamic";

type Search = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const nf = new Intl.NumberFormat("en-IN");

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  month: "short",
  year: "numeric",
});

/** The table's empty state: nothing matching, or no shops yet. */
function vendorsEmpty(narrowed: boolean): React.ReactNode {
  if (narrowed) {
    return (
      <Empty action={{ href: "/admin/vendors", label: "Clear filters" }}>
        No vendors match this search.
      </Empty>
    );
  }
  return <Empty>Add your first shop to start taking orders.</Empty>;
}

function vendorColumns(
  ranking: VendorRanking | null,
  counts: { active: number; enableable: number }
): Column<VendorListItem>[] {
  return [
    {
      key: "shop",
      header: "Shop",
      width: "w-[250px]",
      cell: (v) => {
        const gaps = storefrontGaps(v);
        return (
        <div className="flex min-w-0 items-center gap-2.5">
          <VendorAvatar
            name={v.name}
            imageUrl={v.imageUrl}
            accentTint={v.accentTint}
          />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[13.5px] font-semibold leading-tight">
              <span className="truncate">{v.name}</span>
              {v.sortPosition === null ? null : (
                <span
                  className="text-data inline-flex shrink-0 items-center gap-0.5 text-[11px] text-[color:var(--c-ink-amber)]"
                  title={`Featured slot ${v.sortPosition}`}
                >
                  <Star className="size-3 fill-current" />#{v.sortPosition}
                </span>
              )}
            </p>
            <p className="truncate text-[11px] text-muted">
              /{v.slug}
              {v.category ? ` · ${v.category}` : ""}
            </p>
            {gaps.length > 0 ? (
              <p
                className="truncate text-[10.5px] text-[color:var(--c-ink-amber)]"
                title={`Missing ${gaps.join(", ")}`}
              >
                No {gaps.join(", ")}
              </p>
            ) : null}
          </div>
        </div>
        );
      },
    },
    {
      key: "owner",
      header: "Owner",
      width: "w-[170px]",
      cell: (v) => (
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-medium">
            {v.ownerName ?? "—"}
          </p>
          {v.ownerMobile ? (
            <a
              href={`tel:${v.ownerMobile}`}
              className="text-data block truncate text-[11.5px] text-muted hover:text-accent-ink"
            >
              {v.ownerMobile}
            </a>
          ) : (
            <p className="text-[11.5px] text-muted">No mobile</p>
          )}
        </div>
      ),
    },
    {
      key: "commission",
      header: "Commission",
      align: "right",
      width: "w-[90px]",
      cell: (v) => (
        <div>
          <p className="text-data text-[12.5px] font-semibold">
            {v.effectiveCommissionPct}%
          </p>
          <p className="text-[10.5px] text-muted">
            {v.inheritsPlatformRate ? "Platform" : "Own rate"}
          </p>
        </div>
      ),
    },
    {
      key: "revenue",
      header: ranking ? `Revenue (${ranking.windowDays}d)` : "Revenue",
      align: "right",
      width: "w-[100px]",
      cell: (v) => {
        const m = ranking?.byId[v.id];
        return m ? (
          <span className="text-data text-[12.5px] font-semibold text-ink">
            {formatINR(m.sales)}
          </span>
        ) : (
          <span className="text-data text-[12.5px] text-[color:var(--c-faint)]">
            —
          </span>
        );
      },
    },
    {
      key: "since",
      header: "Since",
      width: "w-[80px]",
      cell: (v) => (
        <span className="text-[11.5px] text-muted">
          {dateFmt.format(new Date(v.createdAt))}
        </span>
      ),
    },
    {
      key: "email",
      header: "Contact email",
      width: "w-[170px]",
      cell: (v) =>
        v.ownerEmail ? (
          <span className="block truncate text-[12px]" title={v.ownerEmail}>
            {v.ownerEmail}
          </span>
        ) : (
          // The desk's way to reach the owner. Their login is separate (Access tab).
          <Link
            href={`/admin/vendors/${v.id}/edit`}
            className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-deal hover:underline"
          >
            <TriangleAlert className="size-3" /> Add an email
          </Link>
        ),
    },
    {
      key: "password",
      header: "Password",
      width: "w-[290px]",
      cell: (v) => (
        <VendorPasswordCell id={v.id} name={v.name} password={v.loginPassword} />
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "w-[150px]",
      cell: (v) => (
        <div className="flex justify-end">
          <VendorRowActions
            id={v.id}
            name={v.name}
            status={v.status}
            // The shop's name already opens it, and the status column has the
            // switch, so the row keeps only what it has nowhere else.
            showView={false}
            showToggle={false}
          />
        </div>
      ),
    },
    {
      key: "enabled",
      header: "Enabled",
      headerControl: (
        <VendorMasterSwitch active={counts.active} enableable={counts.enableable} />
      ),
      align: "right",
      width: "w-[100px]",
      cell: (v) => <VendorStatusToggle id={v.id} name={v.name} status={v.status} />,
    },
  ];
}

export default async function AdminVendorsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Search>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const sp = await searchParams;
  const q = one(sp.q) ?? "";
  const status = (one(sp.status) as VendorStatus | undefined) ?? undefined;
  const category = one(sp.category);
  const gap = pickFilter(VENDOR_GAPS, one(sp.gap));
  const rate = pickFilter(VENDOR_RATES, one(sp.rate));
  const open = pickFilter(VENDOR_OPEN_STATES, one(sp.open));
  const sort = one(sp.sort) as
    | "recent"
    | "oldest"
    | "name"
    | "status"
    | undefined;
  const page = Math.max(1, Number(one(sp.page) ?? "1") || 1);
  const pageSize = PAGE_SIZES.includes(Number(one(sp.per)))
    ? Number(one(sp.per))
    : PAGE_SIZES[0];

  const [counts, result, categories, ranking] = await Promise.all([
    getVendorCounts(),
    listVendors({ q, status, category, gap, rate, open, sort, page, pageSize }),
    listCategories(),
    // What each shop actually sells, over the ranking module's own rolling
    // window. A directory that cannot answer "which of these is worth
    // anything" is an address book, and the operator's next move after finding
    // a shop is almost always to ask that.
    //
    // It is not free — the ranking scans delivered orders up to its own cap —
    // and it is deliberately `catch`ed to null rather than allowed to take the
    // page with it: without it the two columns read "—" and the directory still
    // does its job.
    listVendorRanking().catch(() => null),
  ]);

  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  const categoryNames = categories.map((c) => c.name);
  const filtered = Boolean(q || category || gap || rate || open);

  const href = (next: Record<string, string | null>) => {
    const usp = new URLSearchParams();
    const base: Record<string, string | null> = {
      q: q || null,
      status: status ?? null,
      category: category ?? null,
      gap: gap ?? null,
      rate: rate ?? null,
      open: open ?? null,
      sort: sort ?? null,
      per: pageSize === PAGE_SIZES[0] ? null : String(pageSize),
      page: page > 1 ? String(page) : null,
      ...next,
    };
    for (const [key, value] of Object.entries(base)) {
      if (value) usp.set(key, value);
    }
    const query = usp.toString();
    return query ? `/admin/vendors?${query}` : "/admin/vendors";
  };

  /* ---------- the roster, by state ----------
     Every figure is a count of the whole roster: `getVendorCounts` asks the
     database. None of them changes with the page in hand. */
  const metrics: MetricItem[] = [
    {
      label: "Active partners",
      value: nf.format(counts.active),
      note: `${counts.total} on the roster`,
      href: "/admin/vendors?status=active",
    },
    {
      label: "Inactive",
      value: nf.format(counts.inactive),
      note: counts.inactive ? "Switched off, or waiting for a map pin" : "Every shop is switched on",
      href: "/admin/vendors?status=inactive",
    },
    {
      label: "Suspended",
      value: nf.format(counts.suspended),
      note: counts.suspended ? "Taken off the storefront" : "None suspended",
      href: "/admin/vendors?status=suspended",
    },
    {
      // The gap that stops a shop working rather than looking unfinished. Without
      // a pin the delivery radius cannot be checked and `createOrder` refuses the
      // order outright.
      label: "No map pin",
      value: nf.format(counts.unpinned),
      note: counts.unpinned ? "Cannot take orders until pinned" : "Every shop is pinned",
      href: "/admin/vendors?gap=no_pin",
    },
    {
      label: "Unfinished storefronts",
      value: nf.format(counts.incomplete),
      note: counts.incomplete ? "Missing a photo, address, category, phone or pin" : "Every shop is complete",
      href: "/admin/vendors?gap=incomplete",
    },
    {
      label: "No contact email",
      value: nf.format(counts.noEmail),
      note: counts.noEmail ? "Add one on the shop's edit page" : "Every shop has one",
      href: "/admin/vendors?gap=no_email",
    },
  ];

  const columns = vendorColumns(ranking, counts);

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Add shops and manage each one like a storefront."
        actions={
          <>
            <Link href="/admin/vendors/new" className="c-btn c-btn-dark">
              <Plus className="size-3.5" strokeWidth={2.4} /> Add vendor
            </Link>
          </>
        }
      />


      {/* The roster by state, then the two data-quality gaps that stop a shop
          working at all. */}
      <MetricRow items={metrics} />

      {/* ---------- the catalogue ---------- */}
      <Toolbar>
        <Tabs
          label="Vendor status"
          className="w-fit"
          active={href({ status: status ?? null, page: null })}
          items={[
            { href: href({ status: null, page: null }), label: "All", count: counts.total },
            {
              href: href({ status: "active", page: null }),
              label: "Active",
              count: counts.active,
            },
            {
              href: href({ status: "inactive", page: null }),
              label: "Inactive",
              count: counts.inactive,
            },
            {
              href: href({ status: "suspended", page: null }),
              label: "Suspended",
              count: counts.suspended,
            },
          ]}
        />
        {/* Its own row under the tabs, inside the same sticky bar, so the
            search box does not scroll away from the tabs that scope it. */}
        <VendorSearchBar categories={categoryNames} />
      </Toolbar>

      <Section flush>
        <DataTable
          columns={columns}
          rows={result.items}
          rowKey={(v) => v.id}
          rowHref={(v) => `/admin/vendors/${v.id}?tab=overview`}
          caption="Vendors"
          dense
          minWidth={1410}
          // Tint the rows that are actually a problem: a shop that cannot be
          // given a login.
          rowTone={(v) => (!v.ownerEmail ? "alert" : null)}
          empty={vendorsEmpty(filtered || Boolean(status))}
          footer={
            <TableFooter
              page={page}
              totalPages={totalPages}
              hrefFor={(n) => href({ page: n > 1 ? String(n) : null })}
              summary={`${result.total} vendor${result.total === 1 ? "" : "s"}${
                filtered || status ? " matching" : ""
              }`}
            />
          }
        />
      </Section>

      <div className="grid gap-2 grid-cols-2">
        <AdminQuickLink
          href="/admin/vendors/categories"
          label="Categories"
          hint="Labels for filing shops in Admin"
          icon={Tags}
        />
        <AdminQuickLink
          href="/admin/vendors/slots"
          label="Featured slots"
          hint="Pin up to ten shops at the top of the feed"
          icon={ListOrdered}
        />
      </div>
    </>
  );
}
