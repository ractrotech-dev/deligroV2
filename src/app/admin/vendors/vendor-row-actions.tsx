"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Eye,
  Pencil,
  Power,
  PowerOff,
  KeyRound,
  Trash2,
  Copy,
  Check,
} from "lucide-react";
import { ConfirmDialog, Modal } from "@/components/ui/confirm-dialog";
import type { VendorStatus } from "@/lib/vendor-status";
import { cn } from "@/lib/utils/cn";
import {
  deleteVendorAction,
  resetVendorPasswordAction,
  setVendorStatusAction,
} from "./actions";

/**
 * Per-vendor controls: view, edit, enable/disable, reset password, delete
 * (confirmed twice, and guarded — a vendor with orders is disabled, not
 * removed). Each action runs through a transition and refreshes.
 *
 * The vendor table passes `showPasswordReset={false}`, because its password
 * column already reveals, copies, regenerates and sets. The vendor profile
 * keeps password and delete in the Access section on the page, so it turns
 * those header buttons off too — a row of five icons on a shop name is how
 * the console started looking like the phone app.
 */
export function VendorRowActions({
  id,
  name,
  status,
  showView = true,
  showEdit = true,
  showPasswordReset = true,
  showDelete = true,
}: Readonly<{
  id: string;
  name: string;
  status: VendorStatus;
  showView?: boolean;
  showEdit?: boolean;
  /**
   * Off on the vendor table, where the password column already carries reveal,
   * copy, regenerate and set — a second key icon in the same row would be two
   * controls for one job, and the quieter one wins.
   */
  showPasswordReset?: boolean;
  showDelete?: boolean;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Delete asks twice. Step 1 says what deleting does; step 2 is the point of
  // no return, phrased as a last check rather than a repeat of the question —
  // an operator who reflexively clicks through the first dialog still has to
  // read a differently-worded second one before a shop and its menu are gone.
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [tempPw, setTempPw] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const enabled = status === "active";

  // Enabling or disabling a shop is a status change: the reason is recorded
  // on the shop and in the audit log (0145).
  const onToggle = () => {
    const reason = window.prompt(
      enabled ? `Why disable ${name}? (recorded)` : `Why enable ${name}? (recorded)`
    );
    if (reason === null) return;
    start(async () => {
      const res = await setVendorStatusAction(id, enabled ? "inactive" : "active", reason);
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });
  };

  const onDelete = () =>
    start(async () => {
      const res = await deleteVendorAction(id);
      setDeleteStep(0);
      if (!res.ok) {
        window.alert(res.error ?? "Couldn't delete.");
        return;
      }
      if (res.softDeleted) {
        window.alert(
          `${name} has order history, so it was disabled instead of permanently deleted.`
        );
        router.refresh();
        return;
      }
      router.push("/admin/vendors");
    });

  const onReset = () => {
    if (
      !window.confirm(
        `Reset ${name}'s login password? Their current password will stop working.`
      )
    ) {
      return;
    }
    start(async () => {
      const res = await resetVendorPasswordAction(id);
      if (!res.ok || !res.tempPassword) {
        window.alert(res.error ?? "Couldn't reset the password.");
        return;
      }
      setCopied(false);
      setTempPw(res.tempPassword);
    });
  };

  const copyPw = async () => {
    if (!tempPw) return;
    try {
      await navigator.clipboard.writeText(tempPw);
      setCopied(true);
    } catch {
      // Clipboard blocked — the operator can still read and type it.
    }
  };

  // Phone keeps the circular icon chip; the web table (@3xl) adds a label
  // so View / Edit / Disable / Delete can be read without hovering.
  const base =
    "press inline-flex size-9 items-center justify-center rounded-full bg-surface-2 transition-colors disabled:opacity-50 @3xl:h-7 @3xl:w-auto @3xl:gap-1 @3xl:rounded-md @3xl:px-2";
  const tone = {
    blue: "text-blue hover:bg-blue/15",
    violet: "text-violet-500 hover:bg-violet-500/15",
    green: "text-green hover:bg-green/15",
    accent: "text-accent hover:bg-accent/15",
    deal: "text-deal hover:bg-deal/15",
  } as const;
  const icon = "size-4 @3xl:size-3.5";
  const labelCls = "hidden text-[11px] font-semibold leading-none @3xl:inline";

  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      {showView ? (
        <Link
          href={`/admin/vendors/${id}`}
          className={cn(base, tone.violet)}
          title="View"
          aria-label="View vendor"
        >
          <Eye className={icon} />
          <span className={labelCls}>View</span>
        </Link>
      ) : null}
      {showEdit ? (
        <Link
          href={`/admin/vendors/${id}/edit`}
          className={cn(base, tone.blue)}
          title="Edit"
          aria-label="Edit vendor"
        >
          <Pencil className={icon} />
          <span className={labelCls}>Edit</span>
        </Link>
      ) : null}
      <button
        type="button"
        className={cn(base, enabled ? tone.accent : tone.green)}
        disabled={pending}
        title={enabled ? "Disable" : "Enable"}
        aria-label={enabled ? "Disable vendor" : "Enable vendor"}
        onClick={onToggle}
      >
        {enabled ? <PowerOff className={icon} /> : <Power className={icon} />}
        <span className={labelCls}>{enabled ? "Disable" : "Enable"}</span>
      </button>
      {showPasswordReset ? (
        <button
          type="button"
          className={cn(base, tone.violet)}
          disabled={pending}
          title="Reset password"
          aria-label="Reset vendor password"
          onClick={onReset}
        >
          <KeyRound className={icon} />
          <span className={labelCls}>Reset</span>
        </button>
      ) : null}
      {showDelete ? (
        <button
          type="button"
          className={cn(base, tone.deal)}
          disabled={pending}
          title="Delete"
          aria-label="Delete vendor"
          onClick={() => setDeleteStep(1)}
        >
          <Trash2 className={icon} />
          <span className={labelCls}>Delete</span>
        </button>
      ) : null}

      <ConfirmDialog
        open={deleteStep === 1}
        title="Delete vendor?"
        message={
          <>
            This permanently removes <b className="text-ink">{name}</b> and its
            menu. A vendor with order history is disabled instead, to keep its
            records intact.
          </>
        }
        confirmLabel="Continue"
        danger
        busy={pending}
        onConfirm={() => setDeleteStep(2)}
        onClose={() => setDeleteStep(0)}
      />

      <ConfirmDialog
        open={deleteStep === 2}
        title="Delete permanently?"
        message={
          <>
            Last check: <b className="text-ink">{name}</b>, its menu and its
            owner login are deleted for good. There is no undo and no backup in
            the admin — you would have to add the shop again from scratch.
          </>
        }
        confirmLabel="Yes, delete permanently"
        cancelLabel="Keep vendor"
        danger
        busy={pending}
        onConfirm={onDelete}
        onClose={() => setDeleteStep(0)}
      />

      <Modal
        open={tempPw !== null}
        onClose={() => {
          setTempPw(null);
          setCopied(false);
        }}
        title="New password"
      >
        <p className="text-sm text-muted">
          <b className="text-ink">{name}</b> signs in with their mobile number
          and this password. It is saved against the shop, so you can read it
          back from the vendor list if they lose it.
        </p>
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 p-2.5">
          <code className="text-data flex-1 break-all px-1 text-[15px] font-semibold text-ink">
            {tempPw}
          </code>
          <button
            type="button"
            onClick={copyPw}
            className="press grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-muted hover:text-ink"
            aria-label="Copy password"
          >
            {copied ? (
              <Check className="size-4 text-green" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
        </div>
      </Modal>
    </div>
  );
}
