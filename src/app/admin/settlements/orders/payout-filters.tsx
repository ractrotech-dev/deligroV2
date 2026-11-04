"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ChevronDown } from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";

/**
 * Pick a shop; dates are tucked away because they only narrow the order list, and
 * never change the amount to send. GET-driven, so the server recomputes the list.
 */
export function OrderPayoutFilters({
  vendors,
  restaurantId,
}: Readonly<{
  vendors: { id: string; name: string }[];
  restaurantId: string;
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
    if (patch.vendor !== undefined) {
      usp.delete("state");
      usp.delete("from");
      usp.delete("to");
    }
    start(() => router.push(`/admin/settlements/orders?${usp.toString()}`));
  };

  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium text-ink">Shop</span>
      <select
        className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-ink"
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
  );
}

/** The order list's date filter, closed until someone wants it. */
export function OrderDateFilter({
  fromDate,
  toDate,
}: Readonly<{ fromDate: string; toDate: string }>) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const navigate = (patch: Record<string, string>) => {
    const usp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) usp.set(k, v);
      else usp.delete(k);
    }
    start(() => router.push(`/admin/settlements/orders?${usp.toString()}`));
  };

  return (
    <details className="group" open={Boolean(fromDate || toDate)}>
      <summary className="press flex min-h-10 cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-muted">
        Find orders by date
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 grid gap-3 @3xl:grid-cols-2">
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
    </details>
  );
}
