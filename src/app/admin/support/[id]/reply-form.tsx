"use client";

import { useActionState, useTransition } from "react";
import { fieldCls } from "@/components/ui/field";
import { replyTicketAction, setTicketStatusAction } from "@/app/admin/growth-actions";
import type { TicketStatus } from "@/lib/vendor/growth-input";

/** Reply (or internal note), with an optional status change, and quick resolve / close. */
export function TicketReplyForm({ id, status }: Readonly<{ id: string; status: TicketStatus }>) {
  const [state, action, pending] = useActionState(replyTicketAction.bind(null, id), null);
  const [moving, startMove] = useTransition();
  return (
    <form action={action} className="card mt-4 space-y-3 p-4">
      <textarea name="body" rows={4} maxLength={4000} required placeholder="Write a reply…" className={fieldCls} />
      <div className="flex flex-wrap items-center gap-3 text-[14px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="internal" /> Internal note (the shop never sees it)
        </label>
        <select name="status" defaultValue="" className={`${fieldCls} w-auto`}>
          <option value="">Status: waiting on them (default for a reply)</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
        <button disabled={pending} className="c-btn c-btn-dark press">
          {pending ? "Sending…" : "Send"}
        </button>
        {status !== "resolved" && status !== "closed" ? (
          <button
            type="button"
            disabled={moving}
            onClick={() => startMove(async () => void (await setTicketStatusAction(id, "resolved")))}
            className="c-btn press"
          >
            Mark resolved
          </button>
        ) : null}
        {state ? (
          <span role="status" className={state.ok ? "text-green" : "text-deal"}>
            {state.ok ? state.message : state.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
