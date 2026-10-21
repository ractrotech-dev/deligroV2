"use client";

import { useActionState } from "react";
import { fieldCls } from "@/components/ui/field";
import { decideMarketingAction } from "@/app/admin/growth-actions";
import type { MarketingStatus } from "@/lib/vendor/growth-input";

const NEXT: Record<MarketingStatus, { value: MarketingStatus; label: string }[]> = {
  pending: [
    { value: "approved", label: "Approve" },
    { value: "in_progress", label: "Start work" },
    { value: "rejected", label: "Reject" },
  ],
  approved: [
    { value: "in_progress", label: "Start work" },
    { value: "completed", label: "Mark complete" },
    { value: "rejected", label: "Reject" },
  ],
  in_progress: [
    { value: "completed", label: "Mark complete" },
    { value: "rejected", label: "Reject" },
  ],
  completed: [],
  rejected: [],
  cancelled: [],
};

/** The next steps a request can take, with optional remarks (required to reject). */
export function MarketingDecisionForm({ id, status }: Readonly<{ id: string; status: MarketingStatus }>) {
  const [state, action, pending] = useActionState(decideMarketingAction.bind(null, id), null);
  const steps = NEXT[status];
  if (steps.length === 0) return null;
  return (
    <form action={action} className="space-y-2 border-t border-line pt-3">
      <textarea name="remarks" rows={2} maxLength={1000} placeholder="Remarks for the shop (required to reject)" className={fieldCls} />
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((s) => (
          <button
            key={s.value}
            name="status"
            value={s.value}
            disabled={pending}
            className={`c-btn press ${s.value === "rejected" ? "" : "c-btn-dark"}`}
          >
            {s.label}
          </button>
        ))}
        {state ? (
          <span role="status" className={`text-[13px] ${state.ok ? "text-green" : "text-deal"}`}>
            {state.ok ? state.message : state.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
