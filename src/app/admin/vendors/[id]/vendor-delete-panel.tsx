"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Panel } from "@/components/admin/console";
import { deleteVendorAction } from "../actions";

/**
 * The profile's "remove this shop" block. It used to live as a header icon
 * beside View / Edit — on a wide console that read as a toolbar, not as the
 * irreversible action it is. The two-step confirm is the same one the list
 * uses: a vendor with orders is disabled, not erased.
 */
export function VendorDeletePanel({ id, name }: Readonly<{ id: string; name: string }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<0 | 1 | 2>(0);

  const onDelete = () =>
    start(async () => {
      const res = await deleteVendorAction(id);
      setStep(0);
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
    <Panel>
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-ink">Remove this shop</h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
            Deletes the shop and its menu. The owner&apos;s login goes too, unless
            they also use it as a customer or for another shop. A shop with orders
            is disabled instead. There is no undo.
          </p>
        </div>
        <button
          type="button"
          className="c-btn shrink-0 border border-deal/40 text-deal hover:bg-deal-soft disabled:opacity-50"
          disabled={pending}
          onClick={() => setStep(1)}
        >
          <Trash2 className="size-3.5" />
          Delete this shop
        </button>
      </div>

      <ConfirmDialog
        open={step === 1}
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
        onConfirm={() => setStep(2)}
        onClose={() => setStep(0)}
      />
      <ConfirmDialog
        open={step === 2}
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
        onClose={() => setStep(0)}
      />
    </Panel>
  );
}
