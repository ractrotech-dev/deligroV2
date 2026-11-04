"use client";

import { useState, useTransition } from "react";
import { LoaderCircle, Ban, ArrowRight, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cancelOrderAsAdmin,
  overrideOrderStatus,
} from "@/app/admin/orders/actions";
import { ADMIN_STAGE_MOVES as STAGES } from "@/components/admin/order-stage-select";

const TERMINAL = new Set(["delivered", "cancelled"]);

/** The server wants the same (cancelOrderAsAdmin, ops_cancel_order). */
const MIN_REASON = 3;

/**
 * Admin intervention on a single order: force a stage, or cancel it.
 *
 * Both controls confirm before firing, because an override rewrites what the
 * customer's tracker says and a cancel ends the order. The move uses `confirm()`;
 * the cancel gets an inline panel, because it needs a written reason.
 */
export function OrderIntervention({
  orderId,
  dbStatus,
}: Readonly<{
  orderId: string;
  dbStatus: string;
}>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [reason, setReason] = useState("");
  const reasonOk = reason.trim().length >= MIN_REASON;

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
      const result = await cancelOrderAsAdmin(orderId, reason.trim());
      if (!result.ok) setError(result.error ?? "Failed");
      else {
        setConfirmingCancel(false);
        setReason("");
        setNotice("Cancelled. The customer and the shop were told.");
      }
    });
  };

  if (finished) {
    return (
      <p className="text-[13.5px] text-muted">
        This order is {dbStatus === "delivered" ? "delivered" : "cancelled"}, so
        it can no longer be changed.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={pending}
          className="h-9 w-48 rounded-lg border border-line bg-surface px-2.5 text-[13.5px] font-medium text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
          aria-label="Move this order to"
        >
          <option value="">Choose a stage</option>
          {STAGES.filter(
            // `ready` reads as Preparing, so "Preparing" would look like a no-op.
            (s) => s.value !== dbStatus && !(dbStatus === "ready" && s.value === "kitchen")
          ).map((s) => (
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
        {confirmingCancel ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmingCancel(true)}
            disabled={pending}
            className="border-deal/40 text-deal hover:bg-deal-soft @5xl:ml-auto"
          >
            <Ban className="size-4" /> Cancel order
          </Button>
        )}
      </div>

      {confirmingCancel ? (
        <div className="border-l-2 border-deal pl-3">
          <p className="flex items-start gap-2 text-[13.5px] font-medium text-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-deal" />
            <span>
              Cancel this order? The customer and the shop are both told.
            </span>
          </p>
          <label htmlFor="cancel-reason" className="mt-3 block text-[12px] font-semibold text-muted">
            Reason (required)
          </label>
          <textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={pending}
            maxLength={200}
            rows={2}
            placeholder="Why is this order being cancelled?"
            className="mt-1 w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-[13.5px] text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
          />
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={cancel}
              disabled={pending || !reasonOk}
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
      ) : null}

      {error ? <p className="text-[13.5px] font-medium text-deal">{error}</p> : null}
      {notice ? <p className="text-[13.5px] font-medium text-muted">{notice}</p> : null}
    </div>
  );
}
