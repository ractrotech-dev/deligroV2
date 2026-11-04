"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/confirm-dialog";
import { Switch, fieldCls } from "@/components/ui/field";
import { setAllVendorsStatusAction } from "./actions";

/**
 * Turns every shop off, or every shop that can be on back on. It behaves like a
 * "select all" box: on only when nothing is left to enable, so from a mixed
 * roster the first click enables and the next one disables.
 */
export function VendorMasterSwitch({
  active,
  enableable,
}: Readonly<{
  /** Shops that are on now. */
  active: number;
  /** Shops that are off, not suspended, and have a map pin. */
  enableable: number;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const allOn = active > 0 && enableable === 0;
  const count = allOn ? active : enableable;
  const shops = `${count} shop${count === 1 ? "" : "s"}`;

  const apply = () => {
    setError(null);
    start(async () => {
      const res = await setAllVendorsStatusAction(allOn ? "inactive" : "active", reason);
      if (!res.ok) {
        setError(res.error ?? "That didn't go through. Try again.");
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
      if (res.failed) {
        window.alert(`${res.changed} changed, ${res.failed} did not. Try again for the rest.`);
      }
    });
  };

  return (
    <span className="normal-case tracking-normal" title={allOn ? "Disable all shops" : "Enable all shops"}>
      <Switch
        id="vendors-master-switch"
        label={allOn ? "Disable all shops" : "Enable all shops"}
        checked={allOn}
        disabled={pending || count === 0}
        onChange={() => {
          setError(null);
          setOpen(true);
        }}
      />
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={allOn ? `Disable all ${shops}?` : `Enable ${shops}?`}
      >
        <p className="text-sm text-muted">
          {allOn
            ? "Customers will not see any of them until they are enabled again. Suspended shops stay suspended."
            : "They will show on the customer app, including any that someone disabled one at a time. Suspended shops and shops with no map pin stay off."}
        </p>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${fieldCls} mt-3`}
          placeholder="Reason (recorded against each shop)"
          aria-label="Reason"
        />
        {error ? <p className="mt-2 text-xs font-medium text-deal">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={apply} disabled={pending || reason.trim().length < 3}>
            {pending ? "Working…" : allOn ? `Disable ${shops}` : `Enable ${shops}`}
          </Button>
        </div>
      </Modal>
    </span>
  );
}
