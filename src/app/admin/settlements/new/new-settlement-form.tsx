"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { DatePicker } from "@/components/ui/date-picker";

/**
 * GET-driven filters: changing the shop or dates navigates so the server can
 * recompute what is shown. Creating the payment is a separate button below.
 */
export function NewSettlementForm({
  vendors,
  restaurantId,
  fromDate,
  toDate,
  cycleNote = null,
}: Readonly<{
  vendors: { id: string; name: string }[];
  restaurantId: string;
  fromDate: string;
  toDate: string;
  /** Which cycle this shop is on, and what the pre-filled dates mean. */
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
    // Changing the shop deliberately drops the dates: the next shop may be on a
    // different cycle, and carrying over a weekly range onto a monthly shop is
    // exactly the mis-typed period the cycle exists to prevent. The server then
    // re-derives the default for whoever was picked.
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
    <div className="space-y-2">
      <div className="grid grid-cols-[2fr_1fr_1fr] items-end gap-3">
        <label className="block space-y-1 text-[12.5px]">
          <span className="font-medium text-muted">Shop</span>
          <select
            className="h-9 w-full rounded-[var(--c-r)] border border-line bg-surface px-2.5 text-[13px] text-ink"
            value={restaurantId}
            disabled={pending}
            onChange={(e) => navigate({ restaurantId: e.target.value })}
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
          <span className="font-medium text-muted">From</span>
          <DatePicker
            value={fromDate}
            disabled={pending}
            onChange={(v) => navigate({ from: v })}
          />
        </label>
        <label className="block space-y-1 text-[12.5px]">
          <span className="font-medium text-muted">To</span>
          <DatePicker
            value={toDate}
            disabled={pending}
            onChange={(v) => navigate({ to: v })}
          />
        </label>
      </div>
      {cycleNote ? <p className="text-[12.5px] text-muted">{cycleNote}</p> : null}
    </div>
  );
}
