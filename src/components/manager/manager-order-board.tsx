"use client";

import { useState, useTransition } from "react";
import { useFeatures } from "@/components/features/features-provider";
import {
  LoaderCircle,
  ArrowRight,
  Bike,
  Banknote,
  CreditCard,
  Phone,
  PhoneIncoming,
  ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatINR } from "@/lib/utils/format";
import { advanceOrder, assignRider } from "@/app/manager/actions";
import type { ManagerOrderRow, ManagerRider } from "@/lib/data-access/manager-orders";

const NEXT_LABEL: Record<string, string> = {
  placed: "Mark preparing",
  kitchen: "Mark ready",
  ready: "Mark on the way",
  on_the_way: "Mark delivered",
};

const STATUS: Record<ManagerOrderRow["status"], { label: string; cls: string }> = {
  PLACED: { label: "Placed", cls: "pill-accent" },
  KITCHEN: { label: "Preparing", cls: "pill-accent" },
  READY: { label: "Ready for pickup", cls: "pill-accent" },
  ON_THE_WAY: { label: "On the way", cls: "pill-accent" },
  DELIVERED: { label: "Delivered", cls: "pill-green" },
  CANCELLED: { label: "Cancelled", cls: "pill-muted" },
};

/** Minutes since the order was placed — the queue's real priority signal. */
function waitingMinutes(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export function ManagerOrderBoard({
  orders,
  riders,
}: Readonly<{
  orders: ManagerOrderRow[];
  riders: ManagerRider[];
}>) {
  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-10 text-center">
        <span className="mb-1 grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted">
          <ClipboardList className="size-6" />
        </span>
        <p className="font-semibold">Nothing in flight</p>
        <p className="max-w-xs text-sm text-muted">
          Every order has been delivered or cancelled. New ones appear here as
          customers check out.
        </p>
      </div>
    );
  }

  return (
    // One card per order. A list in the phone frame; a grid once the column is
    // wide enough that a single stack would be a 1000px-long ribbon of
    // half-empty cards — which is what the board looked like at a desk.
    <ul className="space-y-2.5 @3xl:grid @3xl:grid-cols-2 @3xl:gap-2.5 @3xl:space-y-0 @5xl:grid-cols-3">
      {orders.map((o) => (
        <OrderCard key={o.id} order={o} riders={riders} />
      ))}
    </ul>
  );
}

/** How the order is being paid for, for the payment pill. */
function paymentLabel(o: ManagerOrderRow): string {
  if (o.paymentMethod !== "online") return "Cash";
  return o.paymentStatus === "paid" ? "Prepaid" : "Online · unpaid";
}

function OrderCard({
  order: o,
  riders,
}: Readonly<{
  order: ManagerOrderRow;
  riders: ManagerRider[];
}>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rider, setRider] = useState("");

  const waited = waitingMinutes(o.createdAtIso);
  // Admin → Feature access; the actions behind these refuse it too.
  const features = useFeatures();
  const nextLabel = features["manager.move_status"] ? NEXT_LABEL[o.dbStatus] : undefined;

  // Dispatch is offered from `ready` onward — before the food is packed there is
  // nothing for a rider to collect. Hidden once one is assigned.
  const canDispatch =
    features["manager.assign_rider"] &&
    !o.rider &&
    (o.dbStatus === "ready" || o.dbStatus === "on_the_way");

  const advance = () => {
    startTransition(async () => {
      setError(null);
      const result = await advanceOrder(o.id, o.dbStatus);
      if (!result.ok) setError(result.error ?? "Failed");
    });
  };

  const dispatch = () => {
    if (!rider) return;
    startTransition(async () => {
      setError(null);
      const result = await assignRider(o.id, rider);
      if (!result.ok) setError(result.error ?? "Failed");
      else setRider("");
    });
  };

  return (
    <li className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-data font-bold">{o.code}</p>
          <p className="mt-0.5 truncate text-sm text-ink">{o.customer}</p>
          <p className="truncate text-xs text-muted">{o.restaurant}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-data text-sm font-bold">{formatINR(o.total)}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            {o.itemCount} item{o.itemCount === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className={`pill ${STATUS[o.status].cls}`}>
          {STATUS[o.status].label}
        </span>
        {/* 20 minutes is the point where a customer starts wondering. */}
        <span
          className={`pill ${waited >= 20 ? "bg-red-500/10 text-red-600" : "pill-muted"}`}
        >
          {waited} min
        </span>
        {/* Silent when the column is absent — an unknown payment is not "cash". */}
        {o.paymentMethod ? <PaymentPill order={o} /> : null}
        {/* Nobody at the other end saw a checkout screen, so nothing about this
            order was confirmed by the customer — worth knowing before you read
            an address back or assume they are watching the tracker. */}
        {o.byPhone ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-pop/15 px-2 py-0.5 text-[11px] font-semibold text-ink">
            <PhoneIncoming className="size-3" />
            Phone order
          </span>
        ) : null}
        {o.rider ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink">
            <Bike className="size-3" />
            {o.rider.name}
          </span>
        ) : null}
        {o.customerPhone && features["manager.call_customer"] ? (
          <a
            href={`tel:${o.customerPhone}`}
            className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink hover:bg-line/60"
          >
            <Phone className="size-3" />
            Call
          </a>
        ) : null}
      </div>

      {nextLabel || canDispatch ? (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          {canDispatch ? (
            <DispatchControls
              code={o.code}
              riders={riders}
              rider={rider}
              onRiderChange={setRider}
              pending={pending}
              onDispatch={dispatch}
            />
          ) : null}

          {nextLabel ? (
            <AdvanceButton label={nextLabel} pending={pending} onAdvance={advance} />
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-sm font-medium text-red-500">{error}</p>
      ) : null}
    </li>
  );
}

function PaymentPill({ order: o }: Readonly<{ order: ManagerOrderRow }>) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink">
      {o.paymentMethod === "online" ? (
        <CreditCard className="size-3" />
      ) : (
        <Banknote className="size-3" />
      )}
      {paymentLabel(o)}
    </span>
  );
}

function AdvanceButton({
  label,
  pending,
  onAdvance,
}: Readonly<{ label: string; pending: boolean; onAdvance: () => void }>) {
  return (
    <Button
      size="sm"
      onClick={onAdvance}
      disabled={pending}
      className="w-full"
    >
      {pending ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <ArrowRight className="size-4" />
      )}
      {label}
    </Button>
  );
}

/** Pick a rider and send them. The assignment itself stays with the card. */
function DispatchControls({
  code,
  riders,
  rider,
  onRiderChange,
  pending,
  onDispatch,
}: Readonly<{
  code: string;
  riders: ManagerRider[];
  rider: string;
  onRiderChange: (riderId: string) => void;
  pending: boolean;
  onDispatch: () => void;
}>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={rider}
        onChange={(e) => onRiderChange(e.target.value)}
        disabled={pending || riders.length === 0}
        className="min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink disabled:opacity-60"
        aria-label={`Assign a rider to ${code}`}
      >
        <option value="">
          {riders.length === 0 ? "No riders registered" : "Assign rider…"}
        </option>
        {riders.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
            {r.activeJobs > 0 ? ` · ${r.activeJobs} active` : " · free"}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="secondary"
        onClick={onDispatch}
        disabled={pending || !rider}
      >
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Bike className="size-4" />
        )}
        Dispatch
      </Button>
    </div>
  );
}
