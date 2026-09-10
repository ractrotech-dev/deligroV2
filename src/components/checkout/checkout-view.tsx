"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  ShoppingBag,
  MapPin,
  AlertTriangle,
  Trash2,
  Bike,
  Banknote,
  CreditCard,
} from "lucide-react";
import { useCart } from "@/stores/cart-store";
import { ACTIVE_ORDER } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { EmptyState } from "@/components/shared/empty-state";
import { MapPicker } from "@/components/location/map-picker";
import { Button } from "@/components/ui/button";
import { AddAddressForm } from "@/components/addresses/add-address-form";
import { AddressPickerSheet } from "@/components/addresses/address-picker-sheet";
import { useSavedAddresses } from "@/hooks/use-saved-addresses";
import { cn } from "@/lib/utils/cn";
import { formatINR } from "@/lib/utils/format";
import { computeChargesWith, TIP_OPTIONS } from "@/lib/pricing";
import {
  blocksOrder,
  outOfRangeMessage,
  type ServiceArea,
} from "@/lib/geo/service-area";
import {
  openRazorpayCheckout,
  RazorpayDismissedError,
} from "@/lib/payments/razorpay-checkout";
import {
  codLimitHint,
  DEFAULT_PAYMENT_RULES,
  paymentAvailability,
  type VendorPaymentRules,
} from "@/lib/payments/cod-rules";
import type { PaymentMethod } from "@/types";

type CheckoutStatus = "ready" | "processing" | "paying" | "placed";

/** Live platform config from the Admin Settings tab — the same values billed. */
export interface CheckoutConfig {
  deliveryFee: number;
  taxRate: number;
  freeDeliveryThreshold: number;
  minOrder: number;
  acceptingOrders: boolean;
  maintenanceMessage: string;
  /**
   * Whether online payment is actually on offer — the admin toggle AND the
   * Razorpay keys, resolved server-side. False renders the option as
   * "Available soon" and leaves COD as the only choice, which is the state the
   * feature ships in.
   */
  onlinePayments: boolean;
}

export function CheckoutView({ config }: { config: CheckoutConfig }) {
  const router = useRouter();
  const lines = useCart((s) => s.lines);
  const restaurantSlug = useCart((s) => s.restaurantSlug);
  const restaurantName = useCart((s) => s.restaurantName);
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const clear = useCart((s) => s.clear);

  // One id for this whole checkout visit, minted lazily on the first submit
  // attempt and reused on every retry of it — a slow network the customer
  // re-taps through, or a request the browser retries after a timeout — so
  // the server can tell "this is the same submit again" from "a new order".
  // See createOrder's idempotencyKey handling.
  const idempotencyKeyRef = useRef<string | null>(null);
  const getIdempotencyKey = () => {
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return idempotencyKeyRef.current;
  };

  const {
    addresses,
    loading: addrLoading,
    selectedId,
    setSelectedId,
    selected: selectedAddress,
    create: createAddress,
    update: updateAddress,
  } = useSavedAddresses();

  const [showPicker, setShowPicker] = useState(false);
  // Asked for explicitly ("Add another address", or a failed place-order). With
  // no address saved at all the form is the only thing to show — and it offers
  // no Cancel in that state — so that case is derived rather than stored: state
  // that duplicates a fact already in `addresses` can only drift from it.
  const [addFormRequested, setAddFormRequested] = useState(false);
  const [mapCoords, setMapCoords] = useState<{ lat: number; lng: number } | null>(
    null
  );
  const [pinBusy, setPinBusy] = useState(false);
  const [pinSaved, setPinSaved] = useState(false);

  const [apartment, setApartment] = useState("");
  const [entryCode, setEntryCode] = useState("");
  const [floor, setFloor] = useState("");
  const [buildingName, setBuildingName] = useState("");
  const [courierInstructions, setCourierInstructions] = useState("");

  const [tip, setTip] = useState(0);

  // COD is the only method until the server says otherwise. Never initialised
  // from the config: an admin turning payments off mid-session must not leave a
  // stale "online" selection that the order API will refuse.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cod");

  // One definition of what an order costs, from the live platform settings the
  // server bills with — so the quote here equals the charge.
  const charges = computeChargesWith(config, subtotal, tip);
  const [status, setStatus] = useState<CheckoutStatus>("ready");
  const [error, setError] = useState<string | null>(null);

  const showAddForm =
    addFormRequested || (!addrLoading && addresses.length === 0);

  // ---- coupon ----
  // `pricedAt` is the subtotal the discount was quoted against. If the basket
  // moves afterwards the quote is stale — a percentage is simply wrong, and a
  // flat code may no longer clear its minimum — so the code is dropped rather
  // than silently re-used at a number nobody calculated.
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<{
    code: string;
    discount: number;
    pricedAt: number;
    /** The shop it was priced for — a scoped code doesn't travel (0041). */
    pricedFor: string | null;
  } | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);

  if (coupon && coupon.pricedAt !== subtotal) {
    setCoupon(null);
    setCouponError("Your basket changed — apply the code again.");
  } else if (coupon && coupon.pricedFor !== restaurantSlug) {
    // Switching restaurants empties the basket, so this is nearly always
    // caught by the subtotal check above — nearly, because two shops can
    // total the same. A code scoped to the shop it was priced for would
    // otherwise be shown as applied at a shop that will refuse it.
    setCoupon(null);
    setCouponError("You're ordering from a different restaurant — apply the code again.");
  }

  const discount = coupon?.discount ?? 0;
  // After tax, not before it. The server bills the same way; see migration 0031
  // for why the discount is subtractive on the grand total rather than folded
  // into the taxable base.
  const payTotal = Math.max(0, charges.total - discount);

  // ---- what this shop takes ----
  // Which methods are on offer is a per-vendor fact, and the basket only knows
  // its restaurant on the client, so it is fetched rather than passed in.
  // Starts permissive-but-platform-bounded so the options do not flicker: the
  // order API re-checks every rule anyway, so being briefly optimistic here
  // costs a clear error message, never a wrong charge.
  const [vendorRules, setVendorRules] = useState<VendorPaymentRules>({
    ...DEFAULT_PAYMENT_RULES,
    acceptOnline: config.onlinePayments,
  });

  useEffect(() => {
    if (!restaurantSlug || !isSupabaseConfigured) return;
    let live = true;
    fetch(`/api/restaurants/${encodeURIComponent(restaurantSlug)}/payment-options`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { rules?: VendorPaymentRules } | null) => {
        if (live && d?.rules) setVendorRules(d.rules);
      })
      .catch(() => {
        // Leave the optimistic default in place. The server is the gate.
      });
    return () => {
      live = false;
    };
  }, [restaurantSlug]);

  // Measured against what the customer will actually hand over — after the
  // coupon, including delivery and tax. That is the cash the rider collects.
  const availability = paymentAvailability(vendorRules, payTotal);
  const codHint = codLimitHint(vendorRules, payTotal);

  // The selection is a request; this is what it resolves to. Deriving it (rather
  // than "fixing" paymentMethod in an effect) is what stops the basket crossing
  // the cash ceiling and leaving a stale COD selection behind: add one more
  // item and the order becomes an online one on the same render.
  const payOnline = availability.online && !availability.cod
    ? true
    : availability.online && paymentMethod === "online";

  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code) return;
    // Nothing to price a scoped code against. Unreachable from the UI — the
    // checkout only renders with a basket — but the request would be rejected
    // as invalid input rather than saying why.
    if (!restaurantSlug) {
      setCouponError("Add something to your basket first.");
      return;
    }
    setCouponBusy(true);
    setCouponError(null);
    try {
      const res = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, subtotal, restaurantSlug }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setCouponError(couponMessage(data.error, data.minOrder));
        return;
      }
      setCoupon({
        code: data.code,
        discount: data.discount,
        pricedAt: subtotal,
        pricedFor: restaurantSlug,
      });
      setCouponInput("");
    } catch {
      setCouponError("Couldn't check that code. Try again.");
    } finally {
      setCouponBusy(false);
    }
  };

  // Availability gates: the platform can be paused, or a minimum can apply.
  const belowMinimum = config.minOrder > 0 && subtotal < config.minOrder;
  const shortBy = config.minOrder - subtotal;
  const ordersClosed = !config.acceptingOrders;
  // A shop with cash switched off and online unavailable can take nothing. The
  // button is disabled rather than left to fail at the API, because "Could not
  // place the order" after filling in an address is a worse way to learn it.
  const checkoutBlocked = ordersClosed || belowMinimum || availability.noMethod;

  // Move the map pin onto whichever address the customer picked. Adjusted during
  // render rather than in an effect, so the map never paints a frame still
  // showing the previous address's pin.
  //
  // Keyed on the address id, not the object: saving a pin re-fetches the list
  // and hands back a new object for the same address, and re-running on that
  // would wipe the "Saved" confirmation the customer just earned.
  const addressId = selectedAddress?.id ?? null;
  const [syncedAddressId, setSyncedAddressId] = useState(addressId);
  if (addressId !== syncedAddressId) {
    setSyncedAddressId(addressId);
    if (selectedAddress) {
      if (selectedAddress.lat != null && selectedAddress.lng != null) {
        setMapCoords({ lat: selectedAddress.lat, lng: selectedAddress.lng });
      }
      setPinSaved(false);
    }
  }

  const pinMoved =
    selectedAddress &&
    mapCoords &&
    (selectedAddress.lat !== mapCoords.lat || selectedAddress.lng !== mapCoords.lng);

  // Is this pin inside the shop's delivery area?
  //
  // This replaces `Boolean(selectedAddress) && !mapCoords`, which was labelled
  // "you're a bit far away" and measured nothing of the kind: it fired when the
  // address had NO coordinates, and stayed silent for an address 40 km away
  // that had them — telling the wrong customers they were far away and the
  // genuinely-distant ones nothing at all.
  //
  // Advisory. `/api/orders` re-runs the same `checkServiceArea` against the
  // address actually submitted and refuses the order there.
  // Stored against the pin it was measured for, and read back only when the two
  // still match. That is what makes moving the pin drop the previous answer
  // without an effect having to clear it — a stale "out of range" left on screen
  // for a pin the customer has already corrected is the one failure mode here.
  const areaKey = mapCoords ? `${mapCoords.lat},${mapCoords.lng}` : null;
  const [measured, setMeasured] = useState<{
    key: string;
    area: ServiceArea;
  } | null>(null);
  const serviceArea =
    measured && measured.key === areaKey ? measured.area : null;

  useEffect(() => {
    if (!restaurantSlug || !isSupabaseConfigured || !areaKey || !mapCoords) {
      return;
    }
    let live = true;
    const query = new URLSearchParams({
      lat: String(mapCoords.lat),
      lng: String(mapCoords.lng),
    });
    fetch(
      `/api/restaurants/${encodeURIComponent(restaurantSlug)}/serviceability?${query}`
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { area?: ServiceArea } | null) => {
        if (live && d?.area) setMeasured({ key: areaKey, area: d.area });
      })
      .catch(() => {
        // Can't check ≠ out of range. Leave it unmeasured and say nothing; the
        // order API is the gate that decides.
      });
    return () => {
      live = false;
    };
  }, [restaurantSlug, areaKey, mapCoords]);

  // `blocksOrder`, the same predicate `createOrder` refuses on — not a second
  // copy of the rule. This screen and that gate disagreeing is how a customer
  // fills in an address, taps Place order, and is told no.
  const outOfArea = serviceArea ? blocksOrder(serviceArea) : false;
  // An address with no pin is not "far away" — it is unmeasurable, and the fix
  // is one the customer can act on, so that is what the notice asks for.
  const addressUnpinned = Boolean(selectedAddress) && !mapCoords;

  // Everything that stops this basket being placed, in one value. Out-of-area
  // joins the pre-existing gates for the same stated reason: learning it from
  // "Could not place the order" after filling in an address is a worse way to
  // find out. An unverifiable area now blocks here too, because it blocks
  // server-side — see `checkServiceArea`.
  const orderBlocked = checkoutBlocked || outOfArea;

  async function savePinToAddress() {
    if (!selectedAddress || !mapCoords) return;
    setPinBusy(true);
    setError(null);
    try {
      await updateAddress(selectedAddress.id, {
        lat: mapCoords.lat,
        lng: mapCoords.lng,
      });
      setPinSaved(true);
    } catch {
      setError("Could not save pin to your address.");
    } finally {
      setPinBusy(false);
    }
  }

  function clearCart() {
    clear();
    router.back();
  }

  /**
   * Take payment for an order that already exists and is already priced.
   *
   * Returns true only once the server has verified the signature. Anything else
   * — dismissal, gateway failure, a signature that doesn't check out — leaves
   * the order in place and unpaid, which is the honest outcome: the customer
   * can retry from the order screen, and the kitchen doesn't see it meanwhile.
   */
  async function payForOrder(orderId: string): Promise<boolean> {
    const openRes = await fetch("/api/payments/razorpay/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    });
    const handoff = (await openRes.json()) as {
      keyId?: string;
      providerOrderId?: string;
      amountPaise?: number;
      currency?: string;
      error?: string;
    };

    if (!openRes.ok || !handoff.keyId || !handoff.providerOrderId) {
      setError(
        handoff.error === "payments_unavailable"
          ? "Online payment isn't available right now — your order is saved, pay cash on delivery or retry from your orders."
          : "Couldn't start the payment. Your order is saved — you can retry from your orders."
      );
      return false;
    }

    const result = await openRazorpayCheckout({
      keyId: handoff.keyId,
      providerOrderId: handoff.providerOrderId,
      amountPaise: handoff.amountPaise ?? 0,
      currency: handoff.currency ?? "INR",
      name: restaurantName ?? "Deligro",
      description: `Order ${orderId.slice(0, 8)}`,
    });

    const verifyRes = await fetch("/api/payments/razorpay/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        razorpayOrderId: result.razorpayOrderId,
        razorpayPaymentId: result.razorpayPaymentId,
        signature: result.signature,
      }),
    });

    if (!verifyRes.ok) {
      // The money may still have left their account — Razorpay's webhook is the
      // authority and will settle it. Say so rather than claiming failure.
      setError(
        "We couldn't confirm the payment yet. If you were charged, your order will update shortly."
      );
      return false;
    }

    return true;
  }

  const placeOrder = async () => {
    setError(null);

    if (ordersClosed) {
      setError(
        config.maintenanceMessage.trim() ||
          "We're not accepting orders right now. Please try again shortly."
      );
      return;
    }
    if (belowMinimum) {
      setError(
        `Add ${formatINR(shortBy)} more to reach the ${formatINR(
          config.minOrder
        )} minimum order.`
      );
      return;
    }
    if (availability.notice && !availability.cod && !availability.online) {
      setError(availability.notice);
      return;
    }
    if (outOfArea && serviceArea) {
      setError(outOfRangeMessage(serviceArea));
      return;
    }
    if (!selectedAddress) {
      setError("Add a delivery address to continue.");
      setAddFormRequested(true);
      return;
    }

    setStatus("processing");

    if (isSupabaseConfigured) {
      if (!restaurantSlug) {
        setError("Missing restaurant — go back and add items again.");
        setStatus("ready");
        return;
      }

      try {
        const res = await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            restaurantSlug,
            lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty })),
            idempotencyKey: getIdempotencyKey(),
            // The tip is money: the server re-derives the total including it,
            // rather than us telling it what to charge.
            tip,
            // A request, not an instruction — the server re-checks that online
            // payment is on offer and refuses the order if it isn't.
            paymentMethod: payOnline ? "online" : "cod",
            // The code only. What it is worth is re-derived server-side from
            // the order's own items, so the quote above is a preview.
            couponCode: coupon?.code,
            address: {
              label: selectedAddress.label,
              line: [
                selectedAddress.line,
                apartment.trim(),
                entryCode.trim() && `Entry ${entryCode.trim()}`,
                floor.trim() && `Floor ${floor.trim()}`,
                buildingName.trim(),
                courierInstructions.trim(),
              ]
                .filter(Boolean)
                .join(", "),
              lat: mapCoords?.lat ?? selectedAddress.lat,
              lng: mapCoords?.lng ?? selectedAddress.lng,
            },
          }),
        });

        if (res.status === 401) {
          router.push("/login?next=/checkout");
          setStatus("ready");
          return;
        }

        const data = (await res.json()) as {
          order?: { id: string };
          error?: string;
          message?: string;
        };
        if (!res.ok || !data.order?.id) {
          // The server re-prices the coupon against the order it is about to
          // write, so it can refuse one the preview accepted — the code lapsed
          // in between, or another device used the last redemption. Nothing was
          // created; drop the code, say why, and let them place it again.
          if (data.error?.startsWith("coupon_")) {
            const reason = data.error.slice("coupon_".length);
            setCoupon(null);
            setCouponError(couponMessage(reason, config.minOrder));
            setError("Your promo code was refused. Check the total and try again.");
            setStatus("ready");
            return;
          }
          // A payment refusal arrives with its own sentence, because the cash
          // ceiling is per shop and only the server knows the number. Show it
          // verbatim rather than paraphrasing it into something vaguer.
          if (data.message) {
            setError(data.message);
            setStatus("ready");
            return;
          }
          setError(
            data.error === "invalid_items"
              ? "Something in your cart is no longer available."
              : data.error === "tip_unsupported"
                ? "Tipping isn't available right now — set the tip to “No tip” to place your order."
                : data.error === "online_payments_unavailable"
                  ? "Online payment isn't available yet — switch to Cash on delivery to place your order."
                  : "Could not place the order. Try again."
          );
          setStatus("ready");
          return;
        }

        // The order exists and is priced; now collect the money for it. An
        // unpaid online order stays off the kitchen board until it settles.
        if (payOnline) {
          setStatus("paying");
          try {
            const paid = await payForOrder(data.order.id);
            if (!paid) {
              // payForOrder has already explained what happened. The cart is
              // kept so nothing is lost if they want to start over.
              setStatus("ready");
              return;
            }
          } catch (err) {
            setError(
              err instanceof RazorpayDismissedError
                ? "Payment cancelled — your order is saved and unpaid. Retry from your orders."
                : "The payment didn't go through. Your order is saved — you can retry from your orders."
            );
            setStatus("ready");
            return;
          }
        }

        setStatus("placed");
        clear();
        router.push(`/orders/${data.order.id}?placed=1`);
        return;
      } catch {
        setError("Network error — check your connection and try again.");
        setStatus("ready");
        return;
      }
    }

    // Demo mode only — `isSupabaseConfigured` is false, which cannot happen in a
    // production build (supabase/config.ts throws at boot). Nothing is placed,
    // charged or recorded; this walks to the mock tracking screen so the flow can
    // be shown end to end.
    //
    // The 1400ms `setTimeout` that used to wrap this is gone. It existed to
    // simulate a network round trip — a fake "Placing your order…" spinner over
    // a call that never happened, which is the one part of a demo that should
    // not be pretending.
    setStatus("placed");
    clear();
    router.push(`/orders/${ACTIVE_ORDER.id}?placed=1&demo=1`);
  };

  if (lines.length === 0 && status !== "placed") {
    return (
      <>
        <CheckoutHeader title="Checkout" onBack={() => router.back()} />
        <EmptyState
          className="mt-10"
          icon={<ShoppingBag className="size-7" />}
          title="Your cart is empty"
          description="Add a few dishes and they'll show up here, ready to check out."
          action={
            <Link href="/">
              <Button>Browse restaurants</Button>
            </Link>
          }
        />
      </>
    );
  }

  return (
    <div className="relative flex min-h-full flex-1 flex-col">
      <CheckoutHeader
        title={restaurantName ?? "Checkout"}
        onBack={() => router.back()}
        onClear={clearCart}
      />

      <div className="flex-1 space-y-3 px-4 pb-4 pt-3">
        <section className="card overflow-hidden">
          {addrLoading ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Loading your addresses…
            </p>
          ) : showAddForm ? (
            <>
              <div className="border-b border-line px-4 py-3">
                <h2 className="text-[15px] font-bold">
                  {addresses.length ? "Add delivery address" : "Set delivery address"}
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  Search on the map or enter your full address.
                </p>
              </div>
              <AddAddressForm
                compact
                onSave={async (input) => {
                  await createAddress(input);
                  setAddFormRequested(false);
                }}
                onCancel={
                  addresses.length
                    ? () => setAddFormRequested(false)
                    : undefined
                }
              />
            </>
          ) : selectedAddress ? (
            <>
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                className="press flex w-full items-center gap-3 border-b border-line px-4 py-3.5 text-left"
              >
                <MapPin className="size-5 shrink-0 text-ink" strokeWidth={2.25} />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                    {selectedAddress.label}
                    {selectedAddress.isDefault ? " · Default" : ""}
                  </span>
                  <span className="mt-0.5 block text-[15px] font-medium leading-snug">
                    {selectedAddress.line}
                  </span>
                </span>
                <ChevronRight className="size-5 shrink-0 text-muted" />
              </button>

              {outOfArea && serviceArea ? (
                <div className="flex items-start gap-2.5 border-b border-line bg-deal-soft px-4 py-3 text-sm font-medium text-deal">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{outOfRangeMessage(serviceArea)}</span>
                </div>
              ) : addressUnpinned ? (
                <div className="flex items-start gap-2.5 border-b border-line bg-surface-2 px-4 py-3 text-sm font-medium text-muted">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    This address has no map pin, so we can&apos;t check it&apos;s
                    in the delivery area. Drop a pin below.
                  </span>
                </div>
              ) : null}

              <div className="space-y-3 p-4">
                <MapPicker
                  key={selectedId}
                  variant="checkout"
                  initial={mapCoords}
                  onPick={({ lat, lng }) => {
                    setMapCoords({ lat, lng });
                    setPinSaved(false);
                  }}
                />

                {pinMoved ? (
                  <button
                    type="button"
                    onClick={savePinToAddress}
                    disabled={pinBusy}
                    className="press w-full rounded-xl border border-accent bg-accent-soft py-2.5 text-sm font-bold text-accent-ink disabled:opacity-60"
                  >
                    {pinBusy ? (
                      <Loader2 className="mx-auto size-4 animate-spin" />
                    ) : pinSaved ? (
                      "Pin saved to address"
                    ) : (
                      "Save pin to this address"
                    )}
                  </button>
                ) : null}

                <CheckoutField
                  placeholder="Apartment, flat or suite number"
                  value={apartment}
                  onChange={setApartment}
                />

                <div className="grid grid-cols-2 gap-3">
                  <CheckoutField
                    placeholder="Entry code"
                    value={entryCode}
                    onChange={setEntryCode}
                  />
                  <CheckoutField
                    placeholder="Floor"
                    value={floor}
                    onChange={setFloor}
                  />
                </div>

                <CheckoutField
                  label="Building name"
                  placeholder="Building name"
                  value={buildingName}
                  onChange={setBuildingName}
                />

                <CheckoutField
                  label="Instructions for the courier"
                  placeholder="Instructions for the courier"
                  value={courierInstructions}
                  onChange={setCourierInstructions}
                />

                <Link
                  href="/profile/addresses"
                  className="block text-center text-sm font-semibold text-accent-ink"
                >
                  Manage saved addresses
                </Link>
              </div>
            </>
          ) : null}
        </section>

        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-bold">Payment</h2>
            <p className="mt-0.5 text-xs text-muted">
              {availability.cod && availability.online
                ? "Pay now by UPI or card, or pay the courier on delivery."
                : availability.online
                  ? "Pay now by UPI, card, netbanking or wallet."
                  : availability.cod
                    ? "Pay the courier in cash when your order arrives."
                    : "Payment is not available for this shop right now."}
            </p>
          </div>
          <div className="space-y-2 p-4">
            {/* The one line that has to be plain English: it tells the customer
                what to do, not what went wrong. */}
            {availability.notice ? (
              <p className="rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-2.5 text-[13px] font-medium leading-snug text-accent-ink">
                {availability.notice}
              </p>
            ) : null}
            <PaymentOption
              icon={<Banknote className="size-5" />}
              label="Cash on delivery"
              desc={
                availability.codRefusal === "over_limit"
                  ? "Not available for this amount."
                  : codHint ?? "Pay the courier when your order arrives."
              }
              selected={availability.cod && !payOnline}
              // Genuinely disabled, not merely styled that way — and the order
              // API refuses a cash order over the ceiling regardless.
              disabled={!availability.cod}
              badge={
                availability.codRefusal === "over_limit"
                  ? "Over cash limit"
                  : availability.codRefusal === "cod_off"
                    ? "Not accepted"
                    : undefined
              }
              onSelect={() => setPaymentMethod("cod")}
            />
            <PaymentOption
              icon={<CreditCard className="size-5" />}
              label="Pay online"
              desc="UPI, cards, netbanking and wallets."
              selected={payOnline}
              disabled={!availability.online}
              badge={
                availability.online
                  ? undefined
                  : config.onlinePayments
                    ? "Not accepted"
                    : "Available soon"
              }
              onSelect={() => setPaymentMethod("online")}
            />
          </div>
        </section>

        <section className="card p-4">
          <div className="flex gap-4">
            <div className="grid size-20 shrink-0 place-items-center rounded-2xl bg-accent-soft">
              <Bike className="size-9 text-accent-ink" strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <h2 className="text-[17px] font-extrabold tracking-tight">
                Tip the courier?
              </h2>
              <p className="mt-1 text-sm leading-snug text-muted">
                The courier will get 100% of your tip. You can cancel the tip
                later.
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {TIP_OPTIONS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTip(t)}
                className={cn(
                  "press bolt-chip min-w-[72px] justify-center",
                  tip === t && "bolt-chip-on"
                )}
              >
                {t === 0 ? "No tip" : formatINR(t)}
              </button>
            ))}
          </div>
        </section>

        <section className="card p-4">
          <h2 className="text-[15px] font-bold">Have a code?</h2>
          {coupon ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-green-soft px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-data truncate text-sm font-bold text-green">
                  {coupon.code}
                </p>
                <p className="text-xs text-muted">
                  {formatINR(coupon.discount)} off your food
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCoupon(null);
                  setCouponError(null);
                }}
                className="press shrink-0 text-sm font-semibold text-muted hover:text-ink"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <input
                value={couponInput}
                onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void applyCoupon();
                  }
                }}
                placeholder="Promo code"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                aria-label="Promo code"
                className="text-data min-w-0 flex-1 rounded-xl bg-surface-2 px-3.5 py-3 text-[15px] uppercase tracking-wide text-ink outline-none focus:ring-2 focus:ring-accent/30"
              />
              <Button
                variant="secondary"
                onClick={applyCoupon}
                disabled={couponBusy || !couponInput.trim()}
                className="shrink-0"
              >
                {couponBusy ? <Loader2 className="size-4 animate-spin" /> : null}
                Apply
              </Button>
            </div>
          )}
          {couponError ? (
            <p className="mt-2 text-sm font-medium text-deal">{couponError}</p>
          ) : null}

          {/* The bill, itemised. It only became worth showing once a line could
              come *off* it — a discount the customer cannot see applied is
              indistinguishable from one that silently didn't. */}
          <div className="mt-4 space-y-1 border-t border-line pt-3 text-sm">
            <BillRow label="Item total" value={charges.subtotal} />
            <BillRow
              label="Delivery"
              value={charges.deliveryFee}
              free={charges.deliveryFee === 0}
            />
            <BillRow label="Taxes" value={charges.taxes} />
            {charges.tip > 0 ? (
              <BillRow label="Courier tip" value={charges.tip} />
            ) : null}
            {discount > 0 ? (
              <div className="flex justify-between font-medium text-green">
                <span>Discount · {coupon?.code}</span>
                <span className="text-data">−{formatINR(discount)}</span>
              </div>
            ) : null}
            <div className="flex justify-between pt-1.5 text-[15px] font-bold text-ink">
              <span>To pay</span>
              <span className="text-data">{formatINR(payTotal)}</span>
            </div>
          </div>
        </section>

        {error ? (
          <p className="text-center text-sm text-deal">{error}</p>
        ) : null}
      </div>

      {/* `.screen-dock`, not `.glass`: the page ground and a fade, so the screen
          reads as one sheet rather than a header slab, a content slab and a
          button slab. It pays the home-indicator inset itself. */}
      <div className="screen-dock sticky bottom-0 z-20 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
        {ordersClosed ? (
          <p className="mb-2 flex items-center gap-1.5 text-center text-sm font-medium text-deal">
            <AlertTriangle className="size-4 shrink-0" />
            {config.maintenanceMessage.trim() ||
              "We're not accepting orders right now."}
          </p>
        ) : belowMinimum ? (
          <p className="mb-2 text-center text-sm font-medium text-muted">
            Add {formatINR(shortBy)} more to reach the{" "}
            {formatINR(config.minOrder)} minimum.
          </p>
        ) : availability.noMethod ? (
          <p className="mb-2 flex items-center gap-1.5 text-center text-sm font-medium text-deal">
            <AlertTriangle className="size-4 shrink-0" />
            This shop cannot take payment right now.
          </p>
        ) : null}
        <button
          onClick={placeOrder}
          disabled={status !== "ready" || orderBlocked}
          className="press flex h-12 w-full items-center justify-between rounded-full bg-accent px-5 text-[16px] font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)] disabled:opacity-70"
        >
          {status === "processing" ? (
            <span className="mx-auto flex items-center gap-2">
              <Loader2 className="size-5 animate-spin" /> Placing order…
            </span>
          ) : status === "paying" ? (
            <span className="mx-auto flex items-center gap-2">
              <Loader2 className="size-5 animate-spin" /> Waiting for payment…
            </span>
          ) : ordersClosed ? (
            <span className="mx-auto">Orders paused</span>
          ) : (
            <>
              <span>{payOnline ? "Pay & place order" : "Place order"}</span>
              <span>{formatINR(payTotal)}</span>
            </>
          )}
        </button>
      </div>

      <AddressPickerSheet
        open={showPicker}
        addresses={addresses}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onClose={() => setShowPicker(false)}
        onAddNew={() => setAddFormRequested(true)}
      />
    </div>
  );
}

/**
 * One vocabulary for coupon refusals, shared by the "apply" button and the
 * place-order response — the server can refuse at either moment (the basket is
 * re-priced at submit) and the customer should read the same sentence either
 * way. Keys match the RPC's error strings, with the `coupon_` prefix the order
 * API adds stripped by the caller.
 */
function BillRow({
  label,
  value,
  free,
}: {
  label: string;
  value: number;
  free?: boolean;
}) {
  return (
    <div className="flex justify-between text-muted">
      <span>{label}</span>
      <span className={cn("text-data", free && "text-green")}>
        {free ? "Free" : formatINR(value)}
      </span>
    </div>
  );
}

function couponMessage(error?: string, minOrder?: number): string {
  switch (error) {
    case "invalid":
      return "That code isn't recognised.";
    case "expired":
      return "That code has expired.";
    case "min_order":
      return minOrder
        ? `Spend ${formatINR(minOrder)} on food to use this code.`
        : "Your basket is below this code's minimum.";
    case "wrong_restaurant":
      return "That code doesn't work at this restaurant.";
    case "already_used":
      return "You've already used this code.";
    case "exhausted":
      return "This code has been fully claimed.";
    case "already_applied":
      return "A code is already applied to this order.";
    case "order_not_open":
      return "This order has moved on — the code can't be added now.";
    case "empty":
      return "Enter a code first.";
    default:
      return "That code couldn't be applied.";
  }
}

function PaymentOption({
  icon,
  label,
  desc,
  selected,
  disabled,
  badge,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
  selected: boolean;
  disabled?: boolean;
  badge?: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors",
        disabled
          ? "cursor-not-allowed border-line bg-surface-2 opacity-60"
          : "cursor-pointer",
        selected && !disabled
          ? "border-accent bg-accent-soft"
          : "border-line bg-surface-2"
      )}
    >
      <input
        type="radio"
        name="paymentMethod"
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span
        className={cn(
          "mt-0.5 shrink-0",
          selected && !disabled ? "text-accent-ink" : "text-muted"
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{label}</span>
          {badge ? (
            <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{desc}</span>
      </span>
      <span
        className={cn(
          "mt-1 grid size-[18px] shrink-0 place-items-center rounded-full border-2",
          selected && !disabled ? "border-accent" : "border-line"
        )}
        aria-hidden
      >
        {selected && !disabled ? (
          <span className="size-2 rounded-full bg-accent" />
        ) : null}
      </span>
    </label>
  );
}

function CheckoutHeader({
  title,
  onBack,
  onClear,
}: {
  title: string;
  onBack: () => void;
  onClear?: () => void;
}) {
  return (
    <header className="app-header sticky top-0 z-20 flex items-center gap-3 px-4 py-3">
      <button
        onClick={onBack}
        aria-label="Go back"
        className="press grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink"
      >
        <ChevronLeft className="size-5" />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-center text-[17px] font-extrabold leading-tight tracking-tight">
        {title}
      </h1>
      {onClear ? (
        <button
          onClick={onClear}
          aria-label="Clear cart"
          className="press grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink"
        >
          <Trash2 className="size-[18px]" />
        </button>
      ) : (
        <span className="size-10 shrink-0" aria-hidden />
      )}
    </header>
  );
}

function CheckoutField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label?: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      {label ? (
        <span className="mb-1.5 block text-xs font-medium text-muted">
          {label}
        </span>
      ) : null}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label ? undefined : placeholder}
        className="w-full rounded-xl bg-surface-2 px-3.5 py-3 text-[15px] text-ink outline-none placeholder:text-muted focus:ring-2 focus:ring-accent/30"
      />
    </label>
  );
}
