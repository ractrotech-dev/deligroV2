"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { approveRestaurantAction } from "@/app/admin/actions";
import { cn } from "@/lib/utils/cn";

/**
 * Approves for real: flips restaurants.approved, which puts the shop on the feed.
 *
 * Two sizes, one implementation. `compact` is the console's inline row action —
 * an outlined chip that inverts on hover — used wherever the approval queue is
 * a list inside a card rather than the subject of the screen.
 */
export function ApproveRestaurantButton({
  id,
  name,
  variant = "default",
}: Readonly<{
  id: string;
  name: string;
  variant?: "default" | "compact";
}>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("Documents and shop details checked");

  // Approving puts the shop live; the reason is recorded on it and in the audit log (0145).
  const approve = () =>
    startTransition(async () => {
      const result = await approveRestaurantAction(id, reason);
      if (result.ok) setAsking(false);
      else setError(result.error ?? "Failed");
    });

  const dialog = (
    <ConfirmDialog
      open={asking}
      title={`Approve ${name}?`}
      message={
        <>
          The shop goes live on the customer feed.{" "}
          <label className="mt-3 block text-xs font-semibold text-ink">
            Reason (recorded){" "}
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={300}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm font-normal text-ink"
            />
          </label>
          {error ? <span className="mt-1 block text-[11px] font-semibold text-deal">{error}</span> : null}
        </>
      }
      confirmLabel="Approve"
      busy={pending}
      onConfirm={approve}
      onClose={() => setAsking(false)}
    />
  );

  if (variant === "compact") {
    return (
      <div className="flex items-center gap-2">
        {error ? (
          <span className="text-[11px] font-semibold text-deal">{error}</span>
        ) : null}
        <button
          type="button"
          disabled={pending}
          aria-label={`Approve ${name}`}
          onClick={() => setAsking(true)}
          className={cn("c-btn-affirm press inline-flex items-center gap-1", pending && "opacity-60")}
        >
          {pending ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" strokeWidth={2.6} />
          )}
          Approve
        </button>
        {dialog}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error ? <span className="text-xs text-deal">{error}</span> : null}
      <Button size="sm" disabled={pending} aria-label={`Approve ${name}`} onClick={() => setAsking(true)}>
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Check className="size-4" />
        )}
        Approve
      </Button>
      {dialog}
    </div>
  );
}
