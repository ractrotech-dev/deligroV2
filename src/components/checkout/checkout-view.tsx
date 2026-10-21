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
  NotebookPen,
  X,
} from "lucide-react";
import { useCart } from "@/stores/cart-store";
import { ACTIVE_ORDER } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { EmptyState } from "@/components/shared/empty-state";
import { DeliveryMapScreen } from "@/components/checkout/delivery-map-screen";
import { Button } from "@/components/ui/button";
import { AddAddressForm } from "@/components/addresses/add-address-form";
import { AddressPickerSheet } from "@/components/addresses/address-picker-sheet";
import { useSavedAddresses } from "@/hooks/use-saved-addresses";
import { cn } from "@/lib/utils/cn";
import { addressLocality } from "@/lib/utils/address-locality";
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
  type PaymentAvailability,
  type VendorPaymentRules,
} from "@/lib/payments/cod-rules";
import { useLang, useT } from "@/components/providers/lang-provider";
import type { T } from "@/lib/i18n/lang";
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

export function CheckoutView({ config }: Readonly<{ config: CheckoutConfig }>) {
  const router = useRouter();
  const { lang, t } = useLang();
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
      // `randomUUID` exists only in a secure context; `getRandomValues` also
      // works on a plain-HTTP LAN preview, so the fallback stays unguessable.
      idempotencyKeyRef.current =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
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
  const [mapCoords, setMapCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  // The pin screen and the flat/floor/instructions sheet: both are opened from
  // the page rather than sitting on it, which keeps checkout short.
  const [showMap, setShowMap] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  // What the map reverse-geocoded a moved pin to — shown instead of the saved
  // line while the two differ, so the address never describes the wrong spot.
  const [pinLine, setPinLine] = useState<string | null>(null);
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
    setCouponError(
      t(
        "Your basket changed — apply the code again.",
        "आपकी टोकरी बदल गई है — कोड फिर से लगाएं।",
      ),
    );
  } else if (coupon && coupon.pricedFor !== restaurantSlug) {
    // Switching restaurants empties the basket, so this is nearly always
    // caught by the subtotal check above — nearly, because two shops can
    // total the same. A code scoped to the shop it was priced for would
    // otherwise be shown as applied at a shop that will refuse it.
    setCoupon(null);
    setCouponError(
      t(
        "You're ordering from a different restaurant — apply the code again.",
        "आप दूसरे रेस्टोरेंट से ऑर्डर कर रहे हैं — कोड फिर से लगाएं।",
      ),
    );
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
    fetch(
      `/api/restaurants/${encodeURIComponent(restaurantSlug)}/payment-options`,
    )
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
  // The same facts as `availability.notice` / `codHint`, in the customer's
  // language. The rules decide; these only word the outcome.
  const codLimit = formatINR(Math.max(0, Math.round(vendorRules.codMaxOrder)));
  const paymentNotice = paymentNoticeText(availability, codLimit, t);
  const codHintText = codHint
    ? t(
        `Cash on delivery is available up to ${codLimit}.`,
        `${codLimit} तक कैश ऑन डिलीवरी उपलब्ध है।`,
      )
    : null;

  // The selection is a request; this is what it resolves to. Deriving it (rather
  // than "fixing" paymentMethod in an effect) is what stops the basket crossing
  // the cash ceiling and leaving a stale COD selection behind: add one more
  // item and the order becomes an online one on the same render.
  const payOnline =
    availability.online && !availability.cod
      ? true
      : availability.online && paymentMethod === "online";

  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code) return;
    // Nothing to price a scoped code against. Unreachable from the UI — the
    // checkout only renders with a basket — but the request would be rejected
    // as invalid input rather than saying why.
    if (!restaurantSlug) {
      setCouponError(
        t("Add something to your basket first.", "पहले टोकरी में कुछ जोड़ें।"),
      );
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
        setCouponError(couponMessage(t, data.error, data.minOrder));
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
      setCouponError(
        t(
          "Couldn't check that code. Try again.",
          "कोड जांच नहीं पाए। फिर से कोशिश करें।",
        ),
      );
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
      // An address without a pin starts WITHOUT one. Keeping the previous
      // address's coordinates here let a pinless "Bhilai" inherit a Bemetara
      // pin: the area check measured the old pin, passed, and the order was sent
      // with those coordinates too.
      setMapCoords(
        selectedAddress.lat != null && selectedAddress.lng != null
          ? { lat: selectedAddress.lat, lng: selectedAddress.lng }
          : null,
      );
      setPinSaved(false);
      setPinLine(null);
    }
  }

  const detailsSummary = [
    apartment,
    floor && t(`Floor ${floor}`, `मंज़िल ${floor}`),
    buildingName,
    entryCode && t(`Gate ${entryCode}`, `गेट ${entryCode}`),
    courierInstructions,
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .join(", ");

  const pinMoved =
    selectedAddress &&
    mapCoords &&
    (selectedAddress.lat !== mapCoords.lat ||
      selectedAddress.lng !== mapCoords.lng);

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
  // `area: null` records a check that could not be made (network) — the order
  // API still decides then, but the button is no longer waiting on it.
  const [measured, setMeasured] = useState<{
    key: string;
    area: ServiceArea | null;
  } | null>(null);
  const measuredNow = measured?.key === areaKey ? measured : null;
  const serviceArea = measuredNow?.area ?? null;

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
      `/api/restaurants/${encodeURIComponent(restaurantSlug)}/serviceability?${query}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { area?: ServiceArea } | null) => {
        if (live) setMeasured({ key: areaKey, area: d?.area ?? null });
      })
      .catch(() => {
        // Can't check ≠ out of range. Say nothing; the order API is the gate
        // that decides — but stop holding the button for an answer.
        if (live) setMeasured({ key: areaKey, area: null });
      });
    return () => {
      live = false;
    };
  }, [restaurantSlug, areaKey, mapCoords]);

  // `blocksOrder`, the same predicate `createOrder` refuses on — not a second
  // copy of the rule. This screen and that gate disagreeing is how a customer
  // fills in an address, taps Place order, and is told no.
  const outOfArea = serviceArea ? blocksOrder(serviceArea) : false;

  /**
   * The default address is outside this shop's area, but another saved one
   * isn't: switch to it, once, and say so.
   *
   * Checkout used to pre-select the DEFAULT address unconditionally. In the
   * 28 Sept live test that was a Bhilai home 59.8 km from a Bemetara shop
   * while the same account had a deliverable Berla address saved — so the
   * customer met a blocked button and had to find the picker themselves.
   *
   * Only before the customer has chosen: a deliberate pick is never
   * overridden. Uses the same serviceability endpoint and `blocksOrder` as the
   * check above, so the switch can't land on an address the order API refuses.
   * The selection lives in memory only — the saved default is not changed.
   */
  const userPickedAddress = useRef(false);
  const autoPickTried = useRef(false);
  const [autoPicked, setAutoPicked] = useState<string | null>(null);
  const pickAddress = (id: string) => {
    userPickedAddress.current = true;
    setAutoPicked(null);
    setSelectedId(id);
  };
  useEffect(() => {
    if (!outOfArea || !restaurantSlug || autoPickTried.current) return;
    if (userPickedAddress.current) return;
    autoPickTried.current = true;
    const others = addresses.filter(
      (a) => a.id !== selectedAddress?.id && a.lat != null && a.lng != null,
    );
    if (others.length === 0) return;
    let live = true;
    void (async () => {
      for (const a of others) {
        const query = new URLSearchParams({
          lat: String(a.lat),
          lng: String(a.lng),
        });
        const d = (await fetch(
          `/api/restaurants/${encodeURIComponent(restaurantSlug)}/serviceability?${query}`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)) as { area?: ServiceArea } | null;
        if (!live || userPickedAddress.current) return;
        if (d?.area && !blocksOrder(d.area)) {
          // Label AND area: two saved addresses are often both "Home".
          const area = addressLocality(a.line);
          setAutoPicked(area ? `${a.label} · ${area}` : a.label);
          setSelectedId(a.id);
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [
    outOfArea,
    restaurantSlug,
    addresses,
    selectedAddress?.id,
    setSelectedId,
  ]);
  // An address with no pin is not "far away" — it is unmeasurable, and the fix
  // is one the customer can act on, so that is what the notice asks for.
  //
  // It BLOCKS, because the order API refuses a pinless address at every radius
  // (`checkServiceArea`). It used to be a grey hint with the button still live.
  // Only with a backend: the demo build has no gate and may have no map.
  const addressUnpinned =
    isSupabaseConfigured && Boolean(selectedAddress) && !mapCoords;
  // The pin is set but its area answer hasn't come back yet. Held rather than
  // waved through, so a far pin can't be ordered in the gap before the warning.
  const areaPending =
    isSupabaseConfigured &&
    Boolean(restaurantSlug) &&
    Boolean(mapCoords) &&
    !measuredNow;

  // Everything that stops this basket being placed, in one value. Out-of-area
  // joins the pre-existing gates for the same stated reason: learning it from
  // "Could not place the order" after filling in an address is a worse way to
  // find out. An unverifiable area now blocks here too, because it blocks
  // server-side — see `checkServiceArea`.
  const orderBlocked =
    checkoutBlocked || outOfArea || addressUnpinned || areaPending;

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
      setError(
        t(
          "Could not save pin to your address.",
          "पिन आपके पते में सेव नहीं हो पाया।",
        ),
      );
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
          ? t(
              "Online payment isn't available right now — your order is saved, pay cash on delivery or retry from your orders.",
              "अभी ऑनलाइन भुगतान उपलब्ध नहीं है — आपका ऑर्डर सेव है, डिलीवरी पर नकद दें या ‘मेरे ऑर्डर’ से फिर कोशिश करें।",
            )
          : t(
              "Couldn't start the payment. Your order is saved — you can retry from your orders.",
              "भुगतान शुरू नहीं हो पाया। आपका ऑर्डर सेव है — ‘मेरे ऑर्डर’ से फिर कोशिश कर सकते हैं।",
            ),
      );
      return false;
    }

    const result = await openRazorpayCheckout({
      keyId: handoff.keyId,
      providerOrderId: handoff.providerOrderId,
      amountPaise: handoff.amountPaise ?? 0,
      currency: handoff.currency ?? "INR",
      name: restaurantName ?? "Deligro",
      description: t(
        `Order ${orderId.slice(0, 8)}`,
        `ऑर्डर ${orderId.slice(0, 8)}`,
      ),
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
        t(
          "We couldn't confirm the payment yet. If you were charged, your order will update shortly.",
          "भुगतान अभी पक्का नहीं हो पाया। अगर पैसे कट गए हैं, तो आपका ऑर्डर जल्द अपडेट हो जाएगा।",
        ),
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
          t(
            "We're not accepting orders right now. Please try again shortly.",
            "अभी ऑर्डर नहीं लिए जा रहे हैं। कृपया थोड़ी देर बाद कोशिश करें।",
          ),
      );
      return;
    }
    if (belowMinimum) {
      setError(
        t(
          `Add ${formatINR(shortBy)} more to reach the ${formatINR(
            config.minOrder,
          )} minimum order.`,
          `कम से कम ${formatINR(config.minOrder)} का ऑर्डर ज़रूरी है — ${formatINR(
            shortBy,
          )} का और जोड़ें।`,
        ),
      );
      return;
    }
    if (availability.notice && !availability.cod && !availability.online) {
      setError(paymentNotice ?? availability.notice);
      return;
    }
    if (outOfArea && serviceArea) {
      setError(outOfRangeMessage(serviceArea, lang));
      return;
    }
    if (addressUnpinned) {
      setError(
        t(
          'Put your address on the map first — drop a pin or tap "Use my location".',
          'पहले अपना पता नक्शे पर लगाएं — पिन लगाएं या "मेरी लोकेशन लें" दबाएं।',
        ),
      );
      return;
    }
    if (!selectedAddress) {
      setError(
        t(
          "Add a delivery address to continue.",
          "आगे बढ़ने के लिए डिलीवरी का पता जोड़ें।",
        ),
      );
      setAddFormRequested(true);
      return;
    }

    setStatus("processing");

    if (isSupabaseConfigured) {
      if (!restaurantSlug) {
        setError(
          t(
            "Missing restaurant — go back and add items again.",
            "रेस्टोरेंट नहीं मिला — वापस जाकर आइटम फिर से जोड़ें।",
          ),
        );
        setStatus("ready");
        return;
      }

      try {
        const res = await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            restaurantSlug,
            lines: lines.map((l) => ({
              itemId: l.itemId,
              qty: l.qty,
              // The server re-prices the chosen size and add-ons itself.
              ...(l.variantId ? { variantId: l.variantId } : {}),
              ...(l.addonIds?.length ? { addonIds: l.addonIds } : {}),
            })),
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
            setCouponError(couponMessage(t, reason, config.minOrder));
            setError(
              t(
                "Your promo code was refused. Check the total and try again.",
                "आपका कूपन कोड नहीं लगा। कुल रकम देखकर फिर से कोशिश करें।",
              ),
            );
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
          setError(placeOrderErrorMessage(t, data.error));
          setStatus("ready");
          return;
        }

        // The order exists the moment the server says so, whether or not the
        // payment below goes through ("your order is saved and unpaid"). Drop
        // the router's reusable copies of /orders and Home now, or a customer
        // who looked at Orders a few seconds ago taps it and sees a list
        // without the order they just placed.
        router.refresh();

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
                ? t(
                    "Payment cancelled — your order is saved and unpaid. Retry from your orders.",
                    "भुगतान रद्द हो गया — आपका ऑर्डर सेव है, पर भुगतान बाकी है। ‘मेरे ऑर्डर’ से फिर कोशिश करें।",
                  )
                : t(
                    "The payment didn't go through. Your order is saved — you can retry from your orders.",
                    "भुगतान नहीं हो पाया। आपका ऑर्डर सेव है — ‘मेरे ऑर्डर’ से फिर कोशिश कर सकते हैं।",
                  ),
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
        setError(
          t(
            "Network error — check your connection and try again.",
            "नेटवर्क की दिक्कत — इंटरनेट देखकर फिर से कोशिश करें।",
          ),
        );
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
        <CheckoutHeader
          title={t("Checkout", "ऑर्डर पूरा करें")}
          onBack={() => router.back()}
        />
        <EmptyState
          className="mt-10"
          icon={<ShoppingBag className="size-7" />}
          title={t("Your cart is empty", "आपकी टोकरी खाली है")}
          description={t(
            "Add a few dishes and they'll show up here, ready to check out.",
            "कुछ खाना जोड़ें, वह यहां दिखेगा और आप ऑर्डर कर पाएंगे।",
          )}
          action={
            <Link href="/">
              <Button>{t("Browse restaurants", "रेस्टोरेंट देखें")}</Button>
            </Link>
          }
        />
      </>
    );
  }

  // The address card: still loading, the add form, or the chosen address.
  function addressCard() {
    if (addrLoading) {
      return (
        <p className="flex items-center gap-2 p-4 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" />{" "}
          {t("Loading your addresses…", "आपके पते लोड हो रहे हैं…")}
        </p>
      );
    }
    if (showAddForm) {
      return (
        <>
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-bold">
              {addresses.length
                ? t("Add delivery address", "डिलीवरी का पता जोड़ें")
                : t("Set delivery address", "डिलीवरी का पता डालें")}
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              {t(
                "Search on the map or enter your full address.",
                "नक्शे पर खोजें या अपना पूरा पता लिखें।",
              )}
            </p>
          </div>
          <AddAddressForm
            compact
            onSave={async (input) => {
              await createAddress(input);
              setAddFormRequested(false);
            }}
            onCancel={
              addresses.length ? () => setAddFormRequested(false) : undefined
            }
          />
        </>
      );
    }
    if (selectedAddress) {
      return (
        <>
          {autoPicked && !outOfArea ? (
            <div className="flex items-start gap-2.5 border-b border-line bg-green-soft px-4 py-3 text-sm font-medium text-ink">
              <MapPin className="mt-0.5 size-4 shrink-0 text-green" />
              <span>
                {t(
                  `Your default address is outside this shop's delivery area, so we picked your saved “${autoPicked}” address. Tap Change below to pick another.`,
                  `आपका डिफ़ॉल्ट पता इस दुकान के डिलीवरी क्षेत्र से बाहर है, इसलिए आपका सेव पता “${autoPicked}” चुना गया। दूसरा चुनने के लिए नीचे “बदलें” दबाएं।`,
                )}
              </span>
            </div>
          ) : null}
          {addressNotice()}

          <button
            type="button"
            onClick={() => setShowDetails(true)}
            className="press flex w-full items-center gap-3 px-4 py-3.5 text-left"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink">
              <NotebookPen className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold">
                {t("Delivery instructions", "डिलीवरी के निर्देश")}
              </span>
              <span className="block truncate text-xs text-muted">
                {detailsSummary ||
                  t(
                    "Flat, floor, landmark. Optional.",
                    "मकान, मंज़िल, पास की पहचान। ज़रूरी नहीं।",
                  )}
              </span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-muted" />
          </button>
        </>
      );
    }
    return null;
  }

  // Why the chosen address can't be delivered to, when it can't.
  function addressNotice() {
    if (outOfArea && serviceArea) {
      return (
        <div className="flex items-start gap-2.5 border-b border-line bg-deal-soft px-4 py-3 text-sm font-medium text-deal">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{outOfRangeMessage(serviceArea, lang)}</span>
        </div>
      );
    }
    if (addressUnpinned) {
      return (
        <div className="flex items-start gap-2.5 border-b border-line bg-deal-soft px-4 py-3 text-sm font-medium text-deal">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {t(
              "This address is not on the map yet, so we can't check we deliver there.",
              "यह पता अभी नक्शे पर नहीं है, इसलिए हम देख नहीं पा रहे कि वहां डिलीवरी होती है या नहीं।",
            )}{" "}
            <button
              type="button"
              onClick={() => setShowMap(true)}
              className="press font-bold underline"
            >
              {t("Set pin", "पिन लगाएं")}
            </button>
          </span>
        </div>
      );
    }
    return null;
  }

  // What stops this basket being placed, said above the button.
  function blockedNotice() {
    if (ordersClosed) {
      return (
        <p className="mb-2 flex items-center gap-1.5 text-center text-sm font-medium text-deal">
          <AlertTriangle className="size-4 shrink-0" />
          {config.maintenanceMessage.trim() ||
            t(
              "We're not accepting orders right now.",
              "अभी ऑर्डर नहीं लिए जा रहे हैं।",
            )}
        </p>
      );
    }
    if (belowMinimum) {
      return (
        <p className="mb-2 text-center text-sm font-medium text-muted">
          {t(
            `Add ${formatINR(shortBy)} more to reach the ${formatINR(config.minOrder)} minimum.`,
            `कम से कम ${formatINR(config.minOrder)} का ऑर्डर ज़रूरी है — ${formatINR(shortBy)} का और जोड़ें।`,
          )}
        </p>
      );
    }
    if (availability.noMethod) {
      return (
        <p className="mb-2 flex items-center gap-1.5 text-center text-sm font-medium text-deal">
          <AlertTriangle className="size-4 shrink-0" />
          {t(
            "This shop cannot take payment right now.",
            "यह दुकान अभी भुगतान नहीं ले पा रही है।",
          )}
        </p>
      );
    }
    if (outOfArea) {
      return (
        <p className="mb-2 flex items-center justify-center gap-1.5 text-center text-sm font-medium text-deal">
          <AlertTriangle className="size-4 shrink-0" />
          {t(
            "We don't deliver to this address.",
            "इस पते पर हम डिलीवरी नहीं करते।",
          )}
        </p>
      );
    }
    if (addressUnpinned) {
      return (
        <p className="mb-2 flex items-center justify-center gap-1.5 text-center text-sm font-medium text-deal">
          <AlertTriangle className="size-4 shrink-0" />
          {t(
            "Set your address on the map to order.",
            "ऑर्डर करने के लिए अपना पता नक्शे पर लगाएं।",
          )}
        </p>
      );
    }
    return null;
  }

  // The place-order button's label for the current state.
  function placeOrderLabel() {
    if (status === "processing") {
      return (
        <span className="mx-auto flex items-center gap-2">
          <Loader2 className="size-5 animate-spin" />{" "}
          {t("Placing order…", "ऑर्डर हो रहा है…")}
        </span>
      );
    }
    if (status === "paying") {
      return (
        <span className="mx-auto flex items-center gap-2">
          <Loader2 className="size-5 animate-spin" />{" "}
          {t("Waiting for payment…", "भुगतान का इंतज़ार…")}
        </span>
      );
    }
    if (ordersClosed) {
      return (
        <span className="mx-auto">
          {t("Orders paused", "ऑर्डर अभी बंद हैं")}
        </span>
      );
    }
    if (outOfArea) {
      return (
        <span className="mx-auto">
          {t("Outside delivery area", "डिलीवरी क्षेत्र से बाहर")}
        </span>
      );
    }
    if (areaPending) {
      return (
        <span className="mx-auto flex items-center gap-2">
          <Loader2 className="size-5 animate-spin" />{" "}
          {t("Checking delivery area…", "डिलीवरी क्षेत्र जांच रहे हैं…")}
        </span>
      );
    }
    return (
      <>
        <span>
          {payOnline
            ? t("Pay & place order", "भुगतान करें और ऑर्डर करें")
            : t("Place order", "ऑर्डर करें")}
        </span>
        <span>{formatINR(payTotal)}</span>
      </>
    );
  }

  return (
    <div className="relative flex min-h-full flex-1 flex-col">
      <CheckoutHeader
        title={restaurantName ?? t("Checkout", "ऑर्डर पूरा करें")}
        onBack={() => router.back()}
        onClear={clearCart}
      />

      <div className="flex-1 space-y-3 px-4 pb-4 pt-3">
        <section className="card overflow-hidden">{addressCard()}</section>

        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-bold">{t("Payment", "भुगतान")}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {paymentMethodsText(availability, t)}
            </p>
          </div>
          <div className="space-y-2 p-4">
            {/* The one line that has to be plain English: it tells the customer
                what to do, not what went wrong. */}
            {availability.notice ? (
              <p className="rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-2.5 text-[13px] font-medium leading-snug text-accent-ink">
                {paymentNotice}
              </p>
            ) : null}
            <PaymentOption
              icon={<Banknote className="size-5" />}
              label={t("Cash on delivery", "डिलीवरी पर नकद")}
              desc={
                availability.codRefusal === "over_limit"
                  ? t(
                      "Not available for this amount.",
                      "इस रकम के लिए उपलब्ध नहीं।",
                    )
                  : (codHintText ??
                    t(
                      "Pay the courier when your order arrives.",
                      "ऑर्डर आने पर डिलीवरी वाले को भुगतान करें।",
                    ))
              }
              selected={availability.cod && !payOnline}
              // Genuinely disabled, not merely styled that way — and the order
              // API refuses a cash order over the ceiling regardless.
              disabled={!availability.cod}
              badge={codBadgeText(availability, t)}
              onSelect={() => setPaymentMethod("cod")}
            />
            <PaymentOption
              icon={<CreditCard className="size-5" />}
              label={t("Pay online", "ऑनलाइन भुगतान")}
              desc={t(
                "UPI, cards, netbanking and wallets.",
                "UPI, कार्ड, नेटबैंकिंग और वॉलेट।",
              )}
              selected={payOnline}
              disabled={!availability.online}
              badge={onlineBadgeText(availability, config.onlinePayments, t)}
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
                {t("Tip the courier?", "डिलीवरी वाले को टिप दें?")}
              </h2>
              <p className="mt-1 text-sm leading-snug text-muted">
                {t(
                  "The courier will get 100% of your tip. You can cancel the tip later.",
                  "पूरी टिप डिलीवरी वाले को मिलेगी। आप बाद में टिप रद्द कर सकते हैं।",
                )}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {TIP_OPTIONS.map((amount) => (
              <button
                key={amount}
                type="button"
                onClick={() => setTip(amount)}
                className={cn(
                  "press bolt-chip min-w-[72px] justify-center",
                  tip === amount && "bolt-chip-on",
                )}
              >
                {amount === 0 ? t("No tip", "कोई टिप नहीं") : formatINR(amount)}
              </button>
            ))}
          </div>
        </section>

        <section className="card p-4">
          <h2 className="text-[15px] font-bold">
            {t("Have a code?", "कूपन कोड है?")}
          </h2>
          {coupon ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-green-soft px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-data truncate text-sm font-bold text-green">
                  {coupon.code}
                </p>
                <p className="text-xs text-muted">
                  {t(
                    `${formatINR(coupon.discount)} off your food`,
                    `खाने पर ${formatINR(coupon.discount)} की छूट`,
                  )}
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
                {t("Remove", "हटाएं")}
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
                placeholder={t("Promo code", "कूपन कोड")}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("Promo code", "कूपन कोड")}
                className="text-data min-w-0 flex-1 rounded-xl bg-surface-2 px-3.5 py-3 text-[15px] uppercase tracking-wide text-ink outline-none focus:ring-2 focus:ring-accent/30"
              />
              <Button
                variant="secondary"
                onClick={applyCoupon}
                disabled={couponBusy || !couponInput.trim()}
                className="shrink-0"
              >
                {couponBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {t("Apply", "लगाएं")}
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
            <BillRow
              label={t("Item total", "आइटम का कुल")}
              value={charges.subtotal}
            />
            <BillRow
              label={t("Delivery", "डिलीवरी")}
              value={charges.deliveryFee}
              free={charges.deliveryFee === 0}
            />
            <BillRow label={t("Taxes", "टैक्स")} value={charges.taxes} />
            {charges.tip > 0 ? (
              <BillRow
                label={t("Courier tip", "डिलीवरी वाले की टिप")}
                value={charges.tip}
              />
            ) : null}
            {discount > 0 ? (
              <div className="flex justify-between font-medium text-green">
                <span>
                  {t("Discount", "छूट")} · {coupon?.code}
                </span>
                <span className="text-data">−{formatINR(discount)}</span>
              </div>
            ) : null}
            <div className="flex justify-between pt-1.5 text-[15px] font-bold text-ink">
              <span>{t("To pay", "कुल भुगतान")}</span>
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
        {selectedAddress && !showAddForm ? (
          <div className="mb-3 flex items-center gap-3">
            <MapPin
              className="size-5 shrink-0 text-accent"
              strokeWidth={2.25}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">
                {t("Delivering to", "डिलीवरी का पता")} {selectedAddress.label}
              </p>
              <p className="truncate text-xs text-muted">
                {pinMoved && pinLine ? pinLine : selectedAddress.line}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowMap(true)}
              className="press shrink-0 px-2 py-2 text-sm font-bold text-accent-ink"
            >
              {t("Change", "बदलें")}
            </button>
          </div>
        ) : null}
        {blockedNotice()}
        <button
          onClick={placeOrder}
          disabled={status !== "ready" || orderBlocked}
          className="press flex h-12 w-full items-center justify-between rounded-full bg-accent px-5 text-[16px] font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)] disabled:opacity-70"
        >
          {placeOrderLabel()}
        </button>
      </div>

      {selectedAddress ? (
        <DeliveryMapScreen
          open={showMap}
          mapKey={selectedId}
          coords={mapCoords}
          label={selectedAddress.label}
          line={selectedAddress.line}
          pinLine={pinLine}
          pinMoved={Boolean(pinMoved)}
          pinBusy={pinBusy}
          pinSaved={pinSaved}
          area={serviceArea}
          unpinned={addressUnpinned}
          onPick={({ lat, lng, address }) => {
            setMapCoords({ lat, lng });
            setPinSaved(false);
            setPinLine(address || null);
          }}
          onSavePin={savePinToAddress}
          onSwitch={() => setShowPicker(true)}
          onClose={() => setShowMap(false)}
        />
      ) : null}

      <DetailsSheet
        open={showDetails}
        onClose={() => setShowDetails(false)}
        apartment={apartment}
        setApartment={setApartment}
        entryCode={entryCode}
        setEntryCode={setEntryCode}
        floor={floor}
        setFloor={setFloor}
        buildingName={buildingName}
        setBuildingName={setBuildingName}
        courierInstructions={courierInstructions}
        setCourierInstructions={setCourierInstructions}
      />

      <AddressPickerSheet
        open={showPicker}
        addresses={addresses}
        selectedId={selectedId}
        onSelect={pickAddress}
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
}: Readonly<{
  label: string;
  value: number;
  free?: boolean;
}>) {
  const t = useT();
  return (
    <div className="flex justify-between text-muted">
      <span>{label}</span>
      <span className={cn("text-data", free && "text-green")}>
        {free ? t("Free", "मुफ़्त") : formatINR(value)}
      </span>
    </div>
  );
}

function couponMessage(t: T, error?: string, minOrder?: number): string {
  switch (error) {
    case "invalid":
      return t("That code isn't recognised.", "यह कोड सही नहीं है।");
    case "expired":
      return t("That code has expired.", "इस कोड की तारीख निकल गई है।");
    case "min_order":
      return minOrder
        ? t(
            `Spend ${formatINR(minOrder)} on food to use this code.`,
            `यह कोड लगाने के लिए ${formatINR(minOrder)} का खाना लें।`,
          )
        : t(
            "Your basket is below this code's minimum.",
            "आपकी टोकरी इस कोड की न्यूनतम रकम से कम है।",
          );
    case "wrong_restaurant":
      return t(
        "That code doesn't work at this restaurant.",
        "यह कोड इस रेस्टोरेंट पर नहीं चलता।",
      );
    case "already_used":
      return t(
        "You've already used this code.",
        "आप यह कोड पहले ही इस्तेमाल कर चुके हैं।",
      );
    case "exhausted":
      return t(
        "This code has been fully claimed.",
        "यह कोड अब खत्म हो चुका है।",
      );
    case "already_applied":
      return t(
        "A code is already applied to this order.",
        "इस ऑर्डर पर पहले से एक कोड लगा है।",
      );
    case "order_not_open":
      return t(
        "This order has moved on — the code can't be added now.",
        "यह ऑर्डर आगे बढ़ चुका है — अब कोड नहीं लग सकता।",
      );
    case "empty":
      return t("Enter a code first.", "पहले कोड लिखें।");
    default:
      return t("That code couldn't be applied.", "यह कोड नहीं लग पाया।");
  }
}

/** Why the order API refused a basket, for the codes it can send back. */
function placeOrderErrorMessage(t: T, error?: string): string {
  switch (error) {
    case "invalid_items":
      return t(
        "Something in your cart is no longer available.",
        "आपकी टोकरी का कोई आइटम अब उपलब्ध नहीं है।",
      );
    case "tip_unsupported":
      return t(
        "Tipping isn't available right now — set the tip to “No tip” to place your order.",
        "अभी टिप देने की सुविधा नहीं है — ऑर्डर करने के लिए “कोई टिप नहीं” चुनें।",
      );
    case "online_payments_unavailable":
      return t(
        "Online payment isn't available yet — switch to Cash on delivery to place your order.",
        "ऑनलाइन भुगतान अभी उपलब्ध नहीं है — ऑर्डर करने के लिए कैश ऑन डिलीवरी चुनें।",
      );
    default:
      return t(
        "Could not place the order. Try again.",
        "ऑर्डर नहीं हो पाया। फिर से कोशिश करें।",
      );
  }
}

/** The line under "Payment": which methods this shop takes for this basket. */
function paymentMethodsText(availability: PaymentAvailability, t: T): string {
  if (availability.cod && availability.online) {
    return t(
      "Pay now by UPI or card, or pay the courier on delivery.",
      "अभी UPI या कार्ड से भुगतान करें, या डिलीवरी पर नकद दें।",
    );
  }
  if (availability.online) {
    return t(
      "Pay now by UPI, card, netbanking or wallet.",
      "अभी UPI, कार्ड, नेटबैंकिंग या वॉलेट से भुगतान करें।",
    );
  }
  if (availability.cod) {
    return t(
      "Pay the courier in cash when your order arrives.",
      "ऑर्डर आने पर डिलीवरी वाले को नकद दें।",
    );
  }
  return t(
    "Payment is not available for this shop right now.",
    "इस दुकान पर अभी भुगतान की सुविधा नहीं है।",
  );
}

/** The badge on the cash option, when cash is refused. */
function codBadgeText(
  availability: PaymentAvailability,
  t: T,
): string | undefined {
  if (availability.codRefusal === "over_limit") {
    return t("Over cash limit", "नकद सीमा से ज़्यादा");
  }
  if (availability.codRefusal === "cod_off") {
    return t("Not accepted", "नहीं लेते");
  }
  return undefined;
}

/** The badge on the online option: refused by this shop, or not live yet. */
function onlineBadgeText(
  availability: PaymentAvailability,
  onlinePayments: boolean,
  t: T,
): string | undefined {
  if (availability.online) return undefined;
  return onlinePayments
    ? t("Not accepted", "नहीं लेते")
    : t("Available soon", "जल्द आ रहा है");
}

/**
 * `availability.notice`, worded in the customer's language. The rules in
 * cod-rules.ts decide whether there is a notice at all; this only says it.
 */
function paymentNoticeText(
  availability: PaymentAvailability,
  codLimit: string,
  t: T,
): string | null {
  if (!availability.notice) return null;
  if (!availability.cod && !availability.online) {
    return t(
      "This shop cannot take payment right now. Please try again a little later.",
      "यह दुकान अभी भुगतान नहीं ले पा रही है। थोड़ी देर बाद फिर कोशिश करें।",
    );
  }
  if (availability.codRefusal === "over_limit") {
    return availability.online
      ? t(
          `Orders above ${codLimit} must be paid online.`,
          `${codLimit} से ज़्यादा के ऑर्डर का भुगतान ऑनलाइन करना होगा।`,
        )
      : t(
          `This shop takes cash only up to ${codLimit}. Remove a few items to place this order.`,
          `यह दुकान ${codLimit} तक ही नकद लेती है। ऑर्डर करने के लिए कुछ आइटम हटाएं।`,
        );
  }
  if (availability.codRefusal === "cod_off") {
    return t(
      "This shop takes online payment only.",
      "यह दुकान सिर्फ़ ऑनलाइन भुगतान लेती है।",
    );
  }
  return availability.notice;
}

function PaymentOption({
  icon,
  label,
  desc,
  selected,
  disabled,
  badge,
  onSelect,
}: Readonly<{
  icon: React.ReactNode;
  label: string;
  desc: string;
  selected: boolean;
  disabled?: boolean;
  badge?: string;
  onSelect: () => void;
}>) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors",
        disabled
          ? "cursor-not-allowed border-line bg-surface-2 opacity-60"
          : "cursor-pointer",
        selected && !disabled
          ? "border-accent bg-accent-soft"
          : "border-line bg-surface-2",
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
          selected && !disabled ? "text-accent-ink" : "text-muted",
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{label}</span>
          {badge ? (
            <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-muted">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{desc}</span>
      </span>
      <span
        className={cn(
          "mt-1 grid size-[18px] shrink-0 place-items-center rounded-full border-2",
          selected && !disabled ? "border-accent" : "border-line",
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
}: Readonly<{
  title: string;
  onBack: () => void;
  onClear?: () => void;
}>) {
  const t = useT();
  return (
    <header className="app-header sticky top-0 z-20 flex items-center gap-3 px-4 py-3">
      <button
        onClick={onBack}
        aria-label={t("Go back", "वापस जाएं")}
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
          aria-label={t("Clear cart", "टोकरी खाली करें")}
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

/** Flat, floor, gate code and a note for the courier. All optional, so they
 *  live in a sheet instead of taking half the checkout page. */
function DetailsSheet({
  open,
  onClose,
  apartment,
  setApartment,
  entryCode,
  setEntryCode,
  floor,
  setFloor,
  buildingName,
  setBuildingName,
  courierInstructions,
  setCourierInstructions,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  apartment: string;
  setApartment: (v: string) => void;
  entryCode: string;
  setEntryCode: (v: string) => void;
  floor: string;
  setFloor: (v: string) => void;
  buildingName: string;
  setBuildingName: (v: string) => void;
  courierInstructions: string;
  setCourierInstructions: (v: string) => void;
}>) {
  const t = useT();
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
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={t("Close", "बंद करें")}
        onClick={onClose}
        className="animate-fade-in absolute inset-0 bg-ink/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Delivery instructions", "डिलीवरी के निर्देश")}
        className="bolt-sheet animate-sheet-in absolute inset-x-0 bottom-0 max-h-[88%] overflow-hidden"
      >
        <div className="bolt-sheet-handle" />
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <h2 className="text-heading">
            {t("Delivery instructions", "डिलीवरी के निर्देश")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close", "बंद करें")}
            className="press grid size-9 place-items-center rounded-full bg-surface-2 text-muted"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="no-scrollbar max-h-[60vh] space-y-3 overflow-y-auto px-5 pb-3">
          <CheckoutField
            placeholder={t(
              "Apartment, flat or suite number",
              "मकान / फ्लैट नंबर",
            )}
            value={apartment}
            onChange={setApartment}
          />
          <div className="grid grid-cols-2 gap-3">
            <CheckoutField
              placeholder={t("Entry code", "गेट कोड")}
              value={entryCode}
              onChange={setEntryCode}
            />
            <CheckoutField
              placeholder={t("Floor", "मंज़िल")}
              value={floor}
              onChange={setFloor}
            />
          </div>
          <CheckoutField
            label={t("Building name", "बिल्डिंग का नाम")}
            placeholder={t("Building name", "बिल्डिंग का नाम")}
            value={buildingName}
            onChange={setBuildingName}
          />
          <CheckoutField
            label={t(
              "Instructions for the courier",
              "डिलीवरी वाले के लिए निर्देश",
            )}
            placeholder={t(
              "Instructions for the courier",
              "डिलीवरी वाले के लिए निर्देश",
            )}
            value={courierInstructions}
            onChange={setCourierInstructions}
          />
          <Link
            href="/profile/addresses"
            className="block pt-1 text-center text-sm font-semibold text-accent-ink"
          >
            {t("Manage saved addresses", "सेव पते बदलें")}
          </Link>
        </div>
        <div className="border-t border-line p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            className="press flex h-12 w-full items-center justify-center rounded-full bg-accent text-[16px] font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)]"
          >
            {t("Done", "हो गया")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckoutField({
  label,
  placeholder,
  value,
  onChange,
}: Readonly<{
  label?: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}>) {
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
