"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
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
    <section className="vendor-panel">
      <h2 className="text-sm font-bold">Remove this shop</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Deletes the shop, its menu and the owner login. If it already has
        orders, it is disabled instead so those records stay intact. There is no
        undo.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-4 border-deal/40 text-deal hover:bg-deal/10"
        disabled={pending}
        onClick={() => setStep(1)}
      >
        <Trash2 className="size-3.5" />
        Delete this shop
      </Button>

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
        onClose={() => setStep(0)}
      />
    </section>
  );
}
