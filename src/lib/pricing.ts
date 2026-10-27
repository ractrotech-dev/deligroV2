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
 * config — `computeChargesWith` — and gets it from the settings row.
 *
 * What a RIDER is paid is not here: riders are salaried, outside the app, and
 * their money is a recorded ledger (`rider_earnings`, `rider_adjustments`,
 * `rider_payouts`; `lib/rider/earnings-math.ts`), not a per-delivery formula.
 *
 * Safe on the client (no secrets), but the server is still the authority: the
 * amount billed is recomputed here in `createOrder` from the settings it reads
 * itself, never taken from what the browser sends.
 *
 * The database repeats `computeChargesWith` in `recompute_order_total()`
 * (migration 0180), because a customer can insert an order through PostgREST
 * without passing through `createOrder`. Change the arithmetic or MAX_TIP here
 * and change it there too; scripts/qa/sql/migration-0180.mjs checks the two
 * agree.
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
