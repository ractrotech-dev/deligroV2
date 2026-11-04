"use client";

import { useActionState } from "react";
import { fieldCls } from "@/components/ui/field";
import { decideMarketingAction } from "@/app/admin/growth-actions";
import { marketingMoves, type MarketingStatus } from "@/lib/vendor/growth-input";

/** The words for each move. Which moves show is the server's own table. */
const LABEL: Partial<Record<MarketingStatus, string>> = {
  approved: "Approve request",
  in_progress: "Start work",
  completed: "Mark complete",
  rejected: "Reject",
};

/** The next steps a request can take, with optional remarks (required to reject). */
export function MarketingDecisionForm({ id, status }: Readonly<{ id: string; status: MarketingStatus }>) {
  const [state, action, pending] = useActionState(decideMarketingAction.bind(null, id), null);
  const steps = marketingMoves(status);
  if (steps.length === 0) return null;
  const canReject = steps.includes("rejected");
  return (
    <form action={action} className="space-y-2 border-t border-line pt-3">
      <textarea name="remarks" rows={2} maxLength={1000} placeholder={canReject ? "Note for the shop (needed to reject)" : "Note for the shop"} className={fieldCls} />
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((s) => (
          <button
            key={s}
            type="submit"
            name="status"
            value={s}
            disabled={pending}
            className={`c-btn ${s === "rejected" ? "c-btn-outline" : "c-btn-dark"}`}
          >
            {LABEL[s] ?? s}
          </button>
        ))}
        {state ? (
          <span role="status" className={`text-[13px] ${state.ok ? "text-green" : "text-deal"}`}>
            {state.ok ? state.message : state.error}
          </span>
        ) : null}
      </div>
      {steps.includes("approved") ? (
        <p className="text-[12px] text-muted">
          Approving only records your answer. It does not create a campaign.
        </p>
      ) : null}
    </form>
  );
}
