"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Check,
  ClipboardList,
  LoaderCircle,
  MapPin,
  Minus,
  Phone,
  Plus,
  Search,
  Store,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, fieldCls } from "@/components/ui/field";
import { formatINR } from "@/lib/utils/format";
import { computeChargesWith } from "@/lib/pricing";
import { cn } from "@/lib/utils/cn";
import {
  lookupCallerAction,
  loadShopMenuAction,
  placePhoneOrderAction,
} from "@/app/manager/new-order/actions";
import type {
  CallerLookup,
  OrderableShop,
  ShopMenu,
} from "@/lib/data-access/manager-phone-orders";

/**
 * Taking an order down a phone line.
 *
 * The shape of this screen is set by the fact that someone is waiting on the
 * other end. Two consequences run through the whole component:
 *
 *   * **Nothing is hidden behind a step you have to finish.** The sections are
 *     numbered for order, not gated — a caller who names their dish before
 *     their address is normal, and a wizard that refuses to let you type it is
 *     the wizard's problem, not theirs.
 *   * **The total is always on screen.** "How much is that?" is the second
 *     question every caller asks, and it must never require a scroll.
 *
 * The arithmetic here is presentational. `placePhoneOrder` recomputes the bill
 * from the database's own prices and the live platform settings, so a stale
 * menu in this tab cannot mis-bill anyone — it can only show the operator a
 * number that the confirmation then corrects.
 */

export interface ComposerConfig {
  deliveryFee: number;
  taxRate: number;
  freeDeliveryThreshold: number;
  minOrder: number;
  /** The platform master switch. A warning here, not a block — see below. */
  acceptingOrders: boolean;
  maintenanceMessage: string;
}

interface Placed {
  code: string;
  total: number;
  customerCreated: boolean;
}

export function PhoneOrderComposer({
  shops,
  config,
  ready,
}: Readonly<{
  shops: OrderableShop[];
  config: ComposerConfig;
  ready: boolean;
}>) {
  // ---- caller ----
  const [phone, setPhone] = useState("");
  const [caller, setCaller] = useState<CallerLookup | null>(null);
  const [name, setName] = useState("");
  const [lookupBusy, startLookup] = useTransition();

  // ---- shop + menu ----
  const [slug, setSlug] = useState("");
  const [menu, setMenu] = useState<ShopMenu | null>(null);
  const [menuBusy, startMenu] = useTransition();
  const [query, setQuery] = useState("");

  // ---- basket ----
  const [qty, setQty] = useState<Record<string, number>>({});

  // ---- delivery ----
  const [addressLine, setAddressLine] = useState("");
  const [note, setNote] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [placing, startPlace] = useTransition();
  const [placed, setPlaced] = useState<Placed | null>(null);

  const lines = useMemo(
    () =>
      (menu?.items ?? [])
        .map((item) => ({ item, qty: qty[item.id] ?? 0 }))
        .filter((l) => l.qty > 0),
    [menu, qty]
  );

  const subtotal = lines.reduce((sum, l) => sum + l.item.price * l.qty, 0);
  const charges = computeChargesWith(config, subtotal, 0);

  const visible = useMemo(() => {
    const items = menu?.items ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)
    );
  }, [menu, query]);

  const shop = shops.find((s) => s.slug === slug) ?? null;

  const setQuantity = (id: string, next: number) =>
    setQty((prev) => {
      const copy = { ...prev };
      if (next <= 0) delete copy[id];
      else copy[id] = Math.min(next, 50);
      return copy;
    });

  const lookup = () => {
    startLookup(async () => {
      setError(null);
      setCaller(null);
      const result = await lookupCallerAction(phone);
      if (!result.ok || !result.caller) {
        setError(result.error ?? "Lookup failed.");
        return;
      }
      setCaller(result.caller);
      // Show the normalised number back, so a mistyped one is visible now
      // rather than after the order has gone to a stranger.
      setPhone(result.caller.phone);
      setName(result.caller.existing?.name ?? "");
    });
  };

  const chooseShop = (nextSlug: string) => {
    setSlug(nextSlug);
    setMenu(null);
    setQty({});
    setQuery("");
    if (!nextSlug) return;
    startMenu(async () => {
      setError(null);
      const result = await loadShopMenuAction(nextSlug);
      if (!result.ok || !result.menu) {
        setError(result.error ?? "Could not load that menu.");
        return;
      }
      setMenu(result.menu);
    });
  };

  const place = () => {
    // The caller must have been looked up: it is what turns what was typed into
    // a real number and shows the operator whose account is about to be used.
    if (!caller) {
      setError("Look the caller's number up first.");
      return;
    }
    if (!lines.length) {
      setError("Add at least one dish.");
      return;
    }
    if (!addressLine.trim()) {
      setError("Take the delivery address.");
      return;
    }

    startPlace(async () => {
      setError(null);
      const result = await placePhoneOrderAction({
        phone: caller.phone,
        customerName: name.trim() || undefined,
        restaurantSlug: slug,
        lines: lines.map((l) => ({ itemId: l.item.id, qty: l.qty })),
        address: { label: "Phone order", line: addressLine.trim() },
        note: note.trim() || undefined,
      });

      if (!result.ok) {
        setError(result.error ?? "That didn't go through.");
        return;
      }
      setPlaced({
        code: result.code ?? "",
        total: result.total ?? charges.total,
        customerCreated: Boolean(result.customerCreated),
      });
    });
  };

  const reset = () => {
    setPhone("");
    setCaller(null);
    setName("");
    setSlug("");
    setMenu(null);
    setQuery("");
    setQty({});
    setAddressLine("");
    setNote("");
    setError(null);
    setPlaced(null);
  };

  if (placed) return <Confirmation placed={placed} onAnother={reset} />;

  const blocked = !ready;
  const itemCount = lines.reduce((n, l) => n + l.qty, 0);
  const itemNoun = itemCount === 1 ? "item" : "items";

  return (
    <div className="space-y-4 pb-4">
      {/* The total rides along at the top of the scroll container: the caller
          asks for it constantly and it must never need a scroll to answer. */}
      <div className="sticky top-0 z-10 -mx-4 border-b border-line bg-bg/95 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-label">
              {lines.length ? `${itemCount} ${itemNoun}` : "No items yet"}
            </p>
            <p className="truncate text-xs text-muted">
              {caller
                ? `${name || "Caller"} · ${caller.phone}`
                : "Start with the caller's number"}
            </p>
          </div>
          <p className="text-data shrink-0 text-lg font-bold">
            {formatINR(charges.total)}
          </p>
        </div>
      </div>

      {blocked ? (
        <Banner tone="red">
          <strong className="font-semibold">
            This database can&apos;t record who took a phone order.
          </strong>{" "}
          Apply migration <code>0029_phone_orders.sql</code> to enable the desk.
          Orders are refused rather than saved without attribution.
        </Banner>
      ) : null}

      {!config.acceptingOrders ? (
        <Banner tone="amber">
          <strong className="font-semibold">The app is paused</strong> for new
          orders
          {config.maintenanceMessage ? ` — “${config.maintenanceMessage}”` : ""}.
          The desk still works: taking the call may be the point of the pause.
          Check with the kitchen before you promise a time.
        </Banner>
      ) : null}

      {/* ---------------- 1 · caller ---------------- */}
      <Step n={1} title="Who's calling" icon={Phone}>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label="Mobile number" required>
              <input
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setCaller(null);
                }}
                inputMode="tel"
                autoComplete="off"
                placeholder="98765 43210"
                className={fieldCls}
                disabled={blocked}
              />
            </Field>
          </div>
          <Button
            variant="secondary"
            onClick={lookup}
            disabled={blocked || lookupBusy || !phone.trim()}
            className="shrink-0"
          >
            {lookupBusy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Search className="size-4" />
            )}
            Look up
          </Button>
        </div>

        {caller?.existing ? (
          <div className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-green-600" />
            <p className="text-sm text-ink">
              {caller.existing.name ? (
                <>
                  Existing customer —{" "}
                  <strong className="font-semibold">
                    {caller.existing.name}
                  </strong>
                </>
              ) : (
                "Existing account, no name on file."
              )}
              {caller.existing.isStaff ? (
                <span className="mt-0.5 block text-xs text-muted">
                  Heads up: this number belongs to a staff account, not a
                  customer.
                </span>
              ) : null}
            </p>
          </div>
        ) : null}
        {caller && !caller.existing ? (
          <div className="flex items-start gap-2 rounded-xl bg-pop/10 px-3 py-2.5">
            <UserPlus className="mt-0.5 size-4 shrink-0 text-ink" />
            <p className="text-sm text-ink">
              New number — placing this order creates an account, so they can
              track it and sign in later with the same mobile.
            </p>
          </div>
        ) : null}

        {caller && !caller.existing?.name ? (
          <Field label="Name" hint="Optional. Used to greet them and label the order.">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Caller's name"
              className={fieldCls}
            />
          </Field>
        ) : null}
      </Step>

      {/* ---------------- 2 · restaurant ---------------- */}
      <Step n={2} title="Which restaurant" icon={Store}>
        <select
          value={slug}
          onChange={(e) => chooseShop(e.target.value)}
          disabled={blocked || menuBusy}
          className={cn(fieldCls, "appearance-none")}
          aria-label="Restaurant"
        >
          <option value="">Pick a restaurant…</option>
          {shops.map((s) => (
            <option key={s.slug} value={s.slug} disabled={!s.open}>
              {s.name}
              {s.open ? "" : " · closed"}
            </option>
          ))}
        </select>

        {menuBusy ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <LoaderCircle className="size-4 animate-spin" /> Loading the menu…
          </p>
        ) : null}

        {shop && !shop.open ? (
          <Banner tone="red">
            {shop.name} is closed and cannot take this order. Offer the caller
            another kitchen.
          </Banner>
        ) : null}
      </Step>

      {/* ---------------- 3 · dishes ---------------- */}
      <Step n={3} title="What they want" icon={ClipboardList}>
        {!menu ? (
          <p className="text-sm text-muted">Pick a restaurant to see its menu.</p>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${menu.items.length} dishes`}
                className={cn(fieldCls, "pl-9")}
                aria-label="Search the menu"
              />
            </div>

            {visible.length === 0 ? (
              <p className="py-3 text-center text-sm text-muted">
                Nothing matches “{query}”.
              </p>
            ) : (
              <ul className="-mx-1 max-h-80 space-y-0.5 overflow-y-auto px-1">
                {visible.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 rounded-xl px-1 py-2"
                  >
                    <span
                      className={cn(
                        "mt-0.5 size-3 shrink-0 rounded-sm border",
                        item.veg
                          ? "border-green-600 bg-green-600/20"
                          : "border-red-600 bg-red-600/20"
                      )}
                      aria-label={item.veg ? "Veg" : "Non-veg"}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">
                        {item.name}
                      </p>
                      <p className="text-xs text-muted">
                        {formatINR(item.price)} · {item.category}
                      </p>
                    </div>
                    <Stepper
                      value={qty[item.id] ?? 0}
                      onChange={(n) => setQuantity(item.id, n)}
                      label={item.name}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Step>

      {/* ---------------- 4 · address ---------------- */}
      <Step n={4} title="Where it goes" icon={MapPin}>
        <Field
          label="Delivery address"
          required
          hint="Say it back to the caller before you move on."
        >
          <textarea
            value={addressLine}
            onChange={(e) => setAddressLine(e.target.value)}
            rows={3}
            placeholder="House / shop, street, landmark, area"
            className={cn(fieldCls, "resize-none")}
            disabled={blocked}
          />
        </Field>
        <Field label="Note for the kitchen or rider" hint="Optional.">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Less spicy · call on arrival"
            className={fieldCls}
            disabled={blocked}
          />
        </Field>
      </Step>

      {/* ---------------- 5 · confirm ---------------- */}
      <Step n={5} title="Read it back" icon={Banknote}>
        {lines.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing added yet. The bill appears here as you add dishes.
          </p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {lines.map((l) => (
                <li key={l.item.id} className="flex justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-ink">
                    <span className="text-data font-semibold">{l.qty}×</span>{" "}
                    {l.item.name}
                  </span>
                  <span className="text-data shrink-0 text-muted">
                    {formatINR(l.item.price * l.qty)}
                  </span>
                </li>
              ))}
            </ul>

            <div className="space-y-1 border-t border-line pt-2.5 text-sm">
              <Row label="Item total" value={charges.subtotal} />
              <Row
                label="Delivery"
                value={charges.deliveryFee}
                free={charges.deliveryFee === 0}
              />
              <Row label="Taxes" value={charges.taxes} />
              <div className="flex justify-between pt-1 text-[15px] font-bold text-ink">
                <span>Total</span>
                <span className="text-data">{formatINR(charges.total)}</span>
              </div>
            </div>

            <p className="flex items-center gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-xs font-medium text-ink">
              <Banknote className="size-3.5 shrink-0" />
              Cash on delivery — the rider collects {formatINR(charges.total)} at
              the door.
            </p>

            {config.minOrder > 0 && charges.subtotal < config.minOrder ? (
              <Banner tone="amber">
                Below the {formatINR(config.minOrder)} minimum the app enforces.
                You can still place it — that call is yours.
              </Banner>
            ) : null}
          </>
        )}

        {error ? (
          <p className="flex items-start gap-1.5 text-sm font-medium text-red-600">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}

        <Button
          size="lg"
          onClick={place}
          disabled={blocked || placing || !caller || !lines.length}
          className="w-full"
        >
          {placing ? (
            <LoaderCircle className="size-5 animate-spin" />
          ) : (
            <Check className="size-5" />
          )}
          Place order · {formatINR(charges.total)}
        </Button>
      </Step>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Confirmation({
  placed,
  onAnother,
}: Readonly<{
  placed: Placed;
  onAnother: () => void;
}>) {
  return (
    <div className="pt-6">
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-8 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-green-500/15 text-green-600">
          <Check className="size-7" />
        </span>
        <p className="text-[17px] font-bold text-ink">Order placed</p>
        <p className="text-data text-2xl font-extrabold tracking-tight">
          {placed.code}
        </p>
        <p className="max-w-xs text-sm text-muted">
          Read the number back to the caller, then tell them{" "}
          <strong className="font-semibold text-ink">
            {formatINR(placed.total)} in cash
          </strong>{" "}
          at the door. The kitchen has been alerted.
        </p>
        {placed.customerCreated ? (
          <p className="max-w-xs rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">
            An account was created for their mobile — they can sign in with it
            to track this order.
          </p>
        ) : null}
      </div>

      <div className="mt-4 space-y-2">
        <Button size="lg" onClick={onAnother} className="w-full">
          <Phone className="size-5" />
          Take another order
        </Button>
        <Link href="/manager" className="block">
          <Button variant="secondary" size="lg" className="w-full">
            Back to the board
          </Button>
        </Link>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  icon: Icon,
  children,
}: Readonly<{
  n: number;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}>) {
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-surface p-3.5">
      <h2 className="flex items-center gap-2 text-[15px] font-bold text-ink">
        <span className="text-data grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-bold text-muted">
          {n}
        </span>
        <Icon className="size-4 shrink-0 text-muted" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Stepper({
  value,
  onChange,
  label,
}: Readonly<{
  value: number;
  onChange: (next: number) => void;
  label: string;
}>) {
  if (value === 0) {
    return (
      <button
        type="button"
        onClick={() => onChange(1)}
        aria-label={`Add ${label}`}
        className="tap-target press grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-ink hover:bg-line/60"
      >
        <Plus className="size-4" />
      </button>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1 rounded-full bg-surface-2 p-0.5">
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        aria-label={`One less ${label}`}
        className="press grid size-7 place-items-center rounded-full text-ink hover:bg-line/60"
      >
        <Minus className="size-3.5" />
      </button>
      <span className="text-data w-5 text-center text-sm font-bold">{value}</span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        aria-label={`One more ${label}`}
        className="press grid size-7 place-items-center rounded-full text-ink hover:bg-line/60"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function Row({
  label,
  value,
  free,
}: Readonly<{
  label: string;
  value: number;
  free?: boolean;
}>) {
  return (
    <div className="flex justify-between text-muted">
      <span>{label}</span>
      <span className={cn("text-data", free && "text-green-600")}>
        {free ? "Free" : formatINR(value)}
      </span>
    </div>
  );
}

function Banner({
  tone,
  children,
}: Readonly<{
  tone: "red" | "amber";
  children: React.ReactNode;
}>) {
  return (
    <p
      className={cn(
        "rounded-xl border px-3.5 py-3 text-sm",
        tone === "red"
          ? "border-red-500/25 bg-red-500/10 text-red-600"
          : "border-pop/40 bg-pop/10 text-ink"
      )}
    >
      {children}
    </p>
  );
}

/** Back to the live board — the operator's home. */
export function BackToBoard() {
  return (
    <Link
      href="/manager"
      className="press inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" />
      Board
    </Link>
  );
}
