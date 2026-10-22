"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldCls } from "@/components/ui/field";
import { formatINR } from "@/lib/utils/format";
import { decideDepositAction, resolveCashDisputeAction } from "@/app/manager/cash/actions";
import type { CashDeposit, CashDispute } from "@/lib/ops/rider-contract";

/**
 * Cash riders say they handed over (§5.14): confirm it (that records the rider
 * → manager handover) or dispute it with a note the rider reads; and disputes
 * riders raised, closed with what was found. Every decision is audited server
 * side (0152).
 */
export function DepositQueue({ deposits, disputes }: Readonly<{ deposits: CashDeposit[]; disputes: CashDispute[] }>) {
  if (deposits.length === 0 && disputes.length === 0) return null;
  return (
    <section className="mt-6 space-y-3">
      {deposits.length > 0 ? (
        <>
          <h2 className="text-sm font-bold text-ink">Deposits waiting for you</h2>
          <ul className="space-y-2">
            {deposits.map((d) => (
              <DepositRow key={d.id} deposit={d} />
            ))}
          </ul>
        </>
      ) : null}
      {disputes.length > 0 ? (
        <>
          <h2 className="pt-2 text-sm font-bold text-ink">Cash disputes</h2>
          <ul className="space-y-2">
            {disputes.map((d) => (
              <DisputeRow key={d.id} dispute={d} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function DepositRow({ deposit }: Readonly<{ deposit: CashDeposit }>) {
  const [pending, start] = useTransition();
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const decide = (decision: "confirm" | "dispute") =>
    start(async () => {
      setError(null);
      const r = await decideDepositAction({ depositId: deposit.id, decision, note: decision === "dispute" ? note : undefined });
      if (!r.ok) setError(r.error ?? "That didn't go through.");
      // Confirmed, but for more than the rider was recorded as holding: worth
      // a look in the cash ledger. Shown here until the list refreshes.
      else if (r.warning) window.alert(r.warning);
    });
  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[15px] font-bold text-ink">
          {deposit.rider.name}
          {deposit.rider.code ? <span className="ml-1.5 text-xs font-medium text-muted">{deposit.rider.code}</span> : null}
        </p>
        <p className="text-data text-[15px] font-bold text-ink">{formatINR(deposit.amount)}</p>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        {deposit.method === "upi" ? "UPI" : "Cash"}
        {deposit.reference ? ` · ${deposit.reference}` : ""}
        {deposit.note ? ` · ${deposit.note}` : ""}
      </p>
      {disputing ? (
        <div className="mt-2 space-y-2">
          <textarea
            className={fieldCls}
            rows={2}
            value={note}
            maxLength={500}
            placeholder="What is wrong? The rider will read this."
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={() => setDisputing(false)}>
              Back
            </Button>
            <Button type="button" disabled={pending || note.trim().length < 3} onClick={() => decide("dispute")}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Send dispute
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button type="button" disabled={pending} onClick={() => decide("confirm")}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Confirm received
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => setDisputing(true)}>
            Dispute
          </Button>
        </div>
      )}
      {error ? <p className="mt-2 text-xs font-medium text-red-600">{error}</p> : null}
    </li>
  );
}

function DisputeRow({ dispute }: Readonly<{ dispute: CashDispute }>) {
  const [pending, start] = useTransition();
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <p className="text-[15px] font-bold text-ink">
        {dispute.rider.name} · {dispute.day}
        {dispute.claimedAmount !== null ? <span className="text-data ml-1.5">{formatINR(dispute.claimedAmount)}</span> : null}
      </p>
      <p className="mt-0.5 text-sm text-muted">{dispute.message}</p>
      <textarea
        className={`${fieldCls} mt-2`}
        rows={2}
        value={resolution}
        maxLength={500}
        placeholder="What did you find?"
        onChange={(e) => setResolution(e.target.value)}
      />
      <Button
        type="button"
        className="mt-2"
        disabled={pending || resolution.trim().length < 3}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await resolveCashDisputeAction({ disputeId: dispute.id, resolution });
            if (!r.ok) setError(r.error ?? "That didn't go through.");
          })
        }
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Resolve
      </Button>
      {error ? <p className="mt-2 text-xs font-medium text-red-600">{error}</p> : null}
    </li>
  );
}
