"use client";

import { useState, useTransition } from "react";
import { fieldCls } from "@/components/ui/field";
import { confirmManagerHandoverAction, decideDepositAsOwnerAction, recordCashReceivedAction } from "./actions";

/** Confirm or dispute one waiting rider deposit, inside its table row. */
export function DepositDecision({ depositId }: Readonly<{ depositId: string }>) {
  const [busy, start] = useTransition();
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const send = (decision: "confirm" | "dispute") => {
    setMessage(null);
    start(async () => {
      const r = await decideDepositAsOwnerAction({ depositId, decision, note: decision === "dispute" ? note : undefined });
      if (!r.ok) setMessage(r.error ?? "That didn't go through. Try again.");
      else if (r.warning) setMessage(r.warning);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5 whitespace-normal">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <button type="button" disabled={busy} onClick={() => send("confirm")} className="c-btn-affirm disabled:opacity-50">
          Confirm
        </button>
        <button type="button" disabled={busy} onClick={() => setDisputing(!disputing)} className="c-btn-deny disabled:opacity-50">
          Dispute
        </button>
      </div>
      {disputing ? (
        <div className="w-[220px] space-y-1.5 text-left">
          <label className="block text-[12px] font-medium text-muted">
            What is wrong? The rider reads this.
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className={`${fieldCls} mt-1`}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            disabled={busy || note.trim().length < 3}
            onClick={() => send("dispute")}
            className="c-btn-deny disabled:opacity-50"
          >
            Send dispute
          </button>
        </div>
      ) : null}
      {message ? <p className="max-w-[220px] text-right text-[11.5px] font-medium text-deal">{message}</p> : null}
    </div>
  );
}

/** A manager's own "I gave it to the owner" row, waiting for the owner. */
export function ConfirmHandoverButton({ handoverId }: Readonly<{ handoverId: string }>) {
  const [busy, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-1 whitespace-normal">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          start(async () => {
            setMessage(null);
            const r = await confirmManagerHandoverAction({ handoverId });
            if (!r.ok) setMessage(r.error ?? "That didn't go through. Try again.");
          })
        }
        className="c-btn-affirm disabled:opacity-50"
      >
        Confirm received
      </button>
      {message ? <p className="text-[11.5px] font-medium text-deal">{message}</p> : null}
    </div>
  );
}

type Person = { id: string; name: string };

/** Cash the owner received directly: from whom, how much, and a note. */
export function CashReceivedForm({
  riders,
  managers,
}: Readonly<{ riders: Person[]; managers: Person[] }>) {
  const [busy, start] = useTransition();
  const [kind, setKind] = useState<"rider" | "manager">("rider");
  const [fromUserId, setFromUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [actionId, setActionId] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const people = kind === "rider" ? riders : managers;
  const value = Number(amount);
  const ready = fromUserId !== "" && Number.isInteger(value) && value > 0;

  const save = () => {
    setResult(null);
    start(async () => {
      const r = await recordCashReceivedAction({ kind, fromUserId, amount: value, note, clientActionId: actionId });
      if (!r.ok) {
        setResult({ ok: false, text: r.error ?? "That didn't save. Try again." });
        return;
      }
      setResult({ ok: true, text: "Recorded. You are shown as the person who confirmed it." });
      setFromUserId("");
      setAmount("");
      setNote("");
      setActionId(crypto.randomUUID());
    });
  };

  return (
    <div className="admin-measure space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-[12px] font-medium text-muted">
          From
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value === "manager" ? "manager" : "rider");
              setFromUserId("");
            }}
            className={`${fieldCls} mt-1 w-[120px]`}
            disabled={busy}
          >
            <option value="rider">A rider</option>
            <option value="manager">A manager</option>
          </select>
        </label>
        <label className="block text-[12px] font-medium text-muted">
          Name
          <select
            value={fromUserId}
            onChange={(e) => setFromUserId(e.target.value)}
            className={`${fieldCls} mt-1 w-[220px]`}
            disabled={busy}
          >
            <option value="">Choose…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[12px] font-medium text-muted">
          Amount (₹)
          <input
            type="number"
            min={1}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`${fieldCls} mt-1 w-[120px]`}
            disabled={busy}
          />
        </label>
        <label className="block min-w-[200px] flex-1 text-[12px] font-medium text-muted">
          Note (optional)
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            className={`${fieldCls} mt-1`}
            disabled={busy}
          />
        </label>
        <button type="button" disabled={busy || !ready} onClick={save} className="c-btn-affirm disabled:opacity-50">
          Record cash received
        </button>
      </div>
      {result ? (
        <p role="status" className={`text-[12px] font-medium ${result.ok ? "text-muted" : "text-deal"}`}>
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
