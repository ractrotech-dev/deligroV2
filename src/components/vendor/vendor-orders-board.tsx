"use client";

import { useState, useSyncExternalStore } from "react";
import {
  Banknote,
  Bell,
  Check,
  ChevronDown,
  Clock,
  CreditCard,
  ExternalLink,
  KeyRound,
  MapPin,
  Phone,
  Timer,
  User,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { VendorSegmentedTabs } from "@/components/vendor/vendor-page-header";
import { VendorOrderHistoryDialog } from "@/components/vendor/vendor-order-history-dialog";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { KitchenAlert } from "@/components/vendor/kitchen-alert";
import { KitchenBusyControl } from "@/components/vendor/kitchen-busy-control";
import type { VendorPace } from "@/lib/data-access/vendor-restaurant";
import {
  VendorEmptyState,
  VendorHero,
  VendorKanbanColumn,
  VendorMetricCard,
  VendorPanel,
} from "@/components/vendor/vendor-ui";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import type { KitchenOrder } from "@/lib/roles-data";

type OrderTab = "new" | "prep" | "ready" | "cancelled" | "done";

function statusLabel(status: string) {
  if (status === "delivered") return "Delivered";
  if (status === "cancelled") return "Cancelled";
  if (status === "on_the_way") return "On the way";
  return status;
}

function orderTitle(order: KitchenOrder): string {
  if (order.lines.length === 0) return "Order";
  if (order.lines.length === 1) return order.lines[0].name;
  return `${order.lines[0].name} +${order.lines.length - 1} more`;
}

function orderDescription(order: KitchenOrder): string {
  const first = order.lines[0];
  if (first?.description) return first.description;
  const customer = order.customerProfile?.name ?? order.customer;
  return `${customer} · ${order.area}`;
}

const BADGE =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide";

/**
 * How this order is paid, in the two words a kitchen actually needs.
 *
 * The board had nothing here at all, which was survivable while every order was
 * cash and became dangerous the moment online payment shipped: the person
 * packing the bag and the rider taking it both have to know whether ₹420 is
 * still owed at the door, and neither had any way to find out.
 *
 * Renders nothing when `paymentMethod` is undefined — a database that predates
 * 0025 cannot answer the question, and inventing "CASH" for an order we cannot
 * classify is the exact failure that has a rider asking a prepaid customer to
 * pay twice. Silence is recoverable; a confident wrong answer is not.
 */
function PaymentBadge({ order }: { order: KitchenOrder }) {
  if (!order.paymentMethod) return null;

  if (order.paymentMethod === "cod") {
    return (
      <span className={cn(BADGE, "bg-pop/25 text-ink")}>
        <Banknote className="size-3" />
        Cash {formatINR(order.total)}
      </span>
    );
  }

  if (order.paymentStatus === "paid") {
    return (
      <span className={cn(BADGE, "bg-green/15 text-green")}>
        <CreditCard className="size-3" />
        Paid online
      </span>
    );
  }

  if (order.paymentStatus === "refunded") {
    return (
      <span className={cn(BADGE, "bg-surface-2 text-muted")}>
        <CreditCard className="size-3" />
        Refunded
      </span>
    );
  }

  // Everything else — pending, failed, and deliberately also `authorized`,
  // which is Razorpay's captured-but-not-settled state. 0025 keeps it distinct
  // from `paid` so a manual-capture account never reads as settled, and this
  // badge honours that: not paid yet is not paid.
  return (
    <span className={cn(BADGE, "bg-red-500/10 text-red-500")}>
      <CreditCard className="size-3" />
      Online · unpaid
    </span>
  );
}

/**
 * The wall clock, as an external store.
 *
 * Elapsed time is the one thing on this board that changes without React being
 * told, so it is subscribed to rather than kept in state — and the server
 * snapshot being null is the point: the markup Node renders and the markup the
 * browser hydrates agree on "nothing here yet", and the figure appears on the
 * first tick afterwards. Reading Date.now() during render instead would make
 * "14 min" on the server and "15 min" in the browser a hydration error every
 * time the two land either side of a minute boundary.
 */
const CLOCK_TICK_MS = 20_000;
let clockNow = 0;

function subscribeToClock(onChange: () => void): () => void {
  clockNow = Date.now();
  const timer = window.setInterval(() => {
    clockNow = Date.now();
    onChange();
  }, CLOCK_TICK_MS);
  return () => window.clearInterval(timer);
}

function getClockNow(): number {
  return clockNow;
}

function getServerClockNow(): number {
  return 0;
}

/** Current time on the client, or null before the first subscription lands. */
function useClockNow(): number | null {
  const now = useSyncExternalStore(
    subscribeToClock,
    getClockNow,
    getServerClockNow
  );
  return now === 0 ? null : now;
}

/**
 * How long this order has been on the stove. Stated, not judged — this system
 * has no promised prep time, so the card reports what the clock says and leaves
 * "is that too long?" to the person who knows the kitchen.
 */
function KitchenTimer({ since }: { since?: string | null }) {
  const now = useClockNow();
  if (!since || now === null) return null;

  const startedAt = new Date(since).getTime();
  if (Number.isNaN(startedAt)) return null;
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));

  return (
    <span className="inline-flex items-center gap-1">
      <Timer className="size-3.5 shrink-0" />
      {minutes < 1 ? "just accepted" : `${minutes} min in kitchen`}
    </span>
  );
}

function ItemThumb({
  src,
  name,
  size = "md",
}: {
  src?: string | null;
  name: string;
  size?: "sm" | "md";
}) {
  const dim = size === "sm" ? "size-10" : "size-14";
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className={cn(dim, "shrink-0 rounded-xl object-cover")}
      />
    );
  }
  return (
    <span
      className={cn(
        dim,
        "grid shrink-0 place-items-center rounded-xl bg-surface-2 text-muted"
      )}
    >
      <UtensilsCrossed className="size-5" />
    </span>
  );
}

function OrderCard({
  order,
  variant = "default",
  meta,
  children,
}: {
  order: KitchenOrder;
  variant?: "new" | "default";
  /** Extra line-of-facts for the header row, e.g. the in-kitchen clock. */
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(variant === "new");
  const first = order.lines[0];
  const title = orderTitle(order);
  const description = orderDescription(order);

  return (
    <article
      className={cn(
        "vendor-order-card overflow-hidden",
        variant === "new" && "vendor-order-card--new"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="press flex w-full items-start gap-3 p-3 text-left sm:p-4"
      >
        <ItemThumb src={first?.imageUrl} name={title} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-data text-xs font-semibold text-muted">
              {order.code}
            </p>
            {variant === "new" ? (
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold uppercase text-accent">
                New
              </span>
            ) : null}
            <PaymentBadge order={order} />
          </div>
          <p className="mt-0.5 line-clamp-1 text-sm font-bold leading-snug">
            {title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted">{description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5 shrink-0" />
              {order.placedAt || order.placedAgo}
            </span>
            <span className="text-data font-bold text-ink">
              {formatINR(order.total)}
            </span>
            {meta}
          </div>
        </div>
        <ChevronDown
          className={cn(
            "mt-1 size-4 shrink-0 text-muted transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open ? (
        <div className="border-t border-line px-3 pb-3 sm:px-4 sm:pb-4">
          <div className="mt-3 flex gap-3 rounded-xl bg-surface-2 p-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent/15 text-sm font-bold text-accent">
              {order.customerProfile?.initials ??
                order.customer.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <User className="size-3.5 text-muted" />
                {order.customerProfile?.name ?? order.customer}
              </p>
              {order.customerProfile?.phone ? (
                <a
                  href={`tel:${order.customerProfile.phone.replace(/\s/g, "")}`}
                  className="flex items-center gap-1.5 text-sm text-accent"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Phone className="size-3.5" />
                  {order.customerProfile.phone}
                </a>
              ) : null}
              <p className="flex items-start gap-1.5 text-xs text-muted">
                <MapPin className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-2">{order.area}</span>
              </p>
            </div>
          </div>

          <ul className="mt-3 space-y-2">
            {order.lines.map((l, i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-xl border border-line bg-surface-2/60 p-2.5"
              >
                <ItemThumb src={l.imageUrl} name={l.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold leading-snug">
                      <span className="text-data text-accent">{l.qty}×</span>{" "}
                      {l.name}
                    </p>
                    <span className="text-data shrink-0 text-sm font-bold">
                      {formatINR(l.price * l.qty)}
                    </span>
                  </div>
                  {l.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">
                      {l.description}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {order.note ? (
            <p className="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
              Note: {order.note}
            </p>
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-2">{children}</div>
        </div>
      ) : null}
    </article>
  );
}

function IncomingList({
  orders,
  busy,
  onPatch,
}: {
  orders: KitchenOrder[];
  busy: string | null;
  onPatch: (o: KitchenOrder, s: "kitchen" | "ready" | "cancelled") => void;
}) {
  if (orders.length === 0) {
    return (
      <VendorEmptyState
        title="All caught up"
        description="New orders will appear here the moment a customer places one."
      />
    );
  }
  return (
    <div className="space-y-3">
      {orders.map((o) => (
        <OrderCard key={o.id} order={o} variant="new">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={busy === o.id}
            onClick={() => onPatch(o, "cancelled")}
          >
            <X className="size-4" /> Reject
          </Button>
          <Button
            size="sm"
            className="w-full"
            disabled={busy === o.id}
            onClick={() => onPatch(o, "kitchen")}
          >
            <Check className="size-4" /> Accept
          </Button>
        </OrderCard>
      ))}
    </div>
  );
}

function PreparingList({
  orders,
  busy,
  onPatch,
}: {
  orders: KitchenOrder[];
  busy: string | null;
  onPatch: (o: KitchenOrder, s: "kitchen" | "ready" | "cancelled") => void;
}) {
  if (orders.length === 0) {
    return (
      <VendorEmptyState
        title="Kitchen clear"
        description="Accepted orders stay here while you cook."
      />
    );
  }
  return (
    <div className="space-y-3">
      {orders.map((o) => (
        <OrderCard
          key={o.id}
          order={o}
          meta={<KitchenTimer since={o.acceptedAt} />}
        >
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={busy === o.id}
            onClick={() => onPatch(o, "cancelled")}
          >
            <X className="size-4" /> Cancel
          </Button>
          <Button
            size="sm"
            className="w-full"
            disabled={busy === o.id}
            onClick={() => onPatch(o, "ready")}
          >
            <Bell className="size-4" /> Ready
          </Button>
        </OrderCard>
      ))}
    </div>
  );
}

function ReadyList({
  orders,
  busy,
  onPatch,
}: {
  orders: KitchenOrder[];
  busy: string | null;
  onPatch: (o: KitchenOrder, s: "kitchen" | "ready" | "cancelled") => void;
}) {
  if (orders.length === 0) {
    return (
      <VendorEmptyState
        title="Nothing waiting"
        description="Mark prep orders Ready when food is packed for pickup."
      />
    );
  }
  return (
    <div className="space-y-3">
      {orders.map((o) => (
        <OrderCard key={o.id} order={o}>
          {/* The counter's half of the handover. The rider cannot mark this
              order collected without entering it, so reading it out is what
              releases the food — and it is only read out to the courier who
              actually turns up. It had never been shown anywhere: the column
              has existed since migration 0006 with no UI, and the one attempt
              at using it showed the code to the RIDER, who then did not have to
              produce it for anyone. */}
          {o.pickupOtp ? (
            <div className="col-span-2 flex items-center justify-between gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
              <span className="text-label flex items-center gap-1.5">
                <KeyRound className="size-3.5" />
                Read to the rider
              </span>
              <span className="text-data text-xl font-bold tracking-[0.3em]">
                {o.pickupOtp}
              </span>
            </div>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="col-span-2 w-full"
            disabled={busy === o.id}
            onClick={() => onPatch(o, "cancelled")}
          >
            <X className="size-4" /> Cancel order
          </Button>
        </OrderCard>
      ))}
    </div>
  );
}

function HistoryOrderCard({
  order,
  statusTone,
}: {
  order: KitchenOrder;
  statusTone: "cancelled" | "done";
}) {
  const [open, setOpen] = useState(false);
  const first = order.lines[0];
  const title = orderTitle(order);
  const description =
    first?.description?.trim() ||
    `${order.customerProfile?.name ?? order.customer} · ${order.area}`;

  return (
    <article className="vendor-order-card flex h-full flex-col overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="press flex w-full items-start gap-3 p-3 text-left"
      >
        <ItemThumb src={first?.imageUrl} name={title} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-data text-xs font-semibold text-muted">
              {order.code}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                statusTone === "cancelled"
                  ? "bg-red-500/10 text-red-500"
                  : "bg-green/15 text-green"
              )}
            >
              {statusTone === "cancelled"
                ? "Cancelled"
                : statusLabel(order.status ?? "delivered")}
            </span>
            {/* Also here, not just on the live board: "was this one paid?" is
                the first question asked of a cancelled order, and the answer
                decides whether a refund is owed. */}
            <PaymentBadge order={order} />
          </div>
          <p className="mt-1 line-clamp-1 text-sm font-bold leading-snug">
            {title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted">{description}</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Clock className="size-3.5 shrink-0" />
              {order.placedAt || order.placedAgo}
            </span>
            <span className="text-data text-sm font-bold">
              {formatINR(order.total)}
            </span>
          </div>
        </div>
        <ChevronDown
          className={cn(
            "mt-1 size-4 shrink-0 text-muted transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open ? (
        <div className="border-t border-line px-3 pb-3">
          <div className="mt-3 flex gap-3 rounded-xl bg-surface-2 p-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent/15 text-sm font-bold text-accent">
              {order.customerProfile?.initials ??
                order.customer.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <User className="size-3.5 text-muted" />
                {order.customerProfile?.name ?? order.customer}
              </p>
              {order.customerProfile?.phone ? (
                <a
                  href={`tel:${order.customerProfile.phone.replace(/\s/g, "")}`}
                  className="flex items-center gap-1.5 text-sm text-accent"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Phone className="size-3.5" />
                  {order.customerProfile.phone}
                </a>
              ) : null}
              <p className="flex items-start gap-1.5 text-xs text-muted">
                <MapPin className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-2">{order.area}</span>
              </p>
            </div>
          </div>

          <ul className="mt-3 space-y-2">
            {order.lines.map((l, i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-xl border border-line bg-surface-2/60 p-2.5"
              >
                <ItemThumb src={l.imageUrl} name={l.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold leading-snug">
                      <span className="text-data text-accent">{l.qty}×</span>{" "}
                      {l.name}
                    </p>
                    <span className="text-data shrink-0 text-sm font-bold">
                      {formatINR(l.price * l.qty)}
                    </span>
                  </div>
                  {l.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">
                      {l.description}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function HistoryList({
  orders,
  empty,
  statusTone,
  onViewAll,
}: {
  orders: KitchenOrder[];
  empty: string;
  statusTone: "cancelled" | "done";
  onViewAll?: () => void;
}) {
  if (orders.length === 0) {
    return (
      <div className="space-y-3">
        <VendorEmptyState
          title="Nothing here yet"
          description={empty}
        />
        {onViewAll ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onViewAll}
          >
            <ExternalLink className="size-4" /> View full history
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {orders.map((o) => (
          <HistoryOrderCard key={o.id} order={o} statusTone={statusTone} />
        ))}
      </div>
      {onViewAll ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onViewAll}
        >
          <ExternalLink className="size-4" /> View all
        </Button>
      ) : null}
    </div>
  );
}

export function VendorOrdersBoard({
  initialIncoming,
  initialPreparing,
  initialReady = [],
  initialRecent = [],
  initialCancelled = [],
  live,
  restaurantName,
  pace,
  alertSoundPreset = "chime",
  alertSoundUrl = null,
}: {
  initialIncoming: KitchenOrder[];
  initialPreparing: KitchenOrder[];
  initialReady?: KitchenOrder[];
  initialRecent?: KitchenOrder[];
  initialCancelled?: KitchenOrder[];
  live: boolean;
  restaurantName?: string;
  /** Absent in demo mode, unsupported before migration 0036. */
  pace?: VendorPace;
  /** From platform_settings (0044) — same sound for every vendor. */
  alertSoundPreset?: string;
  alertSoundUrl?: string | null;
}) {
  const [incoming, setIncoming] = useState(initialIncoming);
  const [preparing, setPreparing] = useState(initialPreparing);
  const [ready, setReady] = useState(initialReady);
  const [recent, setRecent] = useState(initialRecent);
  const [cancelled, setCancelled] = useState(initialCancelled);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<OrderTab>("new");
  const [historyDialog, setHistoryDialog] = useState<
    null | "cancelled" | "completed"
  >(null);

  // When auto-refresh pulls fresh server data, adopt it as the source of truth
  // (new orders appear, accepted ones move) while keeping the local ready tally.
  //
  // Done during render, not in an effect: an effect would paint one frame of the
  // stale board before correcting itself, and a kitchen screen showing an order
  // that's already gone — even for a frame — is exactly the bug worth avoiding.
  const [adopted, setAdopted] = useState({
    initialIncoming,
    initialPreparing,
    initialRecent,
    initialCancelled,
  });
  if (
    live &&
    (adopted.initialIncoming !== initialIncoming ||
      adopted.initialPreparing !== initialPreparing ||
      adopted.initialRecent !== initialRecent ||
      adopted.initialCancelled !== initialCancelled)
  ) {
    setAdopted({
      initialIncoming,
      initialPreparing,
      initialRecent,
      initialCancelled,
    });
    setIncoming(initialIncoming);
    setPreparing(initialPreparing);
    setRecent(initialRecent);
    setCancelled(initialCancelled);
  }

  async function patchStatus(
    order: KitchenOrder,
    status: "kitchen" | "ready" | "cancelled"
  ) {
    if (status === "cancelled") {
      const label =
        order.status === "placed" || !order.status ? "Reject" : "Cancel";
      const ok = window.confirm(
        `${label} order ${order.code}? This cannot be undone from the board.`
      );
      if (!ok) return;
    }

    if (!live) {
      if (status === "kitchen") acceptLocal(order);
      else if (status === "cancelled") rejectLocal(order);
      else readyLocal(order);
      return;
    }

    setBusy(order.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setActionError(
          body?.error === "invalid_transition"
            ? "That status change is no longer valid. Refreshing…"
            : "Could not update order. Try again."
        );
        return;
      }

      if (status === "kitchen") acceptLocal(order);
      else if (status === "cancelled") rejectLocal(order);
      else readyLocal(order);
    } catch {
      setActionError("Network error. Check your connection.");
    } finally {
      setBusy(null);
    }
  }

  function acceptLocal(o: KitchenOrder) {
    setIncoming((prev) => prev.filter((x) => x.id !== o.id));
    // `acceptedAt` is left alone on purpose: the database stamps it from the
    // transition trigger, so the in-kitchen clock stays blank for the few
    // seconds until the next refresh brings back the real time rather than
    // starting from a guess made in the browser.
    setPreparing((prev) => [{ ...o, status: "kitchen" }, ...prev]);
    setMobileTab("prep");
  }
  function rejectLocal(o: KitchenOrder) {
    setIncoming((prev) => prev.filter((x) => x.id !== o.id));
    setPreparing((prev) => prev.filter((x) => x.id !== o.id));
    setReady((prev) => prev.filter((x) => x.id !== o.id));
    setCancelled((prev) => [{ ...o, status: "cancelled" }, ...prev]);
    setMobileTab("cancelled");
  }
  function readyLocal(o: KitchenOrder) {
    setPreparing((prev) => prev.filter((x) => x.id !== o.id));
    setReady((prev) => [{ ...o, status: "ready" }, ...prev]);
    setMobileTab("ready");
  }

  const mobileTabs: { id: OrderTab; label: string; count: number }[] = [
    { id: "new", label: "New", count: incoming.length },
    { id: "prep", label: "Prep", count: preparing.length },
    { id: "ready", label: "Ready", count: ready.length },
    ...(live
      ? [
          {
            id: "cancelled" as const,
            label: "Cancel",
            count: cancelled.length,
          },
          { id: "done" as const, label: "Done", count: recent.length },
        ]
      : []),
  ];

  return (
    <>
      {/* `whenHidden`: a kitchen tablet is usually on another tab or asleep,
          which is precisely when an unnoticed order does the most damage. */}
      {live ? <AutoRefresh interval={8000} whenHidden /> : null}

      <VendorHero
        live={live}
        tag={live ? "Live" : undefined}
        title="Live orders"
        subtitle={
          restaurantName
            ? `Managing ${restaurantName} — accept, prep, and hand off.`
            : "Your restaurant order board."
        }
      />

      {live ? (
        <KitchenAlert
          incomingIds={incoming.map((o) => o.id)}
          restaurantName={restaurantName}
          soundPreset={alertSoundPreset}
          soundUrl={alertSoundUrl}
        />
      ) : null}

      {live && pace?.supported ? (
        <KitchenBusyControl
          extraMinutes={pace.extraMinutes}
          until={pace.until}
        />
      ) : null}

      {actionError ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-600"
        >
          <p className="min-w-0">{actionError}</p>
          <button
            type="button"
            className="shrink-0 font-semibold underline"
            onClick={() => setActionError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:gap-3 @3xl:grid-cols-4">
        <VendorMetricCard
          label="New"
          value={String(incoming.length)}
        />
        <VendorMetricCard
          label="Preparing"
          value={String(preparing.length)}
        />
        <VendorMetricCard
          label="Ready"
          value={String(ready.length)}
        />
        <VendorMetricCard
          label="Cancelled"
          value={String(cancelled.length)}
        />
      </div>

      <div className="space-y-4 @3xl:hidden">
        <VendorSegmentedTabs
          tabs={mobileTabs}
          active={mobileTab}
          onChange={setMobileTab}
        />
        {mobileTab === "new" ? (
          <IncomingList orders={incoming} busy={busy} onPatch={patchStatus} />
        ) : null}
        {mobileTab === "prep" ? (
          <PreparingList orders={preparing} busy={busy} onPatch={patchStatus} />
        ) : null}
        {mobileTab === "ready" ? (
          <ReadyList orders={ready} busy={busy} onPatch={patchStatus} />
        ) : null}
        {mobileTab === "cancelled" && live ? (
          <HistoryList
            orders={cancelled}
            empty="Rejected orders stay here for your records."
            statusTone="cancelled"
            onViewAll={() => setHistoryDialog("cancelled")}
          />
        ) : null}
        {mobileTab === "done" && live ? (
          <HistoryList
            orders={recent}
            empty="No delivered orders yet."
            statusTone="done"
            onViewAll={() => setHistoryDialog("completed")}
          />
        ) : null}
      </div>

      <div className="hidden gap-4 @3xl:grid @3xl:grid-cols-3">
        <VendorKanbanColumn title="New orders" count={incoming.length} tone="accent">
          <IncomingList orders={incoming} busy={busy} onPatch={patchStatus} />
        </VendorKanbanColumn>
        <VendorKanbanColumn title="Preparing" count={preparing.length} tone="blue">
          <PreparingList orders={preparing} busy={busy} onPatch={patchStatus} />
        </VendorKanbanColumn>
        <VendorKanbanColumn title="Ready" count={ready.length} tone="green">
          <ReadyList orders={ready} busy={busy} onPatch={patchStatus} />
        </VendorKanbanColumn>
      </div>

      {live ? (
        <div className="hidden gap-4 @3xl:grid @3xl:grid-cols-2">
          <VendorPanel
            title="Cancelled"
            accent="red"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setHistoryDialog("cancelled")}
              >
                View all
              </Button>
            }
          >
            <HistoryList
              orders={cancelled}
              empty="Rejected orders stay in the database."
              statusTone="cancelled"
            />
          </VendorPanel>
          <VendorPanel
            title="Completed"
            accent="green"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setHistoryDialog("completed")}
              >
                View all
              </Button>
            }
          >
            <HistoryList
              orders={recent}
              empty="No delivered orders yet."
              statusTone="done"
            />
          </VendorPanel>
        </div>
      ) : null}

      {historyDialog ? (
        <VendorOrderHistoryDialog
          open
          kind={historyDialog}
          onClose={() => setHistoryDialog(null)}
        />
      ) : null}
    </>
  );
}
