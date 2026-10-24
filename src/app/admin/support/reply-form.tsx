"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import { Field, fieldCls } from "@/components/ui/field";
import { Panel } from "@/components/admin/console";
import { assignTicketAction, replyTicketAction, setTicketStatusAction, type DeskResult } from "./actions";

/**
 * Reply to the requester (pushed to them as `support`), or leave an internal
 * note (staff only — the requester never sees it), optionally moving the
 * status on. Below it: take the ticket, resolve it, close it.
 *
 * Tokens only; sized against its container.
 */
export function TicketReplyForm({
  id,
  status,
  assignedToYou,
  requesterLabel,
}: Readonly<{ id: string; status: string; assignedToYou: boolean; requesterLabel: string }>) {
  // One bound action per ticket: a fresh `bind` every render hands
  // useActionState a new action each time, which re-renders without end.
  const reply = useMemo(() => replyTicketAction.bind(null, id), [id]);
  const [state, action, sending] = useActionState(reply, null);
  const [internal, setInternal] = useState(false);
  const [quick, setQuick] = useState<DeskResult | null>(null);
  const [moving, start] = useTransition();
  const [resolution, setResolution] = useState("");
  const run = (fn: () => Promise<DeskResult>) => start(async () => setQuick(await fn()));
  const result = quick ?? state;
  const resolved = status === "resolved";
  const closed = status === "closed";

  return (
    <Panel
      title={internal ? "Internal note" : "Reply"}
      description={
        internal
          ? "Seen by Deligro staff only. Nobody is notified."
          : `Sent to ${requesterLabel} in their app, with a notification.`
      }
    >
      <form action={action} className="space-y-3" onSubmit={() => setQuick(null)}>
        <Field label={internal ? "Note" : "Message"}>
          <textarea name="body" rows={4} maxLength={4000} required className={fieldCls} placeholder={internal ? "What staff should know…" : "Write your reply…"} />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-h-9 items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" name="internal" checked={internal} onChange={(e) => setInternal(e.target.checked)} />{" "}
            Internal note
          </label>
          <Field label="Then set status">
            <select name="status" defaultValue="" className={`${fieldCls} w-auto`}>
              <option value="">{internal ? "Leave as it is" : "Waiting on them (default)"}</option>
              <option value="in_progress">In progress</option>
              <option value="escalated">Escalated</option>
              <option value="resolved">Resolved (this message is the resolution)</option>
            </select>
          </Field>
          <Field label="Resolution (when resolving)">
            <input name="resolution" maxLength={1000} className={`${fieldCls} w-auto min-w-40`} placeholder="Needed for a note" />
          </Field>
          <button type="submit" disabled={sending} className="c-btn c-btn-dark press">
            {sending ? "Sending…" : internal ? "Save note" : "Send reply"}
          </button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
        {!assignedToYou ? (
          <button type="button" disabled={moving} onClick={() => run(() => assignTicketAction(id))} className="c-btn c-btn-outline press">
            Assign to me
          </button>
        ) : null}
        {!resolved && !closed ? (
          <>
            <input
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              maxLength={1000}
              placeholder="What resolved it?"
              aria-label="What resolved it"
              className={`${fieldCls} w-auto min-w-48 flex-1`}
            />
            <button
              type="button"
              disabled={moving || resolution.trim().length < 3}
              onClick={() => run(() => setTicketStatusAction(id, "resolved", resolution))}
              className="c-btn-affirm press"
            >
              Mark resolved
            </button>
          </>
        ) : null}
        {resolved ? (
          <>
            <button type="button" disabled={moving} onClick={() => run(() => setTicketStatusAction(id, "open"))} className="c-btn c-btn-outline press">
              Reopen
            </button>
            <button type="button" disabled={moving} onClick={() => run(() => setTicketStatusAction(id, "closed"))} className="c-btn-quiet press">
              Close
            </button>
          </>
        ) : null}
      </div>

      {result ? (
        <p
          role={result.ok ? "status" : "alert"}
          className={`mt-3 rounded-lg border px-3 py-2 text-[12.5px] font-medium ${
            result.ok ? "border-green/30 bg-green-soft text-green" : "border-deal/30 bg-deal-soft text-deal"
          }`}
        >
          {result.ok ? (result.message ?? "Saved.") : result.error}
        </p>
      ) : null}
    </Panel>
  );
}
