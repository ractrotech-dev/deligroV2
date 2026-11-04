"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/field";
import type { VendorStatus } from "@/lib/vendor-status";
import { deleteVendorAction, setVendorStatusAction } from "./actions";

/**
 * Enabling or disabling a shop is a status change: the reason is recorded on the
 * shop and in the audit log (0145). A shop that is not active is hidden from the
 * customer app, because the feed reads `approved`, which follows the status.
 */
function useStatusToggle(id: string, name: string, status: VendorStatus) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const enabled = status === "active";

  const toggle = () => {
    const reason = window.prompt(
      enabled
        ? `Why disable ${name}? It disappears from the customer app. (recorded)`
        : `Why enable ${name}? It shows on the customer app again. (recorded)`
    );
    if (reason === null) return;
    start(async () => {
      const res = await setVendorStatusAction(id, enabled ? "inactive" : "active", reason);
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });
  };

  return { enabled, pending, toggle };
}

/** The on/off switch in the vendor table's last column. */
export function VendorStatusToggle({
  id,
  name,
  status,
}: Readonly<{ id: string; name: string; status: VendorStatus }>) {
  const { enabled, pending, toggle } = useStatusToggle(id, name, status);
  return (
    <span title={enabled ? "Enabled" : "Disabled"}>
      <Switch
        id={`vendor-enabled-${id}`}
        label={`${enabled ? "Disable" : "Enable"} ${name}`}
        checked={enabled}
        disabled={pending}
        onChange={toggle}
      />
    </span>
  );
}

/**
 * Per-vendor controls: view, edit, enable/disable, delete
 * (confirmed twice, and guarded — a vendor with orders is disabled, not
 * removed). Each action runs through a transition and refreshes.
 */
export function VendorRowActions({
  id,
  name,
  status,
  showView = true,
  showEdit = true,
  showToggle = true,
  showDelete = true,
}: Readonly<{
  id: string;
  name: string;
  status: VendorStatus;
  showView?: boolean;
  showEdit?: boolean;
  /** Off on the vendor table, whose last column carries the switch. */
  showToggle?: boolean;
  showDelete?: boolean;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Delete asks twice. Step 1 says what deleting does; step 2 is the point of
  // no return, phrased as a last check rather than a repeat of the question —
  // an operator who reflexively clicks through the first dialog still has to
  // read a differently-worded second one before a shop and its menu are gone.
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);

  const { enabled, pending: toggling, toggle: onToggle } = useStatusToggle(id, name, status);

  const onDelete = () =>
    start(async () => {
      const res = await deleteVendorAction(id);
      setDeleteStep(0);
      if (!res.ok) {
        window.alert(res.error ?? "Couldn't delete.");
        return;
      }
      if (res.notice) window.alert(res.notice);
      if (res.softDeleted) {
        window.alert(
          `${name} has order history, so it was disabled instead of permanently deleted.`
        );
        router.refresh();
        return;
      }
      router.push("/admin/vendors");
    });

  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      {showView ? (
        <Link href={`/admin/vendors/${id}`} className="c-btn c-btn-outline">
          View
        </Link>
      ) : null}
      {showEdit ? (
        <Link href={`/admin/vendors/${id}/edit`} className="c-btn c-btn-outline">
          Edit
        </Link>
      ) : null}
      {showToggle ? (
        <button
          type="button"
          className="c-btn c-btn-outline"
          disabled={pending || toggling}
          onClick={onToggle}
        >
          {enabled ? "Disable" : "Enable"}
        </button>
      ) : null}
      {showDelete ? (
        <button
          type="button"
          className="c-btn border border-deal/40 text-deal hover:bg-deal-soft"
          disabled={pending}
          onClick={() => setDeleteStep(1)}
        >
          Delete
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
            Last check: <b className="text-ink">{name}</b> and its menu are
            deleted for good, with the owner&apos;s login unless they use it for
            something else. There is no undo.
          </>
        }
        confirmLabel="Yes, delete permanently"
        cancelLabel="Keep vendor"
        danger
        busy={pending}
        onConfirm={onDelete}
        onClose={() => setDeleteStep(0)}
      />
    </div>
  );
}
