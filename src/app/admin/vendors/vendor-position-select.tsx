"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Star } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { setVendorPositionAction } from "./actions";

/**
 * Compact per-vendor rank control on the admin list. Pick a slot 1–10 to pin the
 * shop to the top of the customer feed in that order, or "Rank" to unpin. The
 * change hits the server action and refreshes so the list (and the customer
 * feed, revalidated by the action) reflect it.
 *
 * A slot holds one shop: picking an occupied one evicts its current holder. The
 * whole board is at /admin/vendors/slots, which is the screen for arranging the
 * ten together — this one is the shortcut for the row already under the cursor.
 */
export function VendorPositionSelect({
  id,
  position,
}: Readonly<{
  id: string;
  position: number | null;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const onChange = (value: string) => {
    const next = value === "" ? null : Number(value);
    start(async () => {
      const res = await setVendorPositionAction(id, next);
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });
  };

  const pinned = position != null;

  return (
    <label
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-bold",
        pinned
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-line text-muted"
      )}
      title="Featured position in the customer feed (1 = first)"
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Star className={cn("size-3", pinned && "fill-current")} />
      )}
      <select
        value={position ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={pending}
        aria-label="Featured position"
        className="cursor-pointer bg-transparent pr-0.5 outline-none"
      >
        <option value="">Rank</option>
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            #{n}
          </option>
        ))}
      </select>
    </label>
  );
}
