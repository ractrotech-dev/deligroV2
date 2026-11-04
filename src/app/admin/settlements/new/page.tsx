import { requireRole } from "@/lib/auth";
import { AdminHero } from "@/components/admin/admin-ui";
import {
  CYCLE_LABEL,
  DEFAULT_SETTLEMENT_CYCLE,
  lastCompletePeriod,
} from "@/lib/settlements/cycle";
import {
  listSettlementVendors,
  previewSettlement,
} from "@/lib/data-access/admin-settlements";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { SettlementPreviewPanel } from "./settlement-preview-panel";
import { NewSettlementForm } from "./new-settlement-form";

export const dynamic = "force-dynamic";

type Search = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function NewSettlementPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Search>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  if (!isSupabaseConfigured) {
    return (
      <AdminHero
        backHref="/admin/settlements"
        backLabel="Settlements"
        title="Pay by dates"
        subtitle="Connect Supabase to pay shops."
      />
    );
  }

  const sp = await searchParams;
  const restaurantId = one(sp.restaurantId) ?? "";
  const vendors = await listSettlementVendors().catch(() => []);

  // The dates default to the vendor's own cycle — last full week, or last full
  // calendar month — rather than to "this week so far". Typing a range by hand
  // is where periods overlap (paying twice) or leave a gap (never paying), and
  // the cycle is the operator's own statement of which range is correct. Either
  // date can still be overridden.
  const vendor = vendors.find((v) => v.id === restaurantId);
  const cycle = vendor?.settlementCycle ?? DEFAULT_SETTLEMENT_CYCLE;
  const suggested = lastCompletePeriod(cycle);
  const fromDate = one(sp.from) ?? suggested.from;
  const toDate = one(sp.to) ?? suggested.to;

  let preview = null;
  let previewError: string | null = null;
  if (restaurantId) {
    const result = await previewSettlement({
      restaurantId,
      fromDate,
      toDate,
    }).catch(() => ({ error: "Could not preview. Is migration 0028 applied?" }));
    if ("error" in result) previewError = result.error;
    else preview = result;
  }

  return (
    <>
      {/* Back link via AdminHero, not a separate BackLink above it — every
          other sub-page in the console puts it inside the header. */}
      <AdminHero
        backHref="/admin/settlements"
        backLabel="Settlements"
        title="Pay by dates"
        subtitle="Pay a shop only for orders on the dates you choose."
      />

      <NewSettlementForm
        vendors={vendors}
        restaurantId={restaurantId}
        fromDate={fromDate}
        toDate={toDate}
        cycleNote={
          vendor
            ? `${vendor.name} is paid ${CYCLE_LABEL[cycle].toLowerCase()}. The dates show the ${suggested.label.toLowerCase()}.`
            : null
        }
      />

      {previewError ? (
        <p className="text-[13px] font-medium text-deal">{previewError}</p>
      ) : null}

      {preview ? (
        <SettlementPreviewPanel
          preview={preview}
          fromDate={fromDate}
          toDate={toDate}
        />
      ) : null}
    </>
  );
}
