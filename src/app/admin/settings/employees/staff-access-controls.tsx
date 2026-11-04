"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { ConfirmDialog, Modal } from "@/components/ui/confirm-dialog";
import { fieldCls } from "@/components/ui/field";
import { resetStaffPasswordAction, startStaffAction, stopStaffAction } from "./actions";

/**
 * Stop, Start again and Reset password for one manager or rider, on the Team page
 * and the rider page. These buttons only ask: the rules live on the server.
 */
export function StaffAccessControls({
  id,
  name,
  role,
  stopped,
}: Readonly<{
  id: string;
  name: string;
  role: "manager" | "driver";
  stopped: boolean;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const closeAsk = () => {
    setAsking(false);
    setReason("");
    setError(null);
  };

  const submit = () => {
    setError(null);
    start(async () => {
      const res = stopped ? await startStaffAction(id, reason) : await stopStaffAction(id, reason);
      if (!res.ok) {
        setError(res.error ?? "That didn't go through. Try again.");
        return;
      }
      closeAsk();
      router.refresh();
    });
  };

  const reset = () =>
    start(async () => {
      const res = await resetStaffPasswordAction(id);
      setConfirmReset(false);
      if (!res.ok || !res.password) {
        window.alert(res.error ?? "That didn't go through. Try again.");
        return;
      }
      setCopied(false);
      setPassword(res.password);
    });

  const copy = async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      /* clipboard blocked: the password is on screen to read out */
    }
  };

  const whatStopDoes =
    role === "driver"
      ? "They can't go online or take orders until started again."
      : "They are signed out and can't sign in until started again.";

  return (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      <button type="button" className="c-btn c-btn-outline" disabled={pending} onClick={() => setAsking(true)}>
        {stopped ? "Start again" : "Stop"}
      </button>
      <button type="button" className="c-btn c-btn-outline" disabled={pending} onClick={() => setConfirmReset(true)}>
        Reset password
      </button>

      <Modal open={asking} onClose={closeAsk} title={`${stopped ? "Start" : "Stop"} ${name}${stopped ? " again" : ""}?`}>
        {stopped ? null : <p className="text-sm text-muted">{whatStopDoes}</p>}
        <label className="mt-3 block space-y-1.5 text-sm">
          <span className="font-semibold text-ink">Why? (kept in the audit log)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={3}
            maxLength={300}
            className={fieldCls}
          />
        </label>
        {error ? <p className="mt-2 text-sm font-medium text-deal">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="c-btn c-btn-outline" onClick={closeAsk} disabled={pending}>
            Cancel
          </button>
          <button type="button" className="c-btn c-btn-dark" onClick={submit} disabled={pending || reason.trim().length < 3}>
            {pending ? "Saving…" : stopped ? "Start again" : "Stop"}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmReset}
        title={`Reset ${name}'s password?`}
        message="Their current password stops working and they are signed out on every device."
        confirmLabel="Reset password"
        danger
        busy={pending}
        onConfirm={reset}
        onClose={() => setConfirmReset(false)}
      />

      <Modal open={password !== null} onClose={() => setPassword(null)} title="New password">
        <p className="text-sm text-muted">
          Give this to <b className="text-ink">{name}</b> now. It is shown once and not saved.
        </p>
        <div className="mt-3 flex items-center gap-2 rounded-[var(--c-r)] bg-surface-2 p-2.5">
          <code className="text-data flex-1 break-all px-1 text-[15px] font-semibold text-ink">{password}</code>
          <button
            type="button"
            onClick={copy}
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-muted hover:text-ink"
            aria-label="Copy password"
          >
            {copied ? <Check className="size-4 text-green" /> : <Copy className="size-4" />}
          </button>
        </div>
      </Modal>
    </div>
  );
}
