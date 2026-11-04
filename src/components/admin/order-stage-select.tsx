"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import {
  cancelOrderAsAdmin,
  overrideOrderStatus,
} from "@/app/admin/orders/actions";

/**
 * The stages an admin can force, in flow order. Cancel is not one of them: it
 * needs a written reason and tells the shop, so it goes through its own action.
 * Shared with `OrderIntervention` so both offer the same moves.
 */
export const ADMIN_STAGE_MOVES: { value: string; label: string }[] = [
  { value: "placed", label: "Order placed" },
  { value: "kitchen", label: "Preparing" },
  { value: "on_the_way", label: "Picked up" },
  { value: "delivered", label: "Delivered" },
];

/** Labels for the stage an order is in now, including `ready`, which reads as Preparing. */
const CURRENT_LABEL: Record<string, string> = {
  placed: "Order placed",
  kitchen: "Preparing",
  ready: "Preparing",
  on_the_way: "Picked up",
};

const CANCEL = "__cancel";

/**
 * The Stage cell of a live order on Admin → Orders: the stage it is in, as a
 * dropdown that moves it.
 *
 * Same two server actions as the order's intervention panel, and the same rule
 * that nothing fires on a single mis-tap: a move confirms first, and a cancel asks
 * for its reason, which the server requires.
 *
 * Only rendered for in-flight orders. The server refuses to move a delivered or
 * cancelled order anyway; this just does not offer it.
 */
export function OrderStageSelect({
  orderId,
  dbStatus,
}: Readonly<{
  orderId: string;
  /** The database status: placed, kitchen, ready or on_the_way. */
  dbStatus: string;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // `ready` and `kitchen` both read as Preparing; offering "Preparing" to an
  // order that already says Preparing would look like a no-op.
  const moves = ADMIN_STAGE_MOVES.filter(
    (s) => s.value !== dbStatus && !(dbStatus === "ready" && s.value === "kitchen")
  );

  const choose = (target: string) => {
    if (!target || target === dbStatus) return;
    setError(null);

    if (target === CANCEL) {
      const reason = prompt("Why is this order being cancelled? The customer and the shop are told.");
      if (reason === null) return;
      startTransition(async () => {
        const result = await cancelOrderAsAdmin(orderId, reason);
        if (!result.ok) setError(result.error ?? "Could not cancel");
        else router.refresh();
      });
      return;
    }

    const label = ADMIN_STAGE_MOVES.find((s) => s.value === target)?.label ?? target;
    if (!confirm(`Move this order to "${label}"? The customer is told.`)) return;
    startTransition(async () => {
      const result = await overrideOrderStatus(orderId, target);
      if (!result.ok) setError(result.error ?? "Could not move");
      else router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5">
        <select
          // Controlled by the server's answer: a dismissed prompt or a refused
          // move leaves the order's real stage showing, and a successful one
          // arrives with the refresh.
          value={dbStatus}
          onChange={(e) => choose(e.target.value)}
          disabled={pending}
          aria-label="Change this order's stage"
          className="h-8 max-w-[132px] rounded-md border border-line bg-surface px-2 text-[12.5px] font-medium text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
        >
          <option value={dbStatus} disabled>
            {CURRENT_LABEL[dbStatus] ?? dbStatus}
          </option>
          {moves.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
          <option value={CANCEL}>Cancel order…</option>
        </select>
        {pending ? <LoaderCircle className="size-3.5 animate-spin text-muted" aria-hidden /> : null}
      </span>
      {error ? (
        <span role="alert" className="max-w-[160px] text-[11.5px] font-medium text-deal">
          {error}
        </span>
      ) : null}
    </span>
  );
}
