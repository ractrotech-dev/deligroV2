"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { DatePicker } from "@/components/ui/date-picker";

/**
 * GET-driven filters: changing vendor/dates navigates so the server can
 * recompute the preview. Creating the draft is a separate form on the preview.
 */
export function NewSettlementForm({
  vendors,
  restaurantId,
  fromDate,
  toDate,
  cycleNote = null,
}: Readonly<{
  vendors: {
    id: string;
    name: string;
    commissionPct: number;
    inheritsPlatformRate: boolean;
  }[];
  restaurantId: string;
  fromDate: string;
  toDate: string;
  /** Which cycle this vendor is on, and what the pre-filled dates mean. */
  cycleNote?: string | null;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function navigate(next: {
    restaurantId?: string;
    from?: string;
    to?: string;
  }) {
    const usp = new URLSearchParams();
    const rid = next.restaurantId ?? restaurantId;
    if (rid) usp.set("restaurantId", rid);
    // Changing the VENDOR deliberately drops the dates: the next vendor may be
    // on a different cycle, and carrying over a weekly range onto a monthly
    // vendor is exactly the mis-typed period the cycle exists to prevent. The
    // server then re-derives the default for whoever was picked.
    if (!next.restaurantId) {
      const from = next.from ?? fromDate;
      const to = next.to ?? toDate;
      if (from) usp.set("from", from);
      if (to) usp.set("to", to);
    }
    startTransition(() => {
      router.push(`/admin/settlements/new?${usp.toString()}`);
    });
  }

  return (
    <div className="space-y-3">
      {cycleNote ? (
        <p className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-muted">
          {cycleNote}
        </p>
      ) : null}
      <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 @3xl:grid-cols-3">
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-ink">Vendor</span>
        <select
          className="h-11 w-full rounded-xl border border-line bg-bg px-3 text-ink"
          value={restaurantId}
          disabled={pending}
          onChange={(e) => navigate({ restaurantId: e.target.value })}
        >
          <option value="">Select a restaurant…</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.commissionPct}%{v.inheritsPlatformRate ? " platform" : ""})
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-ink">From (IST)</span>
        <DatePicker
          value={fromDate}
          disabled={pending}
          onChange={(v) => navigate({ from: v })}
        />
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-ink">To (IST)</span>
        <DatePicker
          value={toDate}
          disabled={pending}
          onChange={(v) => navigate({ to: v })}
        />
      </label>
      </div>
    </div>
  );
}
