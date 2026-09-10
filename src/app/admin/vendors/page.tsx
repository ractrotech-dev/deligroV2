import Link from "next/link";
import { ListOrdered, Plus, Tags, TriangleAlert } from "lucide-react";
import {
  getVendorCounts,
  listVendors,
  storefrontGaps,
  type VendorListItem,
  type VendorStatus,
} from "@/lib/data-access/admin-vendors";
import { listVendorRanking } from "@/lib/data-access/admin-vendor-ranking";
import { listCategories } from "@/lib/data-access/vendor-categories";
import {
  Empty,
  MetricRow,
  PageHeader,
  Section,
  StatusText,
  Tabs,
  Toolbar,
  type MetricItem,
  type Tone,
} from "@/components/admin/console";
import { ConsoleOnly } from "@/components/admin/console-only";
import { VendorAvatar } from "@/components/admin/vendor-avatar";
import { AdminQuickLink } from "@/components/admin/admin-quick-link";
import { ApproveRestaurantButton } from "@/components/admin/approve-restaurant-button";
import { RejectVendorButton } from "@/components/admin/reject-vendor-button";
import {
  DataTable,
  TableFooter,
  type Column,
} from "@/components/admin/data-table";
import { formatINR, formatWaited } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { PAGE_SIZES } from "./page-sizes";
import { VendorSearchBar } from "./vendor-search-bar";
import { VendorPositionSelect } from "./vendor-position-select";
import { VendorPasswordCell } from "./vendor-password-cell";
import { VendorRowActions } from "./vendor-row-actions";

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
 * The status filter is promoted to tabs, because the queue and the catalogue
 * are two different jobs rather than two parts of one page: **Approvals** is
 * triage with a clock on it and carries its own Approve/Reject column and a
 * waiting time, everything else is browsing. The tab is the same `?status=`
 * that the filter bar writes, so the two can never disagree.
 */
export const dynamic = "force-dynamic";

type Search = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const STATUS_TONE: Record<VendorStatus, Tone> = {
  active: "green",
  pending: "amber",
  suspended: "red",
  inactive: "neutral",
};

const nf = new Intl.NumberFormat("en-IN");

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  month: "short",
  year: "numeric",
});

/** A signup nobody has ruled on for this long is the queue's real failure mode. */
const OVERDUE_DAYS = 4;

function isOverdue(createdAt: string): boolean {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Number.isFinite(ms) && ms > OVERDUE_DAYS * 86_400_000;
}

export default async function AdminVendorsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const q = one(sp.q) ?? "";
  const status = (one(sp.status) as VendorStatus | undefined) ?? undefined;
  const category = one(sp.category);
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
    listVendors({ q, status, category, sort, page, pageSize }),
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
  const filtered = Boolean(q || category);
  const approvals = status === "pending";

  const href = (next: Record<string, string | null>) => {
    const usp = new URLSearchParams();
    const base: Record<string, string | null> = {
      q: q || null,
      status: status ?? null,
      category: category ?? null,
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

  // Counted over the page in hand, not the whole roster: a second COUNT query
  // for a nudge is not worth it, and "3 of the 25 shown" is the honest reading
  // of a figure derived from twenty-five rows.
  const incomplete = result.items.filter((v) => storefrontGaps(v).length > 0);
  const noEmail = result.items.filter((v) => !v.ownerEmail);

  /* ---------- the roster, by state ----------
     Counts of the whole roster, not of the page in hand — `getVendorCounts`
     asks the database. The two figures after them are the opposite: they are
     derived from the twenty-five rows loaded, because a second scan of every
     shop to nudge about a missing photo is not worth the query. Their notes say
     which, so neither is read as the other. */
  const metrics: MetricItem[] = [
    {
      label: "Active partners",
      value: nf.format(counts.active),
      note: `${counts.total} on the roster`,
      href: "/admin/vendors?status=active",
    },
    {
      label: "Waiting to go live",
      value: nf.format(counts.pending),
      note: counts.pending ? "Nobody has ruled on these yet" : "Queue is clear",
      href: "/admin/vendors?status=pending",
    },
    {
      label: "Suspended",
      value: nf.format(counts.suspended),
      note: `${counts.inactive} inactive as well`,
      href: "/admin/vendors?status=suspended",
    },
    {
      // A roster-wide count, unlike the two derived figures below it: this is
      // the gap that stops a shop working rather than looking unfinished, so it
      // earns its own query. Without a pin the delivery radius cannot be
      // checked and `createOrder` refuses the order outright.
      label: "No map pin",
      value: nf.format(counts.unpinned),
      note: counts.unpinned
        ? "Cannot take orders until pinned — whole roster"
        : "Every shop on the roster is pinned",
    },
    {
      label: "Unfinished storefronts",
      value: nf.format(incomplete.length),
      note: incomplete.length
        ? "Missing a photo, address, category, phone or pin — on this page"
        : "Every shop on this page is complete",
    },
    {
      label: "No login email",
      value: nf.format(noEmail.length),
      note: noEmail.length
        ? "Cannot be issued a password until one is added"
        : "Every shop on this page can sign in",
    },
  ];

  const columns: Column<VendorListItem>[] = [
    {
      key: "shop",
      header: "Shop",
      role: "title",
      width: "w-[240px]",
      cell: (v) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <VendorAvatar
            name={v.name}
            imageUrl={v.imageUrl}
            accentTint={v.accentTint}
          />
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-semibold leading-tight">
              {v.name}
            </p>
            <p className="truncate text-[11px] text-muted">
              /{v.slug}
              {v.category ? ` · ${v.category}` : ""}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      width: "w-[190px]",
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
      key: "status",
      header: "Status",
      role: "trailing",
      width: "w-[130px]",
      cell: (v) => {
        const gaps = storefrontGaps(v);
        return (
          <div className="space-y-0.5">
            <StatusText tone={STATUS_TONE[v.status]}>
              <span className="capitalize">{v.status}</span>
            </StatusText>
            {gaps.length > 0 ? (
              <p
                className="truncate text-[10.5px] text-[color:var(--c-ink-amber)]"
                title={`Missing ${gaps.join(", ")}`}
              >
                No {gaps.join(", ")}
              </p>
            ) : null}
          </div>
        );
      },
    },
    approvals
      ? {
          key: "waiting",
          header: "Waiting",
          width: "w-[110px]",
          cell: (v) => (
            <span
              className={cn(
                "text-[12px] font-semibold",
                isOverdue(v.createdAt) ? "text-deal" : "text-muted"
              )}
            >
              {formatWaited(v.createdAt)}
            </span>
          ),
        }
      : {
          key: "commission",
          header: "Commission",
          align: "right",
          width: "w-[110px]",
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
      // Delivered orders and their value over the ranking window. "—" rather
      // than "0" when the ranking could not be read at all: zero is a claim
      // that this shop sold nothing, and not knowing is a different answer.
      key: "orders",
      header: `Orders${ranking ? ` (${ranking.windowDays}d)` : ""}`,
      align: "right",
      role: "wideOnly",
      width: "w-[92px]",
      cell: (v) => {
        const m = ranking?.byId[v.id];
        return m ? (
          <span className="text-data text-[12.5px]">{nf.format(m.orders)}</span>
        ) : (
          <span className="text-data text-[12.5px] text-[color:var(--c-faint)]">
            —
          </span>
        );
      },
    },
    {
      key: "revenue",
      header: "Revenue",
      align: "right",
      role: "wideOnly",
      width: "w-[104px]",
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
      role: "wideOnly",
      width: "w-[92px]",
      cell: (v) => (
        <span className="text-[11.5px] text-muted">
          {dateFmt.format(new Date(v.createdAt))}
        </span>
      ),
    },
    approvals
      ? {
          key: "decision",
          header: "Decision",
          role: "actions",
          width: "w-[190px]",
          cell: (v) => (
            <div className="flex items-center gap-2">
              <ApproveRestaurantButton id={v.id} name={v.name} variant="compact" />
              <RejectVendorButton id={v.id} name={v.name} />
            </div>
          ),
        }
      : {
          key: "slot",
          header: "Feed slot",
          role: "wideOnly",
          width: "w-[110px]",
          cell: (v) => <VendorPositionSelect id={v.id} position={v.sortPosition} />,
        },
    {
      key: "email",
      header: "Login email",
      width: "w-[190px]",
      cell: (v) =>
        v.ownerEmail ? (
          <span className="block truncate text-[12px]" title={v.ownerEmail}>
            {v.ownerEmail}
          </span>
        ) : (
          // Not a cosmetic gap: without an email there is no auth account to
          // hang a password on, so this shop cannot be given a login at all.
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
      width: "w-[210px]",
      cell: (v) => (
        <VendorPasswordCell id={v.id} name={v.name} password={v.loginPassword} />
      ),
    },
    {
      key: "actions",
      header: "",
      role: "actions",
      align: "right",
      width: "w-[340px]",
      cell: (v) => (
        <div className="flex justify-end">
          <VendorRowActions
            id={v.id}
            name={v.name}
            status={v.status}
            showPasswordReset={false}
          />
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Approve signups, then manage each shop like a storefront."
        status={
          counts.pending > 0 ? (
            <Link href="/admin/vendors?status=pending" className="press">
              <span className="inline-flex items-center gap-1.5 rounded-[var(--c-r-sm)] bg-[var(--c-tint-amber)] px-2 py-[3px] text-[11.5px] font-semibold text-[color:var(--c-ink-amber)]">
                <span className="c-status-dot" />
                {counts.pending} waiting to go live
              </span>
            </Link>
          ) : null
        }
        actions={
          <ConsoleOnly tool="Vendor onboarding" notice={false}>
            <Link href="/admin/vendors/new" className="c-btn c-btn-dark press">
              <Plus className="size-3.5" strokeWidth={2.4} /> Add vendor
            </Link>
          </ConsoleOnly>
        }
      />

      <ConsoleOnly
        tool="Vendor onboarding"
        why="Approving a signup, suspending a shop and searching the list all work on a phone — only adding a brand-new vendor needs the desk."
      />

      {/* The roster by state, then the two data-quality gaps that stop a shop
          working at all. The green "queue is clear" banner this replaces was a
          full-width bar saying nothing had happened; a cleared queue is
          adequately expressed by the Approvals tab reading 0. */}
      <MetricRow items={metrics} />

      {/* ---------- the catalogue ---------- */}
      <Toolbar>
        <Tabs
          label="Vendor status"
          active={href({ status: status ?? null, page: null })}
          items={[
            { href: href({ status: null, page: null }), label: "All", count: counts.total },
            {
              href: href({ status: "pending", page: null }),
              label: "Approvals",
              count: counts.pending,
            },
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
        {/* Search, category, sort and page size ride in the same sticky bar
            as the status tabs — they are one control row for one list, and
            splitting them left the search box scrolling away from the tabs
            that scope it. */}
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
          minWidth={1420}
          // Tint the rows that are actually a problem — a signup nobody has
          // ruled on for four days, or a shop that cannot be given a login —
          // rather than every row of the Approvals tab, which would tint the
          // whole table and say nothing.
          rowTone={(v) =>
            !v.ownerEmail || (v.status === "pending" && isOverdue(v.createdAt))
              ? "alert"
              : null
          }
          empty={
            approvals ? (
              <Empty action={{ href: "/admin/vendors", label: "Browse every shop" }}>
                Nothing waiting — every signup has been approved or declined.
              </Empty>
            ) : filtered || status ? (
              <Empty action={{ href: "/admin/vendors", label: "Clear filters" }}>
                No vendors match this search.
              </Empty>
            ) : (
              <Empty>Add your first shop to start taking orders.</Empty>
            )
          }
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

      <div className="grid gap-2 @3xl:grid-cols-2">
        <AdminQuickLink
          href="/admin/vendors/categories"
          label="Categories"
          hint="Group shops on the customer feed"
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
