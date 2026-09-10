import "server-only";
import { createClient } from "@/lib/supabase/server";
import { computeChargesWith } from "@/lib/pricing";
import { getSettings } from "@/lib/settings";
import { formatINR } from "@/lib/utils/format";
import { effectivePrice } from "@/lib/utils/cart";
import {
  blocksOrder,
  checkServiceArea,
  outOfRangeMessage,
} from "@/lib/geo/service-area";
import { evaluateCoupon } from "@/lib/data-access/coupons";
import { onlinePaymentsEnabled } from "@/lib/payments/availability";
import { getVendorPaymentRules } from "@/lib/payments/vendor-rules";
import {
  refusalMessage,
  refusePayment,
  type PaymentRefusalCode,
  type VendorPaymentRules,
} from "@/lib/payments/cod-rules";
import {
  notifyOrderPlaced,
  notifyVendorNewOrder,
} from "@/lib/notifications/order-events";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import type { PaymentMethod, PaymentStatus } from "@/types";

/**
 * Secure data access for orders. Every query here runs through the anon key,
 * so Row Level Security is in force: the database returns a row ONLY if the
 * caller is allowed to see it (own order / owning restaurant / actively-assigned
 * driver / admin). App code cannot accidentally widen that — the fix for IDOR
 * lives in the DB, not in remembering to add a `where`.
 */

export interface OrderItem {
  name: string;
  qty: number;
  price: number;
}

export interface Order {
  id: string;
  restaurant_id: string;
  status: string;
  total: number;
  delivery_fee: number;
  tax_amount: number;
  tip: number;
  /** Present once migration 0025 is applied; COD before that. */
  payment_method?: PaymentMethod;
  payment_status?: PaymentStatus;
  /** Present once 0031 is applied. Rupees off the grand total; 0 when no coupon. */
  discount?: number;
  coupon_code?: string | null;
  created_at: string;
  address: { label?: string; line?: string } | null;
  order_items: OrderItem[];
  restaurants?: {
    slug: string;
    name: string;
    image_url?: string | null;
    accent_tint?: string | null;
    eta_min?: number | null;
    eta_max?: number | null;
  } | null;
}

const TIP_COLUMN = "orders.tip";
/** The payment columns arrive together in 0025, so one probe covers both. */
const PAYMENT_COLUMNS = "orders.payment_method";
/** `discount` / `coupon_code` arrive together in 0031. */
const COUPON_COLUMNS = "orders.discount";
/** `idempotency_key` arrives in 0049. */
const IDEMPOTENCY_COLUMN = "orders.idempotency_key";
/** Postgres's "duplicate key value violates unique constraint". */
const UNIQUE_VIOLATION = "23505";

interface SelectFlags {
  /** `tip` only exists once migration 0013 has been applied. */
  tip: boolean;
  /** `payment_method` / `payment_status` only exist from 0025. */
  payment: boolean;
  /** `discount` / `coupon_code` only exist from 0031. */
  coupon: boolean;
}

function select(flags: SelectFlags): string {
  return [
    "id, restaurant_id, status, total, delivery_fee, tax_amount",
    flags.tip ? ", tip" : "",
    flags.payment ? ", payment_method, payment_status" : "",
    flags.coupon ? ", discount, coupon_code" : "",
    ", created_at, address",
    ", order_items(name, qty, price, menu_items(external_id, veg))",
    ", restaurants(slug, name, image_url, accent_tint, eta_min, eta_max)",
  ].join("");
}

interface QueryResult<T> {
  data: T | null;
  error: { code?: string } | null;
}

/**
 * Run an order query, narrowing the column list on a database that predates
 * 0013 or 0025.
 *
 * Each optional group is dropped independently and remembered, so an
 * environment missing one migration still gets everything the other provides —
 * and after the first probe the retry cost is gone.
 */
async function selectOrders<T>(
  run: (columns: string) => PromiseLike<QueryResult<T>>
): Promise<T | null> {
  const flags: SelectFlags = {
    tip: !columnKnownMissing(TIP_COLUMN),
    payment: !columnKnownMissing(PAYMENT_COLUMNS),
    coupon: !columnKnownMissing(COUPON_COLUMNS),
  };

  // `isMissingColumn` doesn't say WHICH column is missing, so drop the newest
  // migration's group first and re-probe rather than guessing. At most one
  // attempt per still-optimistic group, plus the final bare one.
  const groups: Array<{ key: keyof SelectFlags; column: string }> = [
    { key: "coupon", column: COUPON_COLUMNS },
    { key: "payment", column: PAYMENT_COLUMNS },
    { key: "tip", column: TIP_COLUMN },
  ];

  for (const { key, column } of groups) {
    if (!flags[key]) continue;

    const { data, error } = await run(select(flags));
    if (!error) {
      for (const g of groups) if (flags[g.key]) rememberColumn(g.column, true);
      return data;
    }
    if (!isMissingColumn(error)) throw error;

    rememberColumn(column, false);
    flags[key] = false;
  }

  const { data, error } = await run(select(flags));
  if (error) throw error;
  return data;
}


export interface CreateOrderLine {
  itemId: string;
  qty: number;
}

export interface CreateOrderInput {
  restaurantSlug: string;
  lines: CreateOrderLine[];
  /**
   * `lat`/`lng` are the delivery pin. Optional because an address saved before
   * the map picker existed has none — and because they are the customer's to
   * send, so they are checked, never trusted (see the service-area gate in
   * `createOrder`).
   */
  address: { label: string; line: string; lat?: number | null; lng?: number | null };
  /** Courier tip, in whole rupees. Clamped server-side to what the UI offers. */
  tip?: number;
  /**
   * How the customer intends to pay. Defaults to COD, and `online` is honoured
   * only when the server itself says online payment is on offer — the client
   * asking for it is a request, not a decision.
   */
  paymentMethod?: PaymentMethod;
  /**
   * A promo code to try against this order. The code only — never an amount.
   * What it is worth is decided by `apply_coupon_to_order()` from the order's
   * own items, so the preview the customer saw at checkout has no authority
   * over what they are charged.
   */
  couponCode?: string;
  /**
   * One UUID per checkout attempt, sent unchanged on every retry of that same
   * attempt (a timed-out request the client retries, a double-tap that slips
   * past the disabled button). Lets `createOrder` recognize a replay and hand
   * back the order already placed instead of placing a second one. Optional,
   * and degrades to no dedup on a database that predates 0049 — see
   * `IDEMPOTENCY_COLUMN`.
   */
  idempotencyKey?: string;
}

/** Why a coupon didn't apply. Mirrors the RPC's vocabulary 1:1. */
export type CouponFailure =
  | "empty"
  | "invalid"
  | "expired"
  | "min_order"
  | "wrong_restaurant"
  | "already_used"
  | "already_applied"
  | "exhausted"
  | "order_not_open"
  | "order_not_found";

export interface AppliedCoupon {
  code: string;
  discount: number;
}

/**
 * A coupon the customer asked for and cannot have. Carries the reason as a
 * code so the API can map it to a message without matching on prose.
 */
export class CouponRejected extends Error {
  constructor(public readonly reason: CouponFailure) {
    super(`coupon_${reason}`);
    this.name = "CouponRejected";
  }
}

/**
 * The shop does not take this payment method for this amount.
 *
 * Carries its own message rather than a bare code: the ceiling is per vendor,
 * so "Orders above ₹300 must be paid online" cannot be written as a constant
 * in the API layer — only the rules that refused the order know the number.
 */
export class PaymentRefused extends Error {
  readonly customerMessage: string;
  constructor(
    public readonly reason: PaymentRefusalCode,
    rules: VendorPaymentRules
  ) {
    super(reason);
    this.name = "PaymentRefused";
    this.customerMessage = refusalMessage(reason, rules);
  }
}

/** Platform-level reasons an order is refused before anything is written. */
export type OrderRefusalCode =
  | "orders_paused"
  | "below_minimum"
  | "outside_delivery_area";

/**
 * The platform, not the shop, is refusing this order.
 *
 * Carries its own sentence for the same reason `PaymentRefused` does: the
 * numbers in it — the maintenance message the admin wrote, the configured
 * minimum, the shop's radius — are only known to the code that refused. The API
 * layer would have to guess them to write the message itself.
 */
export class OrderRefused extends Error {
  readonly customerMessage: string;
  constructor(
    public readonly reason: OrderRefusalCode,
    customerMessage: string
  ) {
    super(reason);
    this.name = "OrderRefused";
    this.customerMessage = customerMessage;
  }
}

/** Place an order — prices validated server-side from menu_items, never trusted from client. */
export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");

  // A replay of an already-placed order — same customer, same key — hands
  // back the order that already exists instead of placing a second one. This
  // is the fast path; the unique index from 0049 is what makes it correct
  // under a race between two concurrent requests carrying the same key (see
  // the insert's UNIQUE_VIOLATION handling below).
  if (input.idempotencyKey && !columnKnownMissing(IDEMPOTENCY_COLUMN)) {
    const { data: existing, error: existingError } = await supabase
      .from("orders")
      .select("id")
      .eq("customer_id", user.id)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();

    if (existingError) {
      if (!isMissingColumn(existingError)) throw existingError;
      rememberColumn(IDEMPOTENCY_COLUMN, false);
    } else {
      rememberColumn(IDEMPOTENCY_COLUMN, true);
      if (existing) {
        const already = await getOrderById(existing.id);
        if (already) return already;
      }
    }
  }

  // The platform-level gates, re-decided here.
  //
  // The checkout screen has its own copies of these — `checkoutBlocked` — and
  // they are advisory, exactly like every other rule on that screen. Three
  // things get past them: a tab that was already open when ops flipped the
  // pause, a stale basket placed later, and any direct POST to /api/orders.
  // Every other checkout rule in this file is already re-decided server-side;
  // these two were the omissions.
  const settings = await getSettings();
  if (!settings.acceptingOrders) {
    throw new OrderRefused(
      "orders_paused",
      settings.maintenanceMessage.trim() ||
        "We're not accepting orders right now. Please try again shortly."
    );
  }

  const { data: restaurant, error: restaurantError } = await supabase
    .from("restaurants")
    .select("id, slug, name, is_open, lat, lng")
    .eq("slug", input.restaurantSlug)
    .eq("approved", true)
    .maybeSingle();

  if (restaurantError) throw restaurantError;
  if (!restaurant?.id) throw new Error("restaurant_not_found");
  if (!restaurant.is_open) throw new Error("restaurant_closed");

  if (!input.lines.length) throw new Error("empty_cart");

  // Delivery area. Measured from the address the customer is actually sending,
  // not the one they previewed with.
  //
  // `blocksOrder`, not `status === "out_of_range"`: a radius that is set but
  // cannot be evaluated — an unpinned shop, an address with no coordinates —
  // now refuses too. It used to accept, which is how a 70 km order was taken
  // from a shop that had never been pinned. See `checkServiceArea`.
  const area = checkServiceArea({
    shop: restaurant,
    destination: input.address,
    radiusKm: settings.deliveryRadiusKm,
  });
  if (blocksOrder(area)) {
    throw new OrderRefused("outside_delivery_area", outOfRangeMessage(area));
  }

  const externalIds = [...new Set(input.lines.map((l) => l.itemId))];
  const { data: menuItems, error: menuError } = await supabase
    .from("menu_items")
    .select("id, external_id, name, price, discount_price, available")
    .eq("restaurant_id", restaurant.id)
    .in("external_id", externalIds);

  if (menuError) throw menuError;
  if (!menuItems?.length) throw new Error("invalid_items");

  const itemSubtotal = input.lines.reduce((sum, line) => {
    const item = menuItems.find((m) => m.external_id === line.itemId);
    if (!item || !item.available || line.qty < 1) {
      throw new Error("invalid_items");
    }
    return sum + effectivePrice(item.price, item.discount_price) * line.qty;
  }, 0);

  // The minimum order, against the subtotal the SERVER just derived from its
  // own prices — not the one the browser previewed with. Without this the
  // policy was advisory: a ₹40 basket placed from a stale tab or a script was
  // accepted and dispatched at a loss.
  if (settings.minOrder > 0 && itemSubtotal < settings.minOrder) {
    throw new OrderRefused(
      "below_minimum",
      `Orders start at ${formatINR(settings.minOrder)} — add ${formatINR(
        settings.minOrder - itemSubtotal
      )} more to place this one.`
    );
  }

  // Charges are derived here from the live platform settings and the DB's own
  // prices — the client sends items and a tip, never an amount. This is the
  // authoritative bill: whatever fee/tax/threshold the admin set applies here.
  const charges = computeChargesWith(
    {
      deliveryFee: settings.deliveryFee,
      taxRate: settings.taxRate,
      freeDeliveryThreshold: settings.freeDeliveryThreshold,
    },
    itemSubtotal,
    input.tip ?? 0
  );

  // The client may ASK to pay online; whether that is on offer is the server's
  // call. Asking while it is switched off (or unconfigured) is refused loudly
  // rather than quietly downgraded to COD — silently changing how someone pays
  // is its own kind of wrong.
  const wantsOnline = input.paymentMethod === "online";
  if (wantsOnline && !(await onlinePaymentsEnabled())) {
    throw new Error("online_payments_unavailable");
  }
  const paymentMethod: PaymentMethod = wantsOnline ? "online" : "cod";

  // A coupon is checked BEFORE anything is written, against the subtotal the
  // server just derived rather than the one the browser previewed with. The
  // order cannot be rolled back later — a customer has no DELETE on `orders`,
  // by design — so a code that is going to be refused has to be refused while
  // there is still nothing to undo. Charging someone full price for an order
  // they placed expecting a discount is the same wrong as quietly downgrading
  // how they pay, and gets the same answer: refuse loudly.
  //
  // It also has to happen before the cash-ceiling check below, because the
  // discount is what decides whether this order is over the ceiling: a ₹320
  // basket with a ₹50 code is ₹270 of cash at the door.
  const wantsCoupon = input.couponCode?.trim();
  let previewDiscount = 0;
  if (wantsCoupon) {
    const preview = await evaluateCoupon(wantsCoupon, itemSubtotal, restaurant.id);
    if (!preview.ok) throw new CouponRejected(preview.error as CouponFailure);
    previewDiscount = Math.max(0, Math.round(preview.discount ?? 0));
  }

  // What this shop takes, and up to what amount in cash. Re-read from the
  // database on every order: the rules the browser was shown may be minutes
  // old, and an admin who has just switched cash off for a shop expects that to
  // hold from the next order, not the next page load.
  const rules = await getVendorPaymentRules(restaurant.id);
  const payable = Math.max(0, charges.total - previewDiscount);
  const refusal = refusePayment(rules, paymentMethod, payable);
  if (refusal) throw new PaymentRefused(refusal, rules);

  const base: Record<string, unknown> = {
    customer_id: user.id,
    restaurant_id: restaurant.id,
    status: "placed",
    delivery_fee: charges.deliveryFee,
    tax_amount: charges.taxes,
    // Placeholder: recompute_order_total() below writes the authoritative sum.
    total: 0,
    address: input.address,
  };

  // `payment_status` is deliberately not sent: the 0025 insert trigger pins it
  // to 'pending' for anything holding a user JWT, so sending it would be theatre.
  const insertOrder = (withTip: boolean, withPayment: boolean, withIdempotency: boolean) =>
    supabase
      .from("orders")
      .insert({
        ...base,
        ...(withTip ? { tip: charges.tip } : {}),
        ...(withPayment ? { payment_method: paymentMethod } : {}),
        ...(withIdempotency && input.idempotencyKey
          ? { idempotency_key: input.idempotencyKey }
          : {}),
      })
      .select("id")
      .single();

  let withTip = !columnKnownMissing(TIP_COLUMN);
  let withPayment = !columnKnownMissing(PAYMENT_COLUMNS);
  let withIdempotency = !columnKnownMissing(IDEMPOTENCY_COLUMN);

  let { data: order, error: orderError } = await insertOrder(
    withTip,
    withPayment,
    withIdempotency
  );

  if (orderError && isMissingColumn(orderError) && withIdempotency) {
    // Migration 0049 hasn't been applied. Proceed without a key rather than
    // refuse the order over a dedup guarantee this database can't yet keep.
    rememberColumn(IDEMPOTENCY_COLUMN, false);
    withIdempotency = false;
    ({ data: order, error: orderError } = await insertOrder(withTip, withPayment, false));
  }

  if (orderError && isMissingColumn(orderError) && withPayment) {
    // Migration 0025 hasn't been applied. COD is what this database can record,
    // so a COD order proceeds unchanged; an online one cannot be taken at all.
    rememberColumn(PAYMENT_COLUMNS, false);
    if (paymentMethod === "online") throw new Error("online_payments_unavailable");
    withPayment = false;
    ({ data: order, error: orderError } = await insertOrder(withTip, false, withIdempotency));
  }

  if (orderError && isMissingColumn(orderError) && withTip) {
    // Migration 0013 hasn't been applied. We can still take the order — but we
    // cannot take the tip, because there is nowhere to put it and charging for
    // something we can't record is exactly the bug this replaced. Refuse the tip
    // loudly instead of pocketing it silently.
    rememberColumn(TIP_COLUMN, false);
    if (charges.tip > 0) throw new Error("tip_unsupported");
    withTip = false;
    ({ data: order, error: orderError } = await insertOrder(false, withPayment, withIdempotency));
  }

  if (orderError?.code === UNIQUE_VIOLATION && input.idempotencyKey) {
    // Lost a race against another request carrying the same key — that other
    // request is the one that actually placed the order. Hand back what it
    // created rather than telling this customer their order failed.
    const { data: existing, error: raceError } = await supabase
      .from("orders")
      .select("id")
      .eq("customer_id", user.id)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (!raceError && existing) {
      const already = await getOrderById(existing.id);
      if (already) return already;
    }
  }

  if (orderError) throw orderError;
  if (!order) throw new Error("order_not_created");

  const orderItems = input.lines.map((line) => {
    const item = menuItems.find((m) => m.external_id === line.itemId)!;
    return {
      order_id: order.id,
      menu_item_id: item.id,
      name: item.name,
      qty: line.qty,
      // What was actually charged, discount honored — this is the price a
      // later reorder/order-history view snapshots, and it must match what
      // itemSubtotal above billed.
      price: effectivePrice(item.price, item.discount_price),
    };
  });

  const { error: itemsError } = await supabase
    .from("order_items")
    .insert(orderItems);
  if (itemsError) throw itemsError;

  // Now apply it for real. The pre-check above priced it; this is the write
  // that decides, and it re-derives the amount from the rows just inserted.
  //
  // A failure here is a race the pre-check cannot cover — the customer's last
  // allowed use of the code landed on another request in between, or the
  // campaign hit its global cap. The order is already real and cannot be
  // unwound, so it proceeds at full price rather than being abandoned. The
  // customer is not misled: the Order returned below carries the actual
  // discount (zero) and the success screen shows the actual total.
  if (wantsCoupon) {
    const { data: applied } = await supabase.rpc("apply_coupon_to_order", {
      oid: order.id,
      coupon: wantsCoupon,
    });
    const result = applied as { ok?: boolean } | null;
    if (!result?.ok) {
      console.warn(
        `[orders] coupon ${wantsCoupon} passed pre-check but was refused for order ${order.id}`
      );
    }
  }

  // Runs whether or not a coupon applied — the RPC recomputes on success, and
  // this is what sets the total in every other case. Idempotent either way.
  const { error: totalError } = await supabase.rpc("recompute_order_total", {
    oid: order.id,
  });
  if (totalError) throw totalError;

  // Announce it. Fire-and-forget by contract (order-events swallows its own
  // failures), and deliberately not awaited as a pair with the insert: the
  // order is already real, and a push outage must not fail a placed order.
  void notifyOrderPlaced(order.id);

  // The vendor is alerted only once the order is actually theirs to cook. A COD
  // order is actionable immediately; an online one is not until the money
  // lands, and settlePayment() raises the alert then. Without this split a
  // kitchen would be rung for every abandoned checkout.
  if (paymentMethod === "cod") {
    void notifyVendorNewOrder(order.id, input.lines.length);
  }

  const created = await getOrderById(order.id);
  if (!created) throw new Error("order_not_found");
  return created;
}

/** One order by id, or null if it doesn't exist OR isn't visible to the caller. */
export async function getOrderById(id: string): Promise<Order | null> {
  const supabase = await createClient();
  const data = await selectOrders<Record<string, unknown>>((columns) =>
    supabase
      .from("orders")
      .select(columns)
      .eq("id", id)
      .maybeSingle()
      .overrideTypes<Record<string, unknown>>()
  );

  if (!data) return null;
  const row = data;
  const restaurants = row.restaurants;
  const restaurant = Array.isArray(restaurants) ? restaurants[0] : restaurants;
  return { ...row, restaurants: restaurant ?? null } as Order;
}

/**
 * Orders visible to the current user. No explicit `where user = me` needed:
 * RLS already scopes the result to what this role may see. A customer gets
 * their own; a vendor gets its restaurant's; a driver gets active assignments.
 */
export async function listVisibleOrders(): Promise<Order[]> {
  const supabase = await createClient();
  const data = await selectOrders<Record<string, unknown>[]>((columns) =>
    supabase
      .from("orders")
      .select(columns)
      .order("created_at", { ascending: false })
      .overrideTypes<Record<string, unknown>[]>()
  );

  return (data ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    const restaurants = record.restaurants;
    const restaurant = Array.isArray(restaurants) ? restaurants[0] : restaurants;
    return { ...record, restaurants: restaurant ?? null } as Order;
  });
}

/**
 * The signed-in account's OWN orders — what the customer app means by "my
 * orders".
 *
 * Not the same question as `listVisibleOrders()`, and the difference only shows
 * up for an operator. "orders — read" (0001) grants an admin every row on the
 * platform, so the owner/developer account shopping through the customer app
 * saw the whole company's order book on /orders, with a stranger's delivery
 * sitting in the "Active" card. RLS is the ceiling on what may be read; this
 * query is the customer app choosing to stay under it and ask only for what the
 * screen actually claims to show.
 *
 * For a plain customer the two return exactly the same rows — the filter is
 * what RLS was already imposing — so this is the safe default for any
 * customer-facing surface.
 */
export async function listMyOrders(): Promise<Order[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const data = await selectOrders<Record<string, unknown>[]>((columns) =>
    supabase
      .from("orders")
      .select(columns)
      .eq("customer_id", user.id)
      .order("created_at", { ascending: false })
      // The Orders tab shows recent history, not a permanent archive — without
      // a cap this fetches every order a long-tenured customer has ever placed,
      // in full (items, restaurant), on every visit. An active order is always
      // recent by definition, so this cannot hide the Active card. 100 is well
      // past what anyone scrolls to on this screen today.
      .limit(100)
      .overrideTypes<Record<string, unknown>[]>()
  );

  return (data ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    const restaurants = record.restaurants;
    const restaurant = Array.isArray(restaurants) ? restaurants[0] : restaurants;
    return { ...record, restaurants: restaurant ?? null } as Order;
  });
}
