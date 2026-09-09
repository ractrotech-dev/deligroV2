import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PageHeader,
  StatusBadge,
  StatusText,
  Tabs,
  Toolbar,
  type Tone,
} from "@/components/admin/console";
import {
  getVendorDetail,
  type VendorDetail,
  type VendorStatus,
} from "@/lib/data-access/admin-vendors";
import { listMenuItems } from "@/lib/data-access/admin-menu";
import { listCategories } from "@/lib/data-access/vendor-categories";
import { listVendorDocuments, type VendorDocument } from "@/lib/data-access/vendor-documents";
import { VendorRowActions } from "../vendor-row-actions";
import { ConsoleOnly } from "@/components/admin/console-only";
import { MenuManager } from "./menu-manager";
import { DocumentsManager } from "./documents-manager";
import { VendorOverview } from "./vendor-overview";
import { Card, Row, fmtDate, fmtTime, rupees } from "./vendor-fields";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<VendorStatus, Tone> = {
  active: "green",
  pending: "amber",
  inactive: "neutral",
  suspended: "red",
};

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "business", label: "Business" },
  { id: "menu", label: "Menu" },
  { id: "payment", label: "Payment" },
  { id: "documents", label: "Documents" },
  { id: "activity", label: "Activity" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const DAY_VALUES = [7, 14, 30] as const;

export default async function VendorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; days?: string }>;
}) {
  const { id } = await params;
  const { tab, days: daysRaw } = await searchParams;
  const active: TabId = TABS.some((t) => t.id === tab)
    ? (tab as TabId)
    : "overview";
  const requested = Number(daysRaw);
  const days = (DAY_VALUES as readonly number[]).includes(requested)
    ? requested
    : 30;

  const vendor = await getVendorDetail(id);
  if (!vendor) notFound();

  const [menuItems, menuCategories, documents] = await Promise.all([
    active === "menu" ? listMenuItems(id) : Promise.resolve([]),
    active === "menu"
      ? listCategories().then((cs) => cs.map((c) => c.name))
      : Promise.resolve([] as string[]),
    active === "documents" ? listVendorDocuments(id) : Promise.resolve([]),
  ]);

  const tabHref = (tabId: string) =>
    `/admin/vendors/${id}?tab=${tabId}&days=${days}`;

  return (
    <>
      <PageHeader
        back={{ href: "/admin/vendors", label: "Vendors" }}
        title={vendor.name}
        description={`/${vendor.slug} · ${vendor.category ?? "Uncategorised"} · ${vendor.effectiveCommissionPct}% commission`}
        status={
          <StatusBadge tone={STATUS_TONE[vendor.status]}>
            <span className="capitalize">{vendor.status}</span>
          </StatusBadge>
        }
        leading={
          <div
            className="grid size-11 place-items-center overflow-hidden rounded-[var(--c-r)] bg-cover bg-center text-lg font-bold text-white"
            style={
              vendor.imageUrl
                ? { backgroundImage: `url(${vendor.imageUrl})` }
                : { background: vendor.accentTint ?? "var(--accent)" }
            }
          >
            {vendor.imageUrl ? "" : vendor.name.charAt(0).toUpperCase()}
          </div>
        }
        actions={
          <>
            <Link href={`/admin/vendors/${id}/edit`}>
              <Button size="sm" variant="outline">
                <Pencil className="size-3.5" /> Edit
              </Button>
            </Link>
            <VendorRowActions
              id={vendor.id}
              name={vendor.name}
              status={vendor.status}
              showView={false}
              showEdit={false}
              showPasswordReset={false}
              showDelete={false}
            />
          </>
        }
      />

      {/* Sticky, because a shop's record is long: the menu tab runs to a
          hundred dishes and the activity tab to a wall of dates, and scrolling
          back to the top to change section is the sort of small tax an
          operator pays forty times a day. */}
      <Toolbar>
        <Tabs
          label="Vendor sections"
          active={tabHref(active)}
          items={TABS.map((t) => ({ href: tabHref(t.id), label: t.label }))}
        />
      </Toolbar>

      {active === "overview" ? (
        <VendorOverview vendor={vendor} days={days} />
      ) : null}
      {active === "business" ? <BusinessTab v={vendor} /> : null}
      {active === "menu" ? (
        <ConsoleOnly
          variant="page"
          tool="The menu editor"
          why="Every other tab on this shop — overview, business, payment, documents, activity — reads fine here."
        >
          <MenuManager
            restaurantId={id}
            items={menuItems}
            categories={menuCategories}
          />
        </ConsoleOnly>
      ) : null}
      {active === "payment" ? <PaymentTab v={vendor} id={id} /> : null}
      {active === "documents" ? (
        <DocumentsTab v={vendor} documents={documents} />
      ) : null}
      {active === "activity" ? <ActivityTab v={vendor} /> : null}
    </>
  );
}

function BusinessTab({ v }: { v: VendorDetail }) {
  return (
    <div className="grid gap-x-6 gap-y-1 @3xl:grid-cols-2">
      <Card title="About">
        <Row label="Tagline" value={v.tagline} />
        <Row label="Description" value={v.description} />
        <Row label="Cuisines" value={v.cuisines.join(", ")} />
      </Card>
      <Card title="Hours & fulfilment">
        <Row label="Opening" value={fmtTime(v.openingTime)} />
        <Row label="Closing" value={fmtTime(v.closingTime)} />
        <Row label="Weekly off" value={v.weeklyOff.join(", ")} />
        <Row label="Delivery" value={v.deliveryAvailable ? "Yes" : "No"} />
        <Row label="Self pickup" value={v.selfPickup ? "Yes" : "No"} />
      </Card>
    </div>
  );
}

/** Same rule the settlements queue uses, so "incomplete" never disagrees between the two screens. */
function hasPayoutDetails(v: VendorDetail): boolean {
  return Boolean(
    v.upiId?.trim() || (v.bankAccountNumber?.trim() && v.bankIfsc?.trim())
  );
}

/**
 * A yes/no fact about a shop — self pickup, delivery, GST registered.
 *
 * A dot and a word rather than a tinted capsule. Eight of these down the
 * Business and Payment tabs was eight capsules competing with each other and
 * with the real statuses on the same screen; green is reserved for things that
 * are going well, and "delivery: no" is not going badly.
 */
function YesNoPill({ value }: { value: boolean }) {
  return (
    <StatusText tone={value ? "green" : "neutral"}>
      {value ? "Yes" : "No"}
    </StatusText>
  );
}

function PaymentTab({ v, id }: { v: VendorDetail; id: string }) {
  const payoutReady = hasPayoutDetails(v);

  return (
    <div className="space-y-3">
      {!payoutReady ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-deal/25 bg-deal/5 px-4 py-3 text-sm">
          <span className="font-semibold text-deal">
            Bank details incomplete.
          </span>
          <span className="text-muted">
            Payouts settle to nothing until a UPI ID or bank account is added.
          </span>
          <Link
            href={`/admin/vendors/${id}/edit`}
            className="press ml-auto text-xs font-semibold text-accent-ink"
          >
            Add bank account
          </Link>
        </div>
      ) : null}

      <div className="grid gap-x-6 gap-y-1 @3xl:grid-cols-2">
        <Card title="Commission & methods">
          <Row
            label="Commission"
            value={`${v.effectiveCommissionPct}%${
              v.inheritsPlatformRate ? " · platform rate" : ""
            }`}
          />
          <Row label="Accepts COD" value={<YesNoPill value={v.acceptCod} />} />
          <Row
            label="Accepts online"
            value={<YesNoPill value={v.acceptOnline} />}
          />
          <Row
            label="COD max"
            value={v.codMaxOrder > 0 ? rupees(v.codMaxOrder) : "No limit"}
          />
          <Row
            label="Other charges"
            value={
              v.otherChargesPerOrder > 0
                ? `${rupees(v.otherChargesPerOrder)} / order`
                : "None"
            }
          />
          <Row label="Settlement" value={v.settlementCycle} />
        </Card>
        <Card title="Payout destination">
          {v.upiId ? (
            <div className="mb-2 flex items-center gap-3 rounded-lg bg-surface-2 p-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-sm font-bold text-accent">
                ₹
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-data truncate text-[13.5px] font-bold">
                  {v.upiId}
                </p>
                <p className="text-[11px] text-muted">
                  UPI · primary payout method
                </p>
              </div>
            </div>
          ) : null}
          <Row label="Account name" value={v.bankAccountName} />
          <Row label="Bank" value={v.bankName} />
          <Row label="Account no." value={v.bankAccountNumber} />
          <Row label="IFSC" value={v.bankIfsc} />
        </Card>
      </div>
    </div>
  );
}

function DocumentsTab({
  v,
  documents,
}: {
  v: VendorDetail;
  documents: VendorDocument[];
}) {
  return (
    <div className="grid gap-x-6 gap-y-1 @3xl:grid-cols-2">
      <Card title="Legal identifiers">
        <Row label="FSSAI" value={v.fssaiNumber} />
        <Row label="GST" value={v.gstNumber} />
        <Row label="PAN" value={v.panNumber} />
      </Card>
      <div className="@3xl:col-span-1">
        <DocumentsManager restaurantId={v.id} documents={documents} />
      </div>
    </div>
  );
}

function ActivityTab({ v }: { v: VendorDetail }) {
  return (
    <div className="space-y-3">
      <Card title="Registration & terms">
        <Row label="Status" value={v.status} />
        <Row label="Registered" value={fmtDate(v.createdAt)} />
        <Row label="T&C accepted" value={fmtDate(v.tcAcceptedAt)} />
        <Row label="T&C version" value={v.tcVersion} />
      </Card>
      <p className="px-1 text-xs text-muted">
        A full activity/audit log arrives in a later phase.
      </p>
    </div>
  );
}
