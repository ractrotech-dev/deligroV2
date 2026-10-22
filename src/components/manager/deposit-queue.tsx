"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldCls } from "@/components/ui/field";
import { cn } from "@/lib/utils/cn";
import { formatINR } from "@/lib/utils/format";
import { formatIst } from "@/lib/utils/ist-time";
import {
  decideDepositAction,
  resolveCashDisputeAction,
  type CashActionResult,
  type DepositActionResult,
} from "@/app/manager/cash/actions";
import type { CashDisputeListing, QueuedDeposit } from "@/lib/data-access/rider-cash";

type Decide = (input: { id: string; decision: "confirm" | "dispute"; note?: string }) => Promise<DepositActionResult>;

/** The refusal 0152 gives, shown on the card before the manager even tries. */
const manualHandoverText = (day: string) =>
  `A handover for this rider on ${day} was already recorded by hand — check the cash ledger.`;

/**
 * Rider cash deposits waiting for a decision (oldest first), and the cash
 * disputes riders raised. Tokens only and no viewport breakpoints: both the
 * phone frame and the console put this in a column of their own width.
 *
 * Confirming writes the one `cod_handovers` row on the server, dated to the day
 * the rider declared the deposit. When a handover for that rider and day was
 * already recorded by hand the card says so, confirming is not offered and the
 * deposit can only be disputed — the same cash is never counted twice.
 */
export function DepositQueue({
  items,
  decide = decideDepositAction,
}: Readonly<{
  items: QueuedDeposit[];
  /** The server action; replaced only by the QA fixture page. */
  decide?: Decide;
}>) {
  return (
    <section className="mt-7" aria-labelledby="deposit-queue-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="deposit-queue-title" className="text-sm font-bold text-ink">
          Rider deposits to confirm
        </h2>
        {items.length > 0 ? <span className="text-data text-xs font-semibold text-muted">{items.length} waiting</span> : null}
      </div>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No deposits waiting. Riders declare them from the app.</p>
      ) : (
        <ul className="mt-2 space-y-2.5">
          {items.map((item) => (
            <DepositCard key={item.id} item={item} decide={decide} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DepositCard({ item, decide }: Readonly<{ item: QueuedDeposit; decide: Decide }>) {
  const [mode, setMode] = useState<"idle" | "dispute">("idle");
  const [blockedDay, setBlockedDay] = useState<string | null>(item.manualHandoverOnDay > 0 ? item.depositDay : null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { what: "confirmed" | "disputed"; warning?: string }>(null);
  const [pending, start] = useTransition();

  const run = (decision: "confirm" | "dispute") => {
    setError(null);
    start(async () => {
      const result = await decide({ id: item.id, decision, note: decision === "dispute" ? note : undefined });
      if (result.ok) {
        setDone({ what: decision === "confirm" ? "confirmed" : "disputed", warning: result.warning });
        return;
      }
      if (result.day) {
        // 0152's refusal: nothing was written; the manager can dispute instead.
        setBlockedDay(result.day);
        return;
      }
      setError(result.error ?? "That didn't save. Try again.");
    });
  };

  if (done) {
    return (
      <li className="rounded-xl border border-line bg-surface p-3 text-[13px]">
        <p className="flex items-center gap-1.5 font-medium text-green">
          <Check className="size-3.5" />
          {formatINR(item.amount)} from {item.riderName} {done.what}.
        </p>
        {done.warning ? <p className="mt-1.5 text-[12px] font-medium text-ink">{done.warning}</p> : null}
      </li>
    );
  }

  return (
    <li className="rounded-xl border border-line bg-surface p-3 text-[13px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{item.riderName}</p>
          <p className="text-data text-[11.5px] text-muted">{item.riderCode ?? "No rider ID yet"}</p>
        </div>
        <p className="text-data text-[17px] font-extrabold leading-none text-ink">{formatINR(item.amount)}</p>
      </div>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
        <dt className="text-muted">Method</dt>
        <dd className="text-ink">{item.method === "upi" ? "UPI" : "Cash"}</dd>
        {item.reference ? (
          <>
            <dt className="text-muted">Reference</dt>
            <dd className="text-data break-all text-ink">{item.reference}</dd>
          </>
        ) : null}
        {item.managerName ? (
          <>
            <dt className="text-muted">Handed to</dt>
            <dd className="text-ink">{item.managerName}</dd>
          </>
        ) : null}
        <dt className="text-muted">Declared</dt>
        <dd className="text-ink">
          {formatIst(item.createdAt, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
        </dd>
        {item.note ? (
          <>
            <dt className="text-muted">Note</dt>
            <dd className="text-ink">{item.note}</dd>
          </>
        ) : null}
      </dl>

      {item.receiptUrl ? (
        <a
          href={item.receiptUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block"
          aria-label={`Open the receipt photo from ${item.riderName}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL, not a static asset */}
          <img
            src={item.receiptUrl}
            alt={`Receipt from ${item.riderName}`}
            width={64}
            height={64}
            loading="lazy"
            className="size-16 rounded-lg border border-line object-cover"
          />
        </a>
      ) : null}

      {blockedDay ? (
        <p role="status" className="mt-2 rounded-lg border border-pop/40 bg-pop/10 px-2.5 py-1.5 text-[12px] font-medium text-ink">
          {manualHandoverText(blockedDay)}
        </p>
      ) : null}

      {error ? <p className="mt-2 text-xs font-medium text-deal">{error}</p> : null}

      {mode === "dispute" ? (
        <div className="mt-2.5 space-y-2">
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-muted">Why? The rider reads this.</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder="e.g. Only ₹400 reached me"
              className={cn(fieldCls, "resize-none")}
            />
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={pending}
              onClick={() => {
                setMode("idle");
                setError(null);
              }}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              className="flex-1"
              disabled={pending || note.trim().length < 3}
              onClick={() => run("dispute")}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Send dispute
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <Button type="button" size="sm" variant="outline" className="flex-1" disabled={pending} onClick={() => setMode("dispute")}>
            Dispute
          </Button>
          <Button type="button" size="sm" className="flex-1" disabled={pending || blockedDay !== null} onClick={() => run("confirm")}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Confirm
          </Button>
        </div>
      )}
    </li>
  );
}

/** Cash disputes riders raised: open first. Resolving writes what was decided. */
export function CashDisputeList({
  items,
  resolve = resolveCashDisputeAction,
}: Readonly<{
  items: CashDisputeListing[];
  resolve?: (input: { id: string; resolution: string }) => Promise<CashActionResult>;
}>) {
  return (
    <section className="mt-7" aria-labelledby="cash-disputes-title">
      <h2 id="cash-disputes-title" className="text-sm font-bold text-ink">
        Rider cash disputes
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No disputes raised.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map((d) => (
            <DisputeCard key={d.id} dispute={d} resolve={resolve} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DisputeCard({
  dispute,
  resolve,
}: Readonly<{ dispute: CashDisputeListing; resolve: NonNullable<Parameters<typeof CashDisputeList>[0]["resolve"]> }>) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const status = resolved ? "resolved" : dispute.status;
  const resolution = resolved ?? dispute.resolution;

  return (
    <li className="rounded-xl border border-line bg-surface p-3 text-[13px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{dispute.riderName}</p>
          <p className="text-data text-[11.5px] text-muted">{dispute.day}</p>
        </div>
        <span className={cn("text-xs font-semibold", status === "open" ? "text-deal" : "text-green")}>
          {status === "open" ? "Open" : "Resolved"}
        </span>
      </div>
      <p className="mt-1.5 text-ink">{dispute.message}</p>
      {dispute.claimedAmount !== null ? (
        <p className="mt-0.5 text-[12px] text-muted">
          Rider says <span className="text-data font-semibold text-ink">{formatINR(dispute.claimedAmount)}</span>
        </p>
      ) : null}
      {resolution ? <p className="mt-1.5 text-[12px] text-muted">Decided: {resolution}</p> : null}

      {status === "open" ? (
        open ? (
          <div className="mt-2.5 space-y-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              maxLength={500}
              aria-label="What was decided"
              placeholder="What was decided?"
              className={cn(fieldCls, "resize-none")}
            />
            {error ? <p className="text-xs font-medium text-deal">{error}</p> : null}
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" className="flex-1" disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="flex-1"
                disabled={pending || text.trim() === ""}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await resolve({ id: dispute.id, resolution: text });
                    if (result.ok) setResolved(text.trim());
                    else setError(result.error ?? "That didn't save. Try again.");
                  })
                }
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Resolve
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" size="sm" variant="outline" className="mt-2.5 w-full" onClick={() => setOpen(true)}>
            Resolve
          </Button>
        )
      ) : null}
    </li>
  );
}
