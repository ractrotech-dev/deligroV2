"use client";

import { useState, useTransition } from "react";
import { LoaderCircle, Ban, ArrowRight, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cancelOrderAsAdmin,
  overrideOrderStatus,
} from "@/app/admin/orders/actions";

/** The stages an admin can force, in flow order. Cancel is its own control. */
const STAGES: { value: string; label: string }[] = [
  { value: "placed", label: "Placed" },
  { value: "kitchen", label: "Preparing" },
  { value: "ready", label: "Ready for pickup" },
  { value: "on_the_way", label: "On the way" },
  { value: "delivered", label: "Delivered" },
];

const TERMINAL = new Set(["delivered", "cancelled"]);

/**
 * Admin intervention on a single order: force a stage, or cancel it.
 */
export function OrderIntervention({
  orderId,
  dbStatus,
  refundable,
}: Readonly<{
  orderId: string;
  dbStatus: string;
  /** True when a cancel would queue money back — a paid, online order. */
  refundable: boolean;
}>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const finished = TERMINAL.has(dbStatus);

  const move = () => {
    if (!target) return;
    const label = STAGES.find((s) => s.value === target)?.label ?? target;
    if (!confirm(`Move this order to "${label}"? The customer is told.`)) return;
    startTransition(async () => {
      setError(null);
      setNotice(null);
      const result = await overrideOrderStatus(orderId, target);
      if (!result.ok) setError(result.error ?? "Failed");
      else {
        setNotice(`Moved to ${label}.`);
        setTarget("");
      }
    });
  };

  const cancel = () => {
    startTransition(async () => {
      setError(null);
      setNotice(null);
      const result = await cancelOrderAsAdmin(orderId);
      setConfirmingCancel(false);
      if (!result.ok) setError(result.error ?? "Failed");
      else {
        setNotice(
          result.refundQueued
            ? "Cancelled. A refund is queued in /admin/refunds."
            : "Cancelled. Nothing was paid, so no refund was queued."
        );
      }
    });
  };

  if (finished) {
    return (
      <p className="text-sm text-muted">
        This order is {dbStatus === "delivered" ? "delivered" : "cancelled"} and
        can no longer be changed from here.
        {dbStatus === "delivered"
          ? " Money is refunded from /admin/refunds."
          : null}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={pending}
          className="min-w-0 flex-1 rounded-[var(--c-r)] border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink disabled:opacity-60"
          aria-label="Move this order to"
        >
          <option value="">Move to…</option>
          {STAGES.filter((s) => s.value !== dbStatus).map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="secondary"
          onClick={move}
          disabled={pending || !target}
        >
          {pending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <ArrowRight className="size-4" />
          )}
          Move
        </Button>
      </div>

      {confirmingCancel ? (
        <div className="rounded-[var(--c-r)] border border-pop/40 bg-pop/10 p-3">
          <p className="flex items-start gap-2 text-sm font-medium text-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              Cancel this order?{" "}
              {refundable
                ? "It was paid online, so a refund will be queued for approval."
                : "Nothing was paid online, so no refund is queued — any cash is settled by hand."}{" "}
              The customer and the restaurant are both told.
            </span>
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={cancel}
              disabled={pending}
              className="border-deal/40 text-deal hover:bg-deal-soft"
            >
              {pending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Ban className="size-4" />
              )}
              Yes, cancel it
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirmingCancel(false)}
              disabled={pending}
            >
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setConfirmingCancel(true)}
          disabled={pending}
          className="w-full"
        >
          <Ban className="size-4" /> Cancel this order
        </Button>
      )}

      {error ? <p className="text-sm font-medium text-deal">{error}</p> : null}
      {notice ? <p className="text-sm font-medium text-muted">{notice}</p> : null}
    </div>
  );
}
