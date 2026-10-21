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
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  // The reason is recorded on the shop and in the audit log (0145).
  const reject = () =>
    start(async () => {
      const res = await rejectVendorAction(id, reason);
      if (res.ok) {
        setConfirm(false);
        setReason("");
      }
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
            <label className="mt-3 block text-xs font-semibold text-ink">
              Reason (recorded)
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={300}
                placeholder="e.g. FSSAI licence missing"
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm font-normal text-ink"
              />
            </label>
            {error ? <span className="mt-1 block text-[11px] font-semibold text-deal">{error}</span> : null}
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
