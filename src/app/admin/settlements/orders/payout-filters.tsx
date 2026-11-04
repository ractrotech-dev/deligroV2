"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { DatePicker } from "@/components/ui/date-picker";

/**
 * Pick a shop, and optionally narrow its order list by date. The dates never change
 * the amount to send. GET-driven, so the server recomputes the list.
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
    // A different shop means different orders; keeping the old filters would
    // silently show an empty list for a shop that has plenty to pay.
    if (patch.vendor !== undefined) {
      usp.delete("state");
      usp.delete("from");
      usp.delete("to");
    }
    start(() => router.push(`/admin/settlements/orders?${usp.toString()}`));
  };

  return (
    <div className="grid grid-cols-[2fr_1fr_1fr] items-end gap-3">
      <label className="block space-y-1 text-[12.5px]">
        <span className="font-medium text-muted">Shop</span>
        <select
          className="h-9 w-full rounded-[var(--c-r)] border border-line bg-surface px-2.5 text-[13px] text-ink"
          value={restaurantId}
          disabled={pending}
          onChange={(e) => navigate({ vendor: e.target.value })}
        >
          <option value="">Choose a shop</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-[12.5px]">
        <span className="font-medium text-muted">Orders from</span>
        <DatePicker
          value={fromDate}
          disabled={pending}
          onChange={(v) => navigate({ from: v })}
        />
      </label>
      <label className="block space-y-1 text-[12.5px]">
        <span className="font-medium text-muted">Orders to</span>
        <DatePicker
          value={toDate}
          disabled={pending}
          onChange={(v) => navigate({ to: v })}
        />
      </label>
    </div>
  );
}
