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
import { advanceOrder, assignRider, riderCandidatesFor } from "@/app/manager/actions";
import type { ManagerOrderRow } from "@/lib/data-access/manager-orders";
import type { RiderCandidate } from "@/lib/ops/order-contract";
import { canOverride } from "@/lib/dispatch/eligibility";
import { ADVANCE_QUICK_REASONS, isValidReason } from "@/lib/ops/reasons";

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
}: Readonly<{
  orders: ManagerOrderRow[];
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
        <OrderCard key={o.id} order={o} />
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
}: Readonly<{
  order: ManagerOrderRow;
}>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rider, setRider] = useState("");
  const [reason, setReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  // The shared candidate list (eligibility and the reason each rider can't
  // take it), loaded when the manager opens the picker.
  const [candidates, setCandidates] = useState<RiderCandidate[] | null>(null);

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

  const chosen = candidates?.find((c) => c.id === rider) ?? null;
  const needsOverride = !!chosen && !chosen.eligible;

  const loadCandidates = () => {
    if (candidates !== null) return;
    startTransition(async () => {
      const list = await riderCandidatesFor(o.id);
      setCandidates(list ?? []);
    });
  };

  const advance = () => {
    if (!isValidReason(reason)) {
      setError("Pick a reason first.");
      return;
    }
    startTransition(async () => {
      setError(null);
      const result = await advanceOrder(o.id, o.dbStatus, reason);
      if (!result.ok) setError(result.error ?? "Failed");
      else setReason("");
    });
  };

  const dispatch = () => {
    if (!rider) return;
    if (needsOverride && !isValidReason(overrideReason)) {
      setError("Say why you are putting this rider on anyway.");
      return;
    }
    startTransition(async () => {
      setError(null);
      const result = await assignRider(
        o.id,
        rider,
        needsOverride ? { override: true, reason: overrideReason } : {}
      );
      if (!result.ok) setError(result.error ?? "Failed");
      else {
        setRider("");
        setOverrideReason("");
        setCandidates(null);
      }
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
              candidates={candidates}
              onOpen={loadCandidates}
              rider={rider}
              onRiderChange={setRider}
              needsOverride={needsOverride}
              overrideReason={overrideReason}
              onOverrideReasonChange={setOverrideReason}
              pending={pending}
              onDispatch={dispatch}
            />
          ) : null}

          {nextLabel ? (
            <AdvanceControls
              code={o.code}
              label={nextLabel}
              reason={reason}
              onReasonChange={setReason}
              pending={pending}
              onAdvance={advance}
            />
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

const OTHER = "__other";

/**
 * Move the order a step, with a reason (design §6.10). The four quick reasons
 * are the Manager app's; "Other" takes a sentence.
 */
function AdvanceControls({
  code,
  label,
  reason,
  onReasonChange,
  pending,
  onAdvance,
}: Readonly<{
  code: string;
  label: string;
  reason: string;
  onReasonChange: (reason: string) => void;
  pending: boolean;
  onAdvance: () => void;
}>) {
  const [other, setOther] = useState(false);
  const quick = (ADVANCE_QUICK_REASONS as readonly string[]).includes(reason);
  return (
    <div className="space-y-2">
      <select
        value={other ? OTHER : quick ? reason : ""}
        onChange={(e) => {
          const v = e.target.value;
          setOther(v === OTHER);
          onReasonChange(v === OTHER ? "" : v);
        }}
        disabled={pending}
        className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink disabled:opacity-60"
        aria-label={`Reason for moving ${code}`}
      >
        <option value="">Reason…</option>
        {ADVANCE_QUICK_REASONS.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {other ? (
        <input
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          maxLength={300}
          placeholder="Why are you moving this order?"
          className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          aria-label={`Other reason for moving ${code}`}
        />
      ) : null}
      <Button
        size="sm"
        onClick={onAdvance}
        disabled={pending || !isValidReason(reason)}
        className="w-full"
      >
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <ArrowRight className="size-4" />
        )}
        {label}
      </Button>
    </div>
  );
}

const WHY_NOT: Record<string, string> = {
  offline: "offline",
  on_break: "on a break",
  stale_fix: "no recent location",
  suspended: "suspended",
  out_of_zone: "another zone",
  current_rider: "already on it",
};

/**
 * Pick a rider and send them. The list is the shared one: eligible riders
 * first; an offline, on-break or location-less rider can be put on anyway with
 * a reason (recorded as an override); another zone or a suspension cannot.
 */
function DispatchControls({
  code,
  candidates,
  onOpen,
  rider,
  onRiderChange,
  needsOverride,
  overrideReason,
  onOverrideReasonChange,
  pending,
  onDispatch,
}: Readonly<{
  code: string;
  candidates: RiderCandidate[] | null;
  onOpen: () => void;
  rider: string;
  onRiderChange: (riderId: string) => void;
  needsOverride: boolean;
  overrideReason: string;
  onOverrideReasonChange: (reason: string) => void;
  pending: boolean;
  onDispatch: () => void;
}>) {
  let placeholder = "Assign rider…";
  if (candidates === null) placeholder = "Assign rider… (tap to load)";
  else if (candidates.length === 0) placeholder = "No riders in this zone";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={rider}
          onFocus={onOpen}
          onMouseDown={onOpen}
          onChange={(e) => onRiderChange(e.target.value)}
          disabled={pending && candidates === null}
          className="min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink disabled:opacity-60"
          aria-label={`Assign a rider to ${code}`}
        >
          <option value="">{placeholder}</option>
          {(candidates ?? []).map((c) => {
            const why = c.ineligibleReason ? WHY_NOT[c.ineligibleReason] ?? c.ineligibleReason : null;
            const blocked = !!c.ineligibleReason && !canOverride(c.ineligibleReason);
            let load = " · free";
            if (c.activeDeliveries > 0) load = ` · ${c.activeDeliveries} active`;
            let suffix = load;
            if (why && blocked) suffix = ` · ${why}`;
            else if (why) suffix = ` · ${why} (override)`;
            return (
              <option key={c.id} value={c.id} disabled={blocked}>
                {c.name}
                {suffix}
              </option>
            );
          })}
        </select>
        <Button
          size="sm"
          variant="secondary"
          onClick={onDispatch}
          disabled={pending || !rider || (needsOverride && !isValidReason(overrideReason))}
        >
          {pending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Bike className="size-4" />
          )}
          Dispatch
        </Button>
      </div>
      {needsOverride ? (
        <input
          value={overrideReason}
          onChange={(e) => onOverrideReasonChange(e.target.value)}
          maxLength={300}
          placeholder="Why put this rider on anyway?"
          className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          aria-label={`Override reason for ${code}`}
        />
      ) : null}
    </div>
  );
}
