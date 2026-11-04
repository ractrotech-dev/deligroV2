"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalToShell } from "@/components/shared/portal-to-shell";
import { cn } from "@/lib/utils/cn";

/**
 * Matches `orders_cancellation_reason_check` (0051). The counter below exists
 * so the limit is visible rather than discovered by having text vanish.
 */
const MAX = 200;

/**
 * The sentences a kitchen actually says, so the common case is one tap.
 *
 * Written from the customer's side of the conversation, because that is who
 * reads them: this text goes onto the order verbatim and appears on the
 * customer's screen under "Cancelled". "Out of stock" is a note to yourself;
 * "One of the items is out of stock" is an answer.
 */
const PRESETS = [
  "We're too busy to take this order right now",
  "One of the items is out of stock",
  "The kitchen is closed or closing shortly",
  "We can't deliver to that address",
];

/**
 * Why this order is being rejected.
 *
 * It replaces a `window.confirm` that asked "Reject order X?" and threw the
 * answer away. A customer looking at a list of cancellations with no
 * explanation concludes the app is broken — often after several in a row — and
 * the only person who ever knew the reason was the one tapping this button.
 *
 * The reason is optional, deliberately. A kitchen in the middle of a rush must
 * be able to reject an order in one tap, and a required field here would be
 * answered with "." within a week.
 */
export function RejectOrderDialog({
  code,
  busy,
  onCancel,
  onConfirm,
}: {
  /** The short order code, so the dialog names what it is about to do. */
  code: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string | undefined) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const custom = picked === null && note.trim().length > 0;
  const reason = custom ? note.trim().slice(0, MAX) : (picked ?? undefined);

  return (
    <PortalToShell>
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center sm:p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reject-order-title"
          className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-2xl bg-surface shadow-[var(--shadow-lg)] sm:rounded-2xl"
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <h2 id="reject-order-title" className="text-lg font-bold">
                Reject order {code}?
              </h2>
              <p className="text-xs text-muted">
                This can&apos;t be undone. Deligro will contact the customer.
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="press grid size-9 shrink-0 place-items-center rounded-full border border-line text-muted"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
            <p className="text-sm font-semibold">
              Tell the customer why
              <span className="ml-1.5 font-normal text-muted">Optional</span>
            </p>

            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setPicked(picked === p ? null : p);
                  setNote("");
                }}
                aria-pressed={picked === p}
                className={cn(
                  "press block w-full rounded-xl border px-3 py-2.5 text-left text-sm",
                  picked === p
                    ? "border-accent bg-accent/10 font-semibold text-ink"
                    : "border-line bg-surface-2 text-muted"
                )}
              >
                {p}
              </button>
            ))}

            <textarea
              value={note}
              onChange={(e) => {
                setNote(e.target.value.slice(0, MAX));
                setPicked(null);
              }}
              rows={2}
              placeholder="Or write your own…"
              className={cn(
                "w-full rounded-xl border bg-surface-2 px-3 py-2.5 text-sm outline-none placeholder:text-muted",
                custom ? "border-accent" : "border-line"
              )}
            />
            <p className="text-right text-[11px] text-muted">
              {note.length}/{MAX}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-line px-4 py-3">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={busy}
            >
              Keep order
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => onConfirm(reason)}
              className="bg-deal text-[var(--on-deal)] shadow-none hover:brightness-[1.03]"
            >
              {busy ? "Working…" : "Reject"}
            </Button>
          </div>
        </div>
      </div>
    </PortalToShell>
  );
}
