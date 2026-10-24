"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, fieldCls } from "@/components/ui/field";
import type { ActionResult } from "@/lib/rider/admin-money";
import {
  decideChangeRequestAction,
  editPayoutAccountAction,
  rejectDocumentAction,
  setVerificationAction,
  verifyDocumentAction,
} from "./profile-actions";

/**
 * The Profile and Documents tabs' forms. They carry ids and the admin's own
 * words only — never a document number or a payout account (those are
 * rendered by the server tabs, not passed here as props).
 *
 * Submitted from an event handler, as the Money tab's forms are: a refusal
 * leaves what the operator typed in place; a success clears it.
 */

function Outcome({ result }: Readonly<{ result: ActionResult | null }>) {
  if (!result) return null;
  return result.ok ? (
    <p role="status" className="rounded-lg border border-green/30 bg-green-soft px-3 py-2 text-[12.5px] font-medium text-green">
      {result.message ?? "Saved."}
    </p>
  ) : (
    <p role="alert" className="rounded-lg border border-deal/30 bg-deal-soft px-3 py-2 text-[12.5px] font-medium text-deal">
      {result.error ?? "That didn't save."}
    </p>
  );
}

type Action = (prev: ActionResult, form: FormData) => Promise<ActionResult>;

/** A form whose submit buttons each name the action they run. */
function useDecisionForm(actions: Record<string, Action>) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, start] = useTransition();
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const key = submitter?.value ?? "";
    const action = actions[key];
    if (!action) return;
    const formEl = e.currentTarget;
    const data = new FormData(formEl);
    data.set("decision", key);
    start(async () => {
      const r = await action({ ok: false }, data);
      setResult(r);
      if (r.ok) formEl.reset();
    });
  }
  return { onSubmit, busy, result };
}

export function DocumentReviewForm({ driverId, documentId }: Readonly<{ driverId: string; documentId: string }>) {
  const f = useDecisionForm({ verify: verifyDocumentAction, reject: rejectDocumentAction });
  return (
    <form onSubmit={f.onSubmit} className="space-y-2">
      <input type="hidden" name="driverId" value={driverId} />
      <input type="hidden" name="documentId" value={documentId} />
      <Field label="Remarks" hint="Needed to reject — the rider reads it.">
        <input name="remarks" maxLength={500} className={fieldCls} placeholder="e.g. The photo is blurred" />
      </Field>
      <Outcome result={f.result} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" value="verify" disabled={f.busy}>
          Verify
        </Button>
        <Button type="submit" size="sm" variant="outline" value="reject" disabled={f.busy}>
          Reject
        </Button>
      </div>
    </form>
  );
}

export function VerificationForm({
  driverId,
  current,
  missing,
}: Readonly<{ driverId: string; current: string; missing: string[] }>) {
  const f = useDecisionForm({ verify: setVerificationAction, reject: setVerificationAction });
  const canReject = current === "unverified" || current === "pending";
  const canVerify = current !== "verified";
  return (
    <form onSubmit={f.onSubmit} className="space-y-2">
      <input type="hidden" name="driverId" value={driverId} />
      <input type="hidden" name="expected" value={current} />
      <Field label="Note" hint="Needed to reject or to override — the rider reads it.">
        <textarea name="note" rows={2} maxLength={300} className={fieldCls} />
      </Field>
      {missing.length > 0 && canVerify ? (
        <label className="flex items-start gap-2 text-[12.5px] text-muted">
          <input type="checkbox" name="override" value="1" className="mt-0.5" />{" "}
          Verify anyway — I have checked the documents another way (say how in the note).
        </label>
      ) : null}
      <Outcome result={f.result} />
      <div className="flex flex-wrap gap-2">
        {canVerify ? (
          <Button type="submit" size="sm" value="verify" disabled={f.busy}>
            Verify rider
          </Button>
        ) : null}
        {canReject ? (
          <Button type="submit" size="sm" variant="outline" value="reject" disabled={f.busy}>
            Reject
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function ChangeDecisionForm({ driverId, requestId }: Readonly<{ driverId: string; requestId: string }>) {
  const f = useDecisionForm({ approve: decideChangeRequestAction, reject: decideChangeRequestAction });
  return (
    <form onSubmit={f.onSubmit} className="space-y-2">
      <input type="hidden" name="driverId" value={driverId} />
      <input type="hidden" name="requestId" value={requestId} />
      <Field label="Note" hint="Needed to reject — the rider reads it.">
        <input name="note" maxLength={300} className={fieldCls} />
      </Field>
      <Outcome result={f.result} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" value="approve" disabled={f.busy}>
          Approve
        </Button>
        <Button type="submit" size="sm" variant="outline" value="reject" disabled={f.busy}>
          Reject
        </Button>
      </div>
    </form>
  );
}

export function PayoutAccountForm({ driverId }: Readonly<{ driverId: string }>) {
  const [kind, setKind] = useState<"bank" | "upi">("bank");
  const f = useDecisionForm({ save: editPayoutAccountAction });
  return (
    <form onSubmit={f.onSubmit} className="space-y-3" autoComplete="off">
      <input type="hidden" name="driverId" value={driverId} />
      <Field label="Type">
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as "bank" | "upi")} className={fieldCls}>
          <option value="bank">Bank account</option>
          <option value="upi">UPI</option>
        </select>
      </Field>
      {kind === "bank" ? (
        <div className="grid gap-3 @lg:grid-cols-2">
          <Field label="Account holder">
            <input name="holderName" required maxLength={100} className={fieldCls} />
          </Field>
          <Field label="IFSC">
            <input name="ifsc" required maxLength={11} className={`${fieldCls} text-data uppercase`} placeholder="HDFC0001234" />
          </Field>
          <Field label="Account number">
            <input name="accountNumber" required inputMode="numeric" maxLength={18} className={`${fieldCls} text-data`} />
          </Field>
          <Field label="Account number again">
            <input name="confirmAccountNumber" required inputMode="numeric" maxLength={18} className={`${fieldCls} text-data`} />
          </Field>
        </div>
      ) : (
        <div className="grid gap-3 @lg:grid-cols-2">
          <Field label="UPI ID">
            <input name="upiId" required maxLength={300} className={`${fieldCls} text-data`} placeholder="name@bank" />
          </Field>
          <Field label="Name on the UPI (optional)">
            <input name="holderName" maxLength={100} className={fieldCls} />
          </Field>
        </div>
      )}
      <Outcome result={f.result} />
      <Button type="submit" size="sm" value="save" disabled={f.busy}>
        {f.busy ? "Saving..." : "Save payout account"}
      </Button>
    </form>
  );
}
