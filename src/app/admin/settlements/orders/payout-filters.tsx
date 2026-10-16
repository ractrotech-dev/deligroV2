"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { DatePicker } from "@/components/ui/date-picker";

/**
 * Shop + date filters for the order payouts screen. GET-driven, so the server
 * recomputes the list and the totals together and the two cannot disagree.
 */
export function OrderPayoutFilters({
  vendors,
  restaurantId,
  fromDate,
  toDate,
}: Readonly<{
  vendors: { id: string; name: string }[];
  restaurantId: string;
  fromDate: string;
  toDate: string;
}>) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const navigate = (patch: Record<string, string>) => {
    const usp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) usp.set(k, v);
      else usp.delete(k);
    }
    // A different shop means different orders; keeping the old status filter
    // would silently show an empty list for a shop that has plenty to pay.
    if (patch.vendor !== undefined) usp.delete("state");
    start(() => router.push(`/admin/settlements/orders?${usp.toString()}`));
  };

  return (
    <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 @3xl:grid-cols-3">
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-ink">Shop</span>
        <select
          className="h-11 w-full rounded-xl border border-line bg-bg px-3 text-ink"
          value={restaurantId}
          disabled={pending}
          onChange={(e) => navigate({ vendor: e.target.value })}
        >
          <option value="">Select a shop…</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-ink">From</span>
        <DatePicker
          value={fromDate}
          disabled={pending}
          onChange={(v) => navigate({ from: v })}
        />
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-ink">To</span>
        <DatePicker
          value={toDate}
          disabled={pending}
          onChange={(v) => navigate({ to: v })}
        />
      </label>
    </div>
  );
}
