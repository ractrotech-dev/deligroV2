"use client";

import { useEffect, useState } from "react";
import {
  Clock,
  MapPin,
  Phone,
  Search,
  User,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { PortalToShell } from "@/components/shared/portal-to-shell";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import type { KitchenOrder } from "@/lib/roles-data";
import type { VendorHistoryRange } from "@/types/vendor-orders";

type HistoryKind = "cancelled" | "completed";

const RANGE_OPTIONS: { id: VendorHistoryRange; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "this_month", label: "This month" },
  { id: "previous_month", label: "Previous month" },
  { id: "date", label: "Specific date" },
];

function ItemThumb({
  src,
  name,
}: {
  src?: string | null;
  name: string;
}) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className="size-12 shrink-0 rounded-xl object-cover"
      />
    );
  }
  return (
    <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-surface-2 text-lg">
      🍽️
    </span>
  );
}

function ArchiveOrderCard({
  order,
  kind,
}: {
  order: KitchenOrder;
  kind: HistoryKind;
}) {
  const first = order.lines[0];
  const title =
    order.lines.length === 0
      ? "Order"
      : order.lines.length === 1
        ? order.lines[0].name
        : `${order.lines[0].name} +${order.lines.length - 1} more`;

  return (
    <article className="rounded-xl border border-line bg-surface p-3">
      <div className="flex gap-3">
        <ItemThumb src={first?.imageUrl} name={title} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-data text-xs font-semibold text-muted">
              {order.code}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-bold uppercase",
                kind === "cancelled"
                  ? "bg-red-500/10 text-red-500"
                  : "bg-green/15 text-green"
              )}
            >
              {kind === "cancelled" ? "Cancelled" : "Completed"}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-1 text-sm font-bold">{title}</p>
          {first?.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted">
              {first.description}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <User className="size-3.5" />
              {order.customerProfile?.name ?? order.customer}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" />
              {order.placedAt}
            </span>
            <span className="text-data font-bold text-ink">
              {formatINR(order.total)}
            </span>
          </div>
        </div>
      </div>

      <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
        {order.lines.map((line, i) => (
          <li
            key={i}
            className="flex items-start justify-between gap-3 text-sm"
          >
            <span className="min-w-0">
              <span className="text-data text-accent">{line.qty}×</span> {line.name}
              {line.addons?.length ? (
                <span className="mt-0.5 block text-xs text-muted">+ {line.addons.join(", ")}</span>
              ) : null}
              {line.description ? (
                <span className="mt-0.5 block line-clamp-1 text-xs text-muted">
                  {line.description}
                </span>
              ) : null}
            </span>
            <span className="text-data shrink-0 font-semibold">
              {formatINR(line.price * line.qty)}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
        {order.customerProfile?.phone ? (
          <a
            href={`tel:${order.customerProfile.phone.replace(/\s/g, "")}`}
            className="inline-flex items-center gap-1 text-accent"
          >
            <Phone className="size-3.5" />
            {order.customerProfile.phone}
          </a>
        ) : null}
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-3.5" />
          {order.area}
        </span>
      </div>
    </article>
  );
}

export function VendorOrderHistoryDialog({
  open,
  kind,
  onClose,
}: {
  open: boolean;
  kind: HistoryKind;
  onClose: () => void;
}) {
  const [range, setRange] = useState<VendorHistoryRange>("all");
  const [date, setDate] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [total, setTotal] = useState(0);
  // Starts true so the spinner shows on open; the fetch flips it off once the
  // first result lands. Refetches keep the current list visible until fresh
  // data arrives (stale-while-revalidate) rather than flashing back to a spinner.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const title =
    kind === "cancelled" ? "All cancelled orders" : "All completed orders";

  // Load (and reload) history whenever the dialog opens or a filter changes.
  // Every setState runs after an await so nothing fires synchronously inside the
  // effect — the react-hooks lint rule flags synchronous effect setState.
  useEffect(() => {
    if (!open) return;
    let ignore = false;

    void (async () => {
      try {
        const params = new URLSearchParams({ kind, range, limit: "150" });
        if (range === "date" && date) params.set("date", date);
        if (query.trim()) params.set("search", query.trim());

        const res = await fetch(`/api/vendor/orders/history?${params}`);
        if (ignore) return;
        if (!res.ok) {
          setError("Could not load orders.");
          setOrders([]);
          setTotal(0);
          return;
        }
        const data = (await res.json()) as {
          orders: KitchenOrder[];
          total: number;
        };
        if (ignore) return;
        setOrders(data.orders ?? []);
        setTotal(data.total ?? 0);
        setError(null);
      } catch {
        if (!ignore) {
          setError("Could not load orders.");
          setOrders([]);
          setTotal(0);
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    })();

    return () => {
      ignore = true;
    };
  }, [open, kind, range, date, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <PortalToShell>
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-history-title"
        className="flex max-h-[92dvh] w-full max-w-3xl flex-col rounded-t-2xl bg-surface shadow-[var(--shadow-lg)] sm:max-h-[88vh] sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div>
            <h2 id="order-history-title" className="text-lg font-bold">
              {title}
            </h2>
            <p className="text-xs text-muted">
              {loading ? "Loading…" : `${orders.length} shown${total ? ` · ${total} matched` : ""}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press grid size-9 place-items-center rounded-full border border-line text-muted"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="no-scrollbar flex gap-2 overflow-x-auto pb-0.5">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRange(opt.id)}
                className={cn(
                  "press shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold",
                  range === opt.id
                    ? "border-accent bg-accent text-[var(--on-accent)]"
                    : "border-line bg-surface-2 text-muted"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {range === "date" ? (
            <DatePicker
              value={date}
              onChange={setDate}
              className="bg-surface-2"
            />
          ) : null}

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search);
            }}
          >
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
              <Search className="size-4 shrink-0 text-muted" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search order, customer, dish…"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
              />
            </label>
            <Button type="submit" size="sm" className="shrink-0">
              Search
            </Button>
          </form>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
          {error ? (
            <p className="rounded-xl bg-surface-2 p-4 text-sm text-muted">
              {error}
            </p>
          ) : loading ? (
            <p className="rounded-xl bg-surface-2 p-4 text-sm text-muted">
              Loading orders…
            </p>
          ) : orders.length === 0 ? (
            <p className="rounded-xl bg-surface-2 p-4 text-sm text-muted">
              No orders match these filters.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {orders.map((order) => (
                <ArchiveOrderCard key={order.id} order={order} kind={kind} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </PortalToShell>
  );
}
