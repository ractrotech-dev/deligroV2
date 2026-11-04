"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/confirm-dialog";
import { StaffAccessControls } from "@/app/admin/settings/employees/staff-access-controls";

/**
 * A row's Account button on the Riders list: how the rider signs in, and Deactivate,
 * Reset password and Delete rider. The buttons only ask; their actions check the
 * role themselves. A password can't be shown: Auth holds only a hash and no copy is
 * kept (AGENTS.md rule 4), so a new one comes from Reset password, shown once.
 */
export function RiderAccountButton({
  id,
  name,
  email,
  phone,
  stopped,
}: Readonly<{
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  stopped: boolean;
}>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="c-btn-quiet" onClick={() => setOpen(true)}>
        Account
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={name}>
        <dl className="space-y-2 text-[13px]">
          <Line label="Email">{email ?? "Not available"}</Line>
          <Line label="Mobile">{phone ?? "None"}</Line>
          <Line label="Password">Can&apos;t be shown</Line>
        </dl>
        <p className="mt-3 text-[12px] leading-snug text-muted">Forgotten password? Reset it to get a new one, shown once.</p>
        <div className="mt-4">
          <StaffAccessControls id={id} name={name} role="driver" stopped={stopped} />
        </div>
      </Modal>
    </>
  );
}

function Line({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="text-data min-w-0 break-all text-right font-semibold text-ink">{children}</dd>
    </div>
  );
}
