import { requireRole } from "@/lib/auth";
import {
  Empty,
  PageHeader,
  Section,
  Tabs,
  Toolbar,
} from "@/components/admin/console";
import { DataTable, TableFooter, type Column } from "@/components/admin/data-table";
import { FilterForm, FilterReset, FilterSubmit, SearchField } from "@/components/admin/admin-filters";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  getOrderSmsSettings,
  listVendorSmsPage,
  type VendorSmsFilter,
  type VendorSmsRow,
} from "@/lib/data-access/vendor-order-sms";
import { pageCountOf, toPage } from "@/lib/utils/paging";
import { ShopNumber, ShopSmsSwitch, SmsSettingsForm } from "./sms-controls";

/**
 * Settings → Vendor SMS. WEB. A text to the shop for each new order: the switch and
 * message, then the shops. A shop's number comes from its registration
 * (`owner_mobile`) and is only typed here when it has none or needs a different one.
 * The list is searched and paged in the URL, so a long one is never sent in full.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const columns: Column<VendorSmsRow>[] = [
  {
    key: "shop",
    header: "Shop",
    cell: (s) => <span className="text-[13.5px] font-semibold text-ink">{s.name}</span>,
  },
  {
    key: "number",
    header: "Number",
    cell: (s) => <ShopNumber shop={s} />,
  },
  {
    key: "sms",
    header: "SMS",
    align: "right",
    width: "w-[90px]",
    cell: (s) => <ShopSmsSwitch shop={s} />,
  },
];

export default async function AdminSmsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ q?: string; show?: string; page?: string }>;
}>) {
  await requireRole("admin");

  const header = (
    <PageHeader title="Vendor SMS" back={{ href: "/admin/settings", label: "Settings" }} />
  );

  if (!isSupabaseConfigured) {
    return (
      <>
        {header}
        <Empty>Connect Supabase to manage SMS.</Empty>
      </>
    );
  }

  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const show: VendorSmsFilter = sp.show === "missing" || sp.show === "off" ? sp.show : "all";

  let loaded: {
    settings: Awaited<ReturnType<typeof getOrderSmsSettings>>;
    shops: Awaited<ReturnType<typeof listVendorSmsPage>>;
  } | null = null;
  try {
    const [settings, shops] = await Promise.all([
      getOrderSmsSettings(),
      listVendorSmsPage({ q, show, page: toPage(sp.page), pageSize: PAGE_SIZE }),
    ]);
    loaded = { settings, shops };
  } catch {
    loaded = null;
  }

  if (!loaded) {
    return (
      <>
        {header}
        <p className="text-[13px] font-medium text-deal">Couldn&apos;t load this page. Refresh to try again.</p>
      </>
    );
  }
  const { settings, shops } = loaded;

  if (!settings.installed) {
    return (
      <>
        {header}
        <Empty>Vendor SMS needs migration 0175 applied.</Empty>
      </>
    );
  }

  const href = (next: { show?: VendorSmsFilter; page?: number }) => {
    const usp = new URLSearchParams();
    const nextShow = next.show ?? show;
    if (q) usp.set("q", q);
    if (nextShow !== "all") usp.set("show", nextShow);
    if (next.page && next.page > 1) usp.set("page", String(next.page));
    const qs = usp.toString();
    return qs ? `/admin/settings/sms?${qs}` : "/admin/settings/sms";
  };

  return (
    <>
      {header}

      {!settings.gatewayConfigured ? (
        <p className="text-[13px] font-medium text-[color:var(--c-ink-amber)]">
          SMS gateway not connected, so nothing is being sent.
        </p>
      ) : null}

      <Section flush title="Message">
        <SmsSettingsForm enabled={settings.enabled} template={settings.template} />
      </Section>

      <Section title="Shops">
        <Toolbar>
          <FilterForm action="/admin/settings/sms" carry={{ show: show === "all" ? undefined : show }}>
            <SearchField defaultValue={q} placeholder="Search shops" />
            <FilterSubmit label="Search" />
          </FilterForm>
          {q ? <FilterReset href="/admin/settings/sms" /> : null}
        </Toolbar>
        <Tabs
          label="Which shops"
          active={href({})}
          items={[
            { href: href({ show: "all" }), label: "All", count: shops.counts.all },
            { href: href({ show: "missing" }), label: "No number", count: shops.counts.missing },
            { href: href({ show: "off" }), label: "SMS off", count: shops.counts.off },
          ]}
        />
        <DataTable
          caption="Shops"
          columns={columns}
          rows={shops.rows}
          rowKey={(s) => s.restaurantId}
          minWidth={640}
          empty={<Empty>No shops here.</Empty>}
          footer={
            shops.total > PAGE_SIZE ? (
              <TableFooter
                page={shops.page}
                totalPages={pageCountOf(shops.total, PAGE_SIZE)}
                hrefFor={(p) => href({ page: p })}
                summary={`${shops.total} shops`}
              />
            ) : undefined
          }
        />
      </Section>
    </>
  );
}
