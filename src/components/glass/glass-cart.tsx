"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShoppingBag, X, ChevronRight } from "lucide-react";
import { useCart } from "@/stores/cart-store";
import { useUI } from "@/stores/ui-store";
import { QtyStepper } from "@/components/shared/qty-stepper";
import { VegMark } from "@/components/shared/veg-mark";
import { formatINR } from "@/lib/utils/format";
import { computeChargesWith } from "@/lib/pricing";
import { useChargesConfig } from "@/components/providers/charges-config-provider";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

const HIDDEN_ON = new Set(["/checkout"]);

export function GlassCart() {
  const pathname = usePathname();
  const t = useT();

  const lines = useCart((s) => s.lines);
  const restaurantName = useCart((s) => s.restaurantName);
  const restaurantSlug = useCart((s) => s.restaurantSlug);
  const setQty = useCart((s) => s.setQty);
  const clear = useCart((s) => s.clear);
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  // The live platform settings — the same fee, tax rate and free-delivery
  // threshold checkout quotes and `createOrder` bills. This used to use
  // the pricing.ts *defaults*: an admin who moved the fee off ₹29, or set a
  // threshold, got a basket total that disagreed with the one the customer was
  // charged a tap later.
  const charges = computeChargesWith(useChargesConfig(), subtotal);
  const { deliveryFee, taxes, total } = charges;

  const cartOpen = useUI((s) => s.cartOpen);
  const openCart = useUI((s) => s.openCart);
  const closeCart = useUI((s) => s.closeCart);

  useEffect(() => {
    closeCart();
  }, [pathname, closeCart]);

  if (HIDDEN_ON.has(pathname)) return null;
  if (count === 0) return null;

  return (
    <>
      {!cartOpen && (
        // A div, not a button: the dismiss control is a button of its own and
        // nesting one inside another is invalid. The bottom offset is not here
        // but on `.bolt-basket-bar`, which reads --tabbar-h — the tab bar grows
        // by the home-indicator inset on a real handset, and a utility class
        // can't express that.
        <div className="bolt-basket-bar animate-slide-up absolute inset-x-3 z-30">
          <button
            onClick={openCart}
            className="press flex min-w-0 flex-1 items-center gap-2.5 text-left"
          >
            <span className="relative grid size-10 shrink-0 place-items-center rounded-xl bg-white/20">
              <ShoppingBag className="size-5" />
              <span className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-ink text-[11px] font-bold text-bg">
                {count}
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold">
                {t("View basket", "टोकरी देखें")}
              </span>
              <span className="block truncate text-xs font-semibold">
                {restaurantName} · {formatINR(subtotal)}
              </span>
            </span>
            <ChevronRight className="size-5 shrink-0" />
          </button>

          {/* Clear sits on the card's top-right corner, outside it, drawn
              small (22px) so it reads as a dismiss chip and not a second
              action. The ::before grows the touch area up and outward only —
              away from the bar, so a thumb aiming at "View basket" can't
              empty the basket by accident. */}
          <button
            onClick={clear}
            aria-label={t("Clear basket", "टोकरी खाली करें")}
            className="press absolute -right-2 -top-2 grid size-[22px] place-items-center rounded-full border border-line bg-surface text-muted shadow-[var(--shadow-sm)] before:absolute before:-left-2 before:-right-3 before:-top-3 before:bottom-0 before:content-['']"
          >
            <X className="size-3" strokeWidth={3} />
          </button>
        </div>
      )}

      {cartOpen && (
        <div className="absolute inset-0 z-40">
          <button
            aria-label={t("Close basket", "टोकरी बंद करें")}
            onClick={closeCart}
            className="animate-fade-in absolute inset-0 bg-ink/40"
          />
          <div className="bolt-sheet animate-sheet-in absolute inset-x-0 bottom-0 max-h-[86%] overflow-hidden">
            <div className="bolt-sheet-handle" />
            <div className="flex items-center justify-between px-5 pb-2 pt-3">
              <div>
                <h2 className="text-heading">
                  {t("Your basket", "आपकी टोकरी")}
                </h2>
                <p className="text-sm text-muted">{restaurantName}</p>
              </div>
              <button
                onClick={closeCart}
                aria-label={t("Close", "बंद करें")}
                className="press grid size-9 place-items-center rounded-full bg-surface-2 text-muted"
              >
                <X className="size-5" />
              </button>
            </div>

            {restaurantSlug ? (
              <div className="px-5 pb-2">
                <Link
                  href={`/restaurant/${restaurantSlug}`}
                  onClick={() => closeCart()}
                  className="bolt-section-link"
                >
                  {t("Add more items", "और सामान जोड़ें")}{" "}
                  <ChevronRight className="size-4" />
                </Link>
              </div>
            ) : null}

            <div className="no-scrollbar max-h-[42vh] overflow-y-auto px-5">
              <ul className="divide-y divide-line">
                {lines.map((l) => (
                  <li key={l.itemId} className="flex items-center gap-3 py-3.5">
                    <VegMark veg={l.veg} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold">
                        {l.name}
                      </p>
                      <p className="text-data text-muted">
                        {formatINR(l.price)}
                      </p>
                    </div>
                    <QtyStepper
                      size="sm"
                      qty={l.qty}
                      onAdd={() => setQty(l.itemId, 1)}
                      onInc={() => setQty(l.itemId, l.qty + 1)}
                      onDec={() => setQty(l.itemId, l.qty - 1)}
                    />
                    <span className="w-16 shrink-0 text-right text-data font-semibold">
                      {formatINR(l.price * l.qty)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-1 space-y-2 border-t border-dashed border-line py-4 text-[15px]">
                <Row
                  label={t("Subtotal", "सामान का दाम")}
                  value={formatINR(subtotal)}
                  muted
                />
                {/* "Free", not "₹0" — a basket that has cleared the admin's
                    free-delivery threshold is the one case this row exists to
                    tell the customer about. */}
                <Row
                  label={t("Delivery", "डिलीवरी")}
                  value={
                    deliveryFee === 0
                      ? t("Free", "मुफ़्त")
                      : formatINR(deliveryFee)
                  }
                  muted
                />
                <Row
                  label={t("Taxes", "टैक्स")}
                  value={formatINR(taxes)}
                  muted
                />
                <Row label={t("Total", "कुल")} value={formatINR(total)} bold />
              </div>
            </div>

            <div className="border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <Link
                href="/checkout"
                onClick={() => closeCart()}
                className="press flex h-12 items-center justify-between rounded-full bg-accent px-5 font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)]"
              >
                <span>{t("Go to checkout", "ऑर्डर करने जाएं")}</span>
                <span className="flex items-center gap-1">
                  {formatINR(total)} <ChevronRight className="size-5" />
                </span>
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Row({
  label,
  value,
  muted,
  bold,
}: Readonly<{
  label: string;
  value: string;
  muted?: boolean;
  bold?: boolean;
}>) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn(muted && "text-muted", bold && "font-bold")}>
        {label}
      </span>
      <span
        className={cn(
          "text-data",
          muted && "text-muted",
          bold && "text-base font-bold",
        )}
      >
        {value}
      </span>
    </div>
  );
}
