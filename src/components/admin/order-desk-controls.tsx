"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Modal, ConfirmDialog } from "@/components/ui/confirm-dialog";
import { advanceOrder, assignRider, reassignRider, riderCandidatesFor } from "@/app/manager/actions";
import { cancelOrderAsAdmin } from "@/app/admin/orders/actions";
import { canOverride } from "@/lib/dispatch/eligibility";
import { isValidReason } from "@/lib/ops/reasons";
import type { RiderCandidate } from "@/lib/ops/order-contract";
import type { DeskOrder } from "@/lib/data-access/admin-dispatch";

/**
 * What an operator can do to an order from the dashboard. The same buttons in the
 * board and the list, through the same audited calls as the Manager app:
 * ops_advance_order, ops_assign_rider, ops_reassign_delivery and ops_cancel_order.
 * Each call checks the role itself; hiding a button here secures nothing.
 */

/** Every status change is audited with a reason. A one-click move has this one. */
const MOVED_HERE = "Moved from the admin dashboard";

const NEXT_LABEL: Record<string, string> = {
  placed: "Mark preparing",
  kitchen: "Mark ready",
  ready: "Mark on the way",
  on_the_way: "Mark delivered",
};

const FORWARD = [
  { status: "kitchen", label: "Preparing", after: ["placed"] },
  { status: "ready", label: "Ready for pickup", after: ["placed", "kitchen"] },
  { status: "on_the_way", label: "On the way", after: ["placed", "kitchen", "ready"] },
  { status: "delivered", label: "Delivered", after: ["placed", "kitchen", "ready", "on_the_way"] },
];

const WHY_NOT: Record<string, string> = {
  offline: "Offline",
  on_break: "On a break",
  stale_fix: "No recent location",
  suspended: "Suspended",
  out_of_zone: "Works another zone",
  current_rider: "Already on this order",
};

function Problem({ children }: Readonly<{ children: React.ReactNode }>) {
  return children ? <p className="mt-1.5 text-[11.5px] font-medium text-deal">{children}</p> : null;
}

/** The one thing that moves this order along. */
export function OrderNext({ order }: Readonly<{ order: DeskOrder }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const label = NEXT_LABEL[order.dbStatus];
  if (!label) return null;

  const move = () =>
    start(async () => {
      setError(null);
      const res = await advanceOrder(order.id, order.dbStatus, MOVED_HERE);
      setConfirming(false);
      if (!res.ok) setError(res.error ?? "That didn't go through. Try again.");
      router.refresh();
    });

  // Delivered can't be undone and records the cash, so it asks first.
  const needsConfirm = order.dbStatus === "on_the_way";

  return (
    <div>
      <button
        type="button"
        className="c-btn-affirm whitespace-nowrap"
        disabled={pending}
        aria-label={`${label}: order ${order.code}`}
        onClick={() => (needsConfirm ? setConfirming(true) : move())}
      >
        {pending ? "Moving" : label}
      </button>
      <Problem>{error}</Problem>
      <ConfirmDialog
        open={confirming}
        title={`Mark ${order.code} delivered?`}
        message="This finishes the order and can't be undone. The customer is told."
        confirmLabel="Mark delivered"
        busy={pending}
        onConfirm={move}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

/** Who is carrying it, and the way to put someone on it. */
export function OrderRider({ order }: Readonly<{ order: DeskOrder }>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {order.rider ? (
        <span className="truncate text-[12px] text-ink" title={order.rider.name}>
          {order.rider.name}
        </span>
      ) : (
        <span
          className={
            order.noRider
              ? "shrink-0 text-[11.5px] font-semibold text-deal"
              : "shrink-0 text-[11.5px] text-muted"
          }
        >
          No rider
        </span>
      )}
      <button
        type="button"
        className="c-btn-quiet shrink-0"
        aria-label={`${order.rider ? "Change rider" : "Assign rider"}: order ${order.code}`}
        onClick={() => setOpen(true)}
      >
        {order.rider ? "Change" : "Assign"}
      </button>
      {open ? <RiderPicker order={order} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function candidateNote(c: RiderCandidate): string {
  if (c.ineligibleReason) return WHY_NOT[c.ineligibleReason] ?? "Can't take this order";
  const load = c.activeDeliveries > 0 ? `${c.activeDeliveries} on the go` : "Free";
  return c.distanceKm === null ? load : `${load}, ${c.distanceKm.toFixed(1)} km away`;
}

function RiderPicker({ order, onClose }: Readonly<{ order: DeskOrder; onClose: () => void }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [candidates, setCandidates] = useState<RiderCandidate[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Loaded when the picker opens: this list reads every rider's position, and
  // the dashboard refreshes too often to carry it for every order.
  useEffect(() => {
    let current = true;
    riderCandidatesFor(order.id)
      .then((list) => {
        if (current) setCandidates(list ?? []);
      })
      .catch(() => {
        if (!current) return;
        setCandidates([]);
        setError("Couldn't load the riders. Close this and try again.");
      });
    return () => {
      current = false;
    };
  }, [order.id]);

  const pick = candidates?.find((c) => c.id === chosen) ?? null;
  const changing = Boolean(order.rider);
  const override = Boolean(pick && !pick.eligible);
  const pickedUp = order.deliveryStatus === "picked_up";
  const needsReason = changing || override;

  const submit = () =>
    start(async () => {
      setError(null);
      const res = changing
        ? await reassignRider(order.id, chosen, { reason, override, afterPickup: pickedUp })
        : await assignRider(order.id, chosen, override ? { override: true, reason } : {});
      if (!res.ok) {
        setError(res.error ?? "That didn't go through. Try again.");
        return;
      }
      onClose();
      router.refresh();
    });

  return (
    <Modal open onClose={onClose} title={`${changing ? "Change rider" : "Assign a rider"}: ${order.code}`}>
      {pickedUp ? (
        <p className="mb-3 text-[12.5px] text-[color:var(--c-ink-amber)]">
          {order.rider?.name} already has the food. Sort out getting it back before you change rider.
        </p>
      ) : null}

      {candidates === null ? (
        <p className="text-[12.5px] text-muted">Loading riders</p>
      ) : candidates.length === 0 ? (
        <p className="text-[12.5px] text-muted">No riders work this order&apos;s zone.</p>
      ) : (
        <ul className="max-h-[320px] divide-y divide-[color:var(--c-divider)] overflow-y-auto">
          {candidates.map((c) => {
            const blocked = Boolean(c.ineligibleReason && !canOverride(c.ineligibleReason));
            return (
              <li key={c.id}>
                <label
                  className={
                    blocked
                      ? "flex items-center gap-2.5 px-1 py-2 opacity-50"
                      : "flex cursor-pointer items-center gap-2.5 px-1 py-2 hover:bg-[var(--c-hover)]"
                  }
                >
                  <input
                    type="radio"
                    name={`rider-${order.id}`}
                    value={c.id}
                    checked={chosen === c.id}
                    disabled={blocked}
                    onChange={() => setChosen(c.id)}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{c.name}</span>
                  <span className={c.eligible ? "text-[11.5px] text-muted" : "text-[11.5px] text-[color:var(--c-ink-amber)]"}>
                    {candidateNote(c)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {needsReason ? (
        <label className="mt-3 block text-[12px] font-semibold text-muted">
          {override ? "Why this rider, when they can't normally take it?" : "Why are you changing the rider?"}
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            className="mt-1 w-full rounded-[var(--c-r)] border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] font-normal text-ink"
          />
        </label>
      ) : null}

      <Problem>{error}</Problem>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="c-btn c-btn-outline" onClick={onClose} disabled={pending}>
          Close
        </button>
        <button
          type="button"
          className="c-btn c-btn-dark"
          onClick={submit}
          disabled={pending || !chosen || (needsReason && !isValidReason(reason))}
        >
          {changing ? "Change rider" : "Assign rider"}
        </button>
      </div>
    </Modal>
  );
}

/** Everything else: phone numbers, moving ahead by more than one stage, cancelling. */
export function OrderMore({ order }: Readonly<{ order: DeskOrder }>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="c-btn-quiet"
        aria-label={`More for order ${order.code}`}
        onClick={() => setOpen(true)}
      >
        More
      </button>
      {open ? <MorePanel order={order} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function PhoneRow({ who, name, phone }: Readonly<{ who: string; name?: string; phone: string | null }>) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-[64px] shrink-0 text-[12px] text-muted">{who}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name ?? "No one yet"}</span>
      {phone ? (
        // The number itself as well as the link: this panel is used at a desk,
        // where a tel: link may open nothing and the call is made from a phone.
        <a href={`tel:${phone}`} className="text-data text-[12.5px] font-semibold text-accent-ink hover:underline">
          {phone}
        </a>
      ) : (
        <span className="text-[12px] text-[color:var(--c-faint)]">No number</span>
      )}
    </div>
  );
}

function MorePanel({ order, onClose }: Readonly<{ order: DeskOrder; onClose: () => void }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [target, setTarget] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const later = FORWARD.filter((f) => f.after.includes(order.dbStatus));

  const finish = (res: { ok: boolean; error?: string }) => {
    if (!res.ok) {
      setError(res.error ?? "That didn't go through. Try again.");
      return;
    }
    onClose();
    router.refresh();
  };

  const move = () => start(async () => finish(await advanceOrder(order.id, order.dbStatus, MOVED_HERE, target)));
  const cancel = () => start(async () => finish(await cancelOrderAsAdmin(order.id, reason.trim())));

  return (
    <Modal open onClose={onClose} title={`Order ${order.code}`}>
      <div className="divide-y divide-[color:var(--c-divider)]">
        <PhoneRow who="Customer" name={order.customer} phone={order.customerPhone} />
        <PhoneRow who="Shop" name={order.restaurant} phone={order.shopPhone} />
        <PhoneRow who="Rider" name={order.rider?.name} phone={order.rider?.phone ?? null} />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={pending}
          aria-label={`Move order ${order.code} to`}
          className="min-w-0 flex-1 rounded-[var(--c-r)] border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink"
        >
          <option value="">Move to</option>
          {later.map((f) => (
            <option key={f.status} value={f.status}>
              {f.label}
            </option>
          ))}
        </select>
        <button type="button" className="c-btn c-btn-outline" disabled={pending || !target} onClick={move}>
          Move order
        </button>
      </div>
      {target === "delivered" ? (
        <p className="mt-1.5 text-[11.5px] text-[color:var(--c-ink-amber)]">
          Delivered finishes the order and can&apos;t be undone.
        </p>
      ) : null}

      {cancelling ? (
        <div className="mt-4 border-t border-[color:var(--c-divider)] pt-3">
          <label className="block text-[12px] font-semibold text-muted">
            Why are you cancelling? The customer and the shop are told.
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              maxLength={200}
              rows={2}
              className="mt-1 w-full resize-none rounded-[var(--c-r)] border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] font-normal text-ink"
            />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="c-btn c-btn-outline" disabled={pending} onClick={() => setCancelling(false)}>
              Keep order
            </button>
            <button type="button" className="c-btn-deny" disabled={pending || !isValidReason(reason)} onClick={cancel}>
              Cancel order
            </button>
          </div>
        </div>
      ) : null}

      <Problem>{error}</Problem>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-[color:var(--c-divider)] pt-3">
        <Link href={`/admin/orders/${order.id}`} prefetch={false} className="text-[12px] font-semibold text-accent-ink hover:underline">
          Open full order
        </Link>
        <div className="flex gap-2">
          {cancelling ? null : (
            <button type="button" className="c-btn-deny" disabled={pending} onClick={() => setCancelling(true)}>
              Cancel order
            </button>
          )}
          <button type="button" className="c-btn c-btn-outline" onClick={onClose} disabled={pending}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
