"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { StatusText } from "@/components/admin/console/status";
import { setVendorOpenAction } from "../actions";

/**
 * Open or close the shop for customers, from Admin. This is the same open/closed
 * state the owner's own switch sets, not the shop's Active or Disabled status.
 */
export function VendorOpenButton({ id, isOpen }: Readonly<{ id: string; isOpen: boolean }>) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const toggle = () => {
    if (isOpen && !window.confirm("Close this shop? Customers can't order until it opens again.")) return;
    start(async () => {
      const res = await setVendorOpenAction(id, !isOpen);
      if (!res.ok) window.alert(res.error ?? "That didn't go through. Try again.");
      router.refresh();
    });
  };

  return (
    <span className="inline-flex items-center gap-2">
      <StatusText tone={isOpen ? "green" : "neutral"}>{isOpen ? "Open" : "Closed"}</StatusText>
      <button type="button" onClick={toggle} disabled={pending} className="c-btn c-btn-outline">
        {pending ? "Saving…" : isOpen ? "Close shop" : "Open shop"}
      </button>
    </span>
  );
}
