/**
 * What an order costs. One definition, used by the basket, the checkout, the
 * listing cards, and the server that actually bills.
 *
 * These numbers used to be copy-pasted into four files — and the copy that
 * looked canonical (the cart store) was read by nobody, so changing it did
 * nothing while the customer was quietly shown three different delivery fees for
 * the same order. Anything that needs a fee or a tax imports it from here.
 *
 * The constants below are *defaults*, not the live numbers: once an admin saves
 * the Settings tab, `platform_settings` is the source and these are only what a
 * demo install or an un-migrated database falls back to (see
 * `settings-defaults.ts`). So anything that quotes a price to a customer takes a
 * config — `computeChargesWith`, `riderPayout` — and gets it from the settings
 * row.
 *
 * Safe on the client (no secrets), but the server is still the authority: the
 * amount billed is recomputed here in `createOrder` from the settings it reads
 * itself, never taken from what the browser sends.
 */

/** Flat delivery fee, in whole rupees, before an admin sets one. */
export const DELIVERY_FEE = 29;

/** Applied to the item subtotal only — fees are not taxed. */
export const TAX_RATE = 0.05;

/** Tip amounts offered at checkout. 0 = no tip. */
export const TIP_OPTIONS = [0, 20, 30, 50] as const;

/** Refuses a tip the UI never offered, so the API can't be fed an arbitrary one. */
const MAX_TIP = Math.max(...TIP_OPTIONS);

export interface OrderCharges {
  subtotal: number;
  deliveryFee: number;
  taxes: number;
  tip: number;
  /** What the customer pays. */
  total: number;
}

/** The fee/tax knobs the arithmetic needs — a slice of PlatformSettings. */
export interface ChargesConfig {
  deliveryFee: number;
  taxRate: number;
  /** Subtotal at/above which delivery is free. 0 = never free. */
  freeDeliveryThreshold: number;
}

/** The module defaults as a config, used when no settings are supplied. */
export const DEFAULT_CHARGES_CONFIG: ChargesConfig = {
  deliveryFee: DELIVERY_FEE,
  taxRate: TAX_RATE,
  freeDeliveryThreshold: 0,
};

/**
 * The one place the arithmetic lives, parameterised by config. Free delivery
 * kicks in at the threshold; tax is on the item subtotal only.
 */
export function computeChargesWith(
  config: ChargesConfig,
  subtotal: number,
  tip = 0
): OrderCharges {
  const qualifiesFree =
    config.freeDeliveryThreshold > 0 &&
    subtotal >= config.freeDeliveryThreshold;
  const deliveryFee = subtotal > 0 && !qualifiesFree ? config.deliveryFee : 0;
  const taxes = Math.round(subtotal * config.taxRate);
  const safeTip = clampTip(tip);

  return {
    subtotal,
    deliveryFee,
    taxes,
    tip: safeTip,
    total: subtotal + deliveryFee + taxes + safeTip,
  };
}

/** A tip is whole rupees, never negative, never more than the UI offers. */
function clampTip(tip: number): number {
  if (!Number.isFinite(tip)) return 0;
  return Math.min(Math.max(Math.round(tip), 0), MAX_TIP);
}

/* ---------- Rider payout ----------
   Currently unused: riders are salaried monthly, not paid a per-order
   commission (see the "Salary model on the board" task in build-plan.ts).
   Left defined, not deleted, in case a per-order model comes back. */

/** Share of the food bill that goes to the rider, before an admin sets one. */
export const RIDER_COMMISSION = 0.08;

/** No trip pays less than this, however small the order. */
export const RIDER_MIN_PAYOUT = 30;

/**
 * The payout knobs — a slice of PlatformSettings, mirroring ChargesConfig.
 *
 * @public Parked with `riderPayout` below.
 */
export interface RiderPayoutConfig {
  /** Fraction of the food subtotal, e.g. 0.08. */
  commission: number;
  /** Floor for the commission part, in whole rupees. */
  minPayout: number;
}

/**
 * What the rider earns for a delivery.
 *
 * The config is required rather than defaulted.
 * `platform_settings.rider_commission` / `rider_min_payout` have been editable
 * in the Admin Settings form since migration 0015 and were read by nothing that
 * pays anyone: an operations lead could raise the rate to solve a driver-supply
 * problem, be told it saved, and have every offer card and earnings total keep
 * quoting the old one. A parameter with no default is the only version of this
 * function that cannot drift back into that.
 *
 * Deliberately computed on the FOOD subtotal, not the order total: the total
 * includes the delivery fee, the customer's GST and their tip, and paying a
 * commission on someone's tax is not a policy anyone chose — it was an accident
 * of using the wrong number.
 *
 * The tip is then added in full, which is what checkout promises the customer
 * ("the courier will get 100% of your tip").
 *
 * @public Parked: unused since per-order rider payouts were dropped, kept in
 * case that model comes back (see build-plan.ts).
 */
export function riderPayout(
  config: RiderPayoutConfig,
  {
    itemSubtotal,
    tip = 0,
  }: {
    itemSubtotal: number;
    tip?: number;
  }
): number {
  const commission = Math.max(
    config.minPayout,
    Math.round(itemSubtotal * config.commission)
  );
  return commission + clampTip(tip);
}
