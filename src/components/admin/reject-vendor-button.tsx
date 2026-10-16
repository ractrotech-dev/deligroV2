"use client";

import { useState, useTransition } from "react";
import { LoaderCircle, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { rejectVendorAction } from "@/app/admin/vendors/actions";
import { cn } from "@/lib/utils/cn";

/**
 * The other half of the approval decision: decline a signup.
 *
 * Approve was the only verb on the queue, so the honest way to say no was to
 * leave the card sitting there — which is how a queue of six becomes a queue of
 * twenty with a median wait measured in months. Rejecting suspends the shop, so
 * it leaves the queue and the nav badge without being erased; the confirm names
 * what happens next in the same sentence, because "reject" reads as "delete" to
 * an operator who has never seen the vendor's row afterwards.
 */
export function RejectVendorButton({ id, name }: Readonly<{ id: string; name: string }>) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reject = () =>
    start(async () => {
      const res = await rejectVendorAction(id);
      setConfirm(false);
      setError(res.ok ? null : res.error ?? "Couldn't reject this vendor.");
    });

  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-label={`Reject ${name}`}
        onClick={() => setConfirm(true)}
        className={cn(
          "c-btn-deny press inline-flex items-center gap-1",
          pending && "opacity-60"
        )}
      >
        {pending ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <X className="size-3" strokeWidth={2.6} />
        )}
        Reject
      </button>

      {error ? (
        <span className="text-[11px] font-semibold text-deal">{error}</span>
      ) : null}

      <ConfirmDialog
        open={confirm}
        title="Reject this signup?"
        message={
          <>
            <b className="text-ink">{name}</b> is suspended: it leaves this queue
            and never reaches the customer feed. Nothing is deleted — you can
            approve it later from its profile if they sort things out.
          </>
        }
        confirmLabel="Reject"
        danger
        busy={pending}
        onConfirm={reject}
        onClose={() => setConfirm(false)}
      />
    </>
  );
}
