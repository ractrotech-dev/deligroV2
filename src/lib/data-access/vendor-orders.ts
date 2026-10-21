import "server-only";
import { chosenAddons } from "@/lib/orders/order-options";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getKitchenPickupOtps } from "@/lib/data-access/handover";
import type { KitchenOrder, KitchenOrderRider } from "@/lib/roles-data";
import type {
  VendorHistoryQuery,
} from "@/types/vendor-orders";
import type { PaymentMethod, PaymentStatus } from "@/types";
import { shortOrderId } from "@/lib/utils/order-map";
import { formatRelativeTime } from "@/lib/utils/relative-time";
import { addIstDays, startOfIstMonth } from "@/lib/utils/ist-time";
import {
  notifyOrderAccepted,
  notifyOrderCancelled,
  notifyOrderReady,
  stopVendorRing,
} from "@/lib/notifications/order-events";
import { queueRefundForOrder } from "@/lib/data-access/refunds";
import { cancelOrderRow } from "@/lib/data-access/order-cancellation";
import { cancelDeliveryForOrder, dispatchOrder } from "@/lib/dispatch/rider-dispatch";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { deferNotify } from "@/lib/notifications/defer";
import { kitchenStage } from "@/lib/orders/kitchen-stage";

export type {
  VendorHistoryKind,
  VendorHistoryQuery,
  VendorHistoryRange,
} from "@/types/vendor-orders";

interface VendorOrderItemRow {
  name: string;
  qty: number;
  price: number;
  options?: unknown;
  menu_items?:
    | { description: string | null; image_url: string | null }
    | { description: string | null; image_url: string | null }[]
    | null;
}

interface VendorOrderRow {
  id: string;
  status: string;
  total: number;
  created_at: string;
  address: { label?: string; line?: string } | null;
  order_items: VendorOrderItemRow[];
  customer?:
    | { full_name: string | null; phone: string | null }
    | { full_name: string | null; phone: string | null }[]
    | null;
  /**
   * Migration 0025. Optional rather than nullable on purpose: the columns are
   * NOT NULL in the database, so `undefined` here means only one thing — this
   * database predates 0025 and cannot answer the question. That is not the same
   * as "cash", and the board must not render it as such.
   */
  payment_method?: PaymentMethod | null;
  payment_status?: PaymentStatus | null;
  /**
   * Migration 0026, stamped by `stamp_order_lifecycle()` on the transition
   * itself. Null until the order reaches that stage; absent entirely before the
   * migration lands.
   */
  accepted_at?: string | null;
  ready_at?: string | null;
  /**
   * Migration 0006. The handover code the kitchen reads to the rider at
   * collection — the counter's half of the pair whose other half is the
   * customer's delivery code.
   *
   * It has existed since 0006 with no UI anywhere. It was briefly shown to the
   * RIDER instead, which is backwards: a code the person being checked already
   * holds proves nothing, and the pickup transition did not verify it in any
   * case. Shown here, on the packed order, it is what the rider has to be told.
   */
  pickup_otp?: string | null;
  /** Money and provenance columns (0002, 0013, 0029, 0031, 0041, 0051). */
  delivery_fee?: number | null;
  tax_amount?: number | null;
  tip?: number | null;
  discount?: number | null;
  coupon_code?: string | null;
  discount_funded_by?: string | null;
  cancellation_reason?: string | null;
  channel?: string | null;
  /** 0061: the Preparing step and the prep time promised on accept. */
  preparing_at?: string | null;
  prep_minutes?: number | null;
  /** 0063 (absent before it). */
  invoice_no?: string | null;
  invoice_at?: string | null;
}

/** Payment columns arrive together in migration 0025 — see schema-probe. */
const PAYMENT_COLUMNS = "orders.payment_method";
/**
 * Lifecycle timestamps arrive together in 0026. Probed separately from the
 * payment group because the two migrations land independently: a database can
 * have money columns and no clock, and losing the "in kitchen" line is no
 * reason to lose the cash badge with it.
 */
const LIFECYCLE_COLUMNS = "orders.accepted_at";
/** The Preparing step and per-order prep time arrive together in 0061. */
const PREP_COLUMNS = "orders.preparing_at";
const OPTIONS_COLUMN = "order_items.options";
const INVOICE_COLUMNS = "orders.invoice_no";

interface SelectFlags {
  /** `payment_method` / `payment_status` only exist from 0025. */
  payment: boolean;
  /** `accepted_at` / `ready_at` only exist from 0026. */
  lifecycle: boolean;
  /** `preparing_at` / `prep_minutes` only exist from 0061. */
  prep: boolean;
  /** `order_items.options` (chosen size and add-ons) only exists from 0062. */
  options: boolean;
  /** `invoice_no` / `invoice_at` only exist from 0063. */
  invoice: boolean;
}

function select(flags: SelectFlags): string {
  return [
    // pickup_otp is NOT selected here: from 0058 the column is not readable
    // through the table. listKitchenOrders adds it back through getKitchenPickupOtps.
    // The money columns predate 0058, which this module already relies on.
    "id, status, total, created_at, address, delivery_fee, tax_amount, tip, discount" +
      ", coupon_code, discount_funded_by, cancellation_reason, channel",
    flags.payment ? ", payment_method, payment_status" : "",
    flags.lifecycle ? ", accepted_at, ready_at" : "",
    flags.prep ? ", preparing_at, prep_minutes" : "",
    flags.invoice ? ", invoice_no, invoice_at" : "",
    flags.options
      ? ", order_items(name, qty, price, options, menu_items(description, image_url))"
      : ", order_items(name, qty, price, menu_items(description, image_url))",
    ", customer:profiles!orders_customer_id_fkey(full_name, phone)",
  ].join("");
}

/**
 * "Either it's cash on delivery, or the money is already in."
 *
 * An online order exists from the moment it is placed, but the customer may
 * still be inside the Razorpay modal — or may have closed it. Cooking on the
 * strength of an unpaid order is how a kitchen ends up eating the cost, so the
 * board only shows work that is actually owed. The order isn't hidden from the
 * customer; it simply doesn't reach the vendor until it settles.
 */
const PAID_OR_COD = "payment_method.eq.cod,payment_status.eq.paid";

interface PaymentFilterable {
  or: (filter: string) => unknown;
}

/**
 * Apply the paid-or-COD filter, unless this database predates 0025.
 *
 * Before that migration every order is COD by definition, so dropping the
 * filter shows exactly the same rows — the un-migrated case loses nothing.
 *
 * The caller passes the flag rather than this consulting `columnKnownMissing`
 * itself: during a probe the payment group may have just been turned off for
 * this very attempt, and filtering on a column we have already dropped from the
 * select would fail the retry for exactly the reason the retry exists.
 */
function withPaymentFilter<T extends PaymentFilterable>(
  query: T,
  enabled: boolean
): T {
  if (!enabled) return query;
  return query.or(PAID_OR_COD) as T;
}

interface QueryResult<T> {
  data: T | null;
  error: { code?: string } | null;
  count?: number | null;
}

/**
 * Run a vendor-order query, narrowing the column list on a database that
 * predates 0025 or 0026.
 *
 * Asking PostgREST for a column that doesn't exist is a hard 400, not a null,
 * so a single un-applied migration would otherwise blank the entire kitchen
 * board — the one screen a shop cannot work without. Each optional group is
 * dropped independently and the outcome remembered, so the retry cost is paid
 * once per process and an environment missing one migration still gets
 * everything the other provides.
 */
async function selectVendorOrders<T>(
  run: (columns: string, flags: SelectFlags) => PromiseLike<QueryResult<T>>
): Promise<{ data: T | null; count: number | null }> {
  const flags: SelectFlags = {
    payment: !columnKnownMissing(PAYMENT_COLUMNS),
    lifecycle: !columnKnownMissing(LIFECYCLE_COLUMNS),
    prep: !columnKnownMissing(PREP_COLUMNS),
    options: !columnKnownMissing(OPTIONS_COLUMN),
    invoice: !columnKnownMissing(INVOICE_COLUMNS),
  };

  // `isMissingColumn` doesn't say WHICH column is missing, so drop the newest
  // migration's group first and re-probe rather than guessing. At most one
  // attempt per still-optimistic group, plus the final bare one.
  const groups: Array<{ key: keyof SelectFlags; column: string }> = [
    { key: "invoice", column: INVOICE_COLUMNS },
    { key: "options", column: OPTIONS_COLUMN },
    { key: "prep", column: PREP_COLUMNS },
    { key: "lifecycle", column: LIFECYCLE_COLUMNS },
    { key: "payment", column: PAYMENT_COLUMNS },
  ];

  for (const { key, column } of groups) {
    if (!flags[key]) continue;

    const { data, error, count } = await run(select(flags), flags);
    if (!error) {
      for (const g of groups) if (flags[g.key]) rememberColumn(g.column, true);
      return { data, count: count ?? null };
    }
    if (!isMissingColumn(error)) throw error;

    rememberColumn(column, false);
    flags[key] = false;
  }

  const { data, error, count } = await run(select(flags), flags);
  if (error) throw error;
  return { data, count: count ?? null };
}

function rowsOf(data: Record<string, unknown>[] | null): VendorOrderRow[] {
  return (data ?? []) as unknown as VendorOrderRow[];
}

function customerInitials(name: string, phone: string | null): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.slice(-2) || "CU";
}

function formatPlacedAt(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

function mapOrderItem(item: VendorOrderItemRow) {
  const menu = Array.isArray(item.menu_items)
    ? item.menu_items[0]
    : item.menu_items;
  return {
    name: item.name,
    qty: item.qty,
    price: item.price,
    description: menu?.description?.trim() || null,
    imageUrl: menu?.image_url?.trim() || null,
    addons: chosenAddons(item.options),
  };
}

function mapKitchenOrder(row: VendorOrderRow): KitchenOrder {
  const profile = row.customer;
  const customer = Array.isArray(profile) ? profile[0] : profile;
  const customerName = customer?.full_name?.trim() || "Customer";
  const customerPhone = customer?.phone?.trim() || null;
  const deliveryLabel = row.address?.label?.trim();
  const deliveryLine = row.address?.line?.trim();

  return {
    id: row.id,
    code: `#${shortOrderId(row.id)}`,
    customer: customerName,
    customerProfile: {
      name: customerName,
      phone: customerPhone,
      initials: customerInitials(customerName, customerPhone),
    },
    area: deliveryLabel ?? deliveryLine ?? "Delivery",
    deliveryLine:
      deliveryLabel && deliveryLine && deliveryLabel !== deliveryLine
        ? deliveryLine
        : undefined,
    placedAgo: formatRelativeTime(row.created_at),
    placedAt: formatPlacedAt(row.created_at),
    lines: (row.order_items ?? []).map(mapOrderItem),
    total: row.total,
    status: row.status,
    // Left undefined when the column isn't there, so the UI can stay silent
    // instead of guessing. A kitchen told "CASH" about a prepaid order sends a
    // rider to collect money the customer has already paid.
    paymentMethod: row.payment_method ?? undefined,
    paymentStatus: row.payment_status ?? undefined,
    acceptedAt: row.accepted_at,
    readyAt: row.ready_at,
    pickupOtp: row.pickup_otp?.trim() || null,
    createdAt: row.created_at,
    stage: kitchenStage({ status: row.status, preparingAt: row.preparing_at }),
    preparingAt: row.preparing_at ?? null,
    prepMinutes: row.prep_minutes ?? null,
    itemsSubtotal: (row.order_items ?? []).reduce((sum, i) => sum + i.qty * i.price, 0),
    deliveryFee: row.delivery_fee ?? 0,
    taxAmount: row.tax_amount ?? 0,
    tip: row.tip ?? 0,
    discount: row.discount ?? 0,
    couponCode: row.coupon_code ?? null,
    discountFundedBy: row.discount_funded_by ?? null,
    cancellationReason: row.cancellation_reason?.trim() || null,
    channel: row.channel ?? null,
    invoiceNo: row.invoice_no ?? null,
    invoiceAt: row.invoice_at ?? null,
  };
}

/** Kitchen board for one restaurant — scoped by restaurant_id + RLS. */
export async function listKitchenOrders(restaurantId: string): Promise<{
  incoming: KitchenOrder[];
  preparing: KitchenOrder[];
  ready: KitchenOrder[];
}> {
  const supabase = await createClient();

  const { data } = await selectVendorOrders<Record<string, unknown>[]>(
    (columns, flags) => {
      const base = supabase
        .from("orders")
        .select(columns)
        .eq("restaurant_id", restaurantId)
        // `on_the_way` too: a bag that has left is still the kitchen's to know
        // about until it lands. It used to drop off the board at pickup and
        // reappear only at delivery, so "has the rider been?" had no answer.
        .in("status", ["placed", "kitchen", "ready", "on_the_way"]);
      return withPaymentFilter(base, flags.payment)
        .order("created_at", { ascending: false })
        .overrideTypes<Record<string, unknown>[]>();
    }
  );

  const rows = rowsOf(data);
  // The pickup code belongs to this kitchen; ask for it the one way that checks
  // who is asking. History and archive rows never showed it.
  const pickupCodes = await getKitchenPickupOtps(rows.map((r) => r.id));
  for (const r of rows) r.pickup_otp = pickupCodes.get(r.id) ?? null;
  const incoming = rows
    .filter((r) => r.status === "placed")
    .map(mapKitchenOrder);
  const preparing = rows
    .filter((r) => r.status === "kitchen")
    .map(mapKitchenOrder);
  const readyRows = rows.filter(
    (r) => r.status === "ready" || r.status === "on_the_way"
  );
  const riders = await ridersForOrders(readyRows.map((r) => String(r.id)));
  const ready = readyRows.map((r) => ({
    ...mapKitchenOrder(r),
    rider: riders.get(String(r.id)) ?? null,
  }));

  return { incoming, preparing, ready };
}

/**
 * order id → the rider carrying it, for orders already on this board.
 *
 * Service-role read, and safe as one: the ids come from the RLS-scoped query
 * above, which only ever returns this vendor's own orders, so this can name
 * no rider the kitchen isn't already dealing with. It has to be service-role
 * because a vendor cannot read another user's `profiles` row under RLS, and
 * the name is the whole point. Best-effort: no rider info, not no board.
 */
async function ridersForOrders(
  orderIds: string[]
): Promise<Map<string, KitchenOrderRider>> {
  const out = new Map<string, KitchenOrderRider>();
  if (orderIds.length === 0) return out;
  try {
    const admin = createAdminClient();
    // Two plain reads rather than an embedded join: `deliveries` has two FKs
    // to `profiles` (driver_id, and offered_driver_id from 0042), so an embed
    // needs a constraint-name hint that differs by migration state. Same
    // shape as ridersByOrder in admin-dispatch.ts.
    const { data: rows } = await admin
      .from("deliveries")
      .select("order_id, status, driver_id")
      .in("order_id", orderIds)
      .in("status", ["assigned", "picked_up"]);
    const deliveries = (rows ?? []) as {
      order_id: string;
      status: "assigned" | "picked_up";
      driver_id: string | null;
    }[];
    const driverIds = [
      ...new Set(deliveries.map((d) => d.driver_id).filter((d): d is string => Boolean(d))),
    ];
    const names = new Map<string, string>();
    if (driverIds.length) {
      const { data: profiles } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", driverIds);
      for (const p of (profiles ?? []) as { id: string; full_name: string | null }[]) {
        names.set(p.id, p.full_name?.trim() || "Rider");
      }
    }
    for (const d of deliveries) {
      out.set(d.order_id, {
        name: (d.driver_id && names.get(d.driver_id)) || "Rider",
        stage: d.status,
      });
    }
  } catch {
    // leave empty — the card simply doesn't name a rider
  }
  return out;
}

/** Completed + cancelled order history for the selected restaurant. */
export async function listVendorOrderHistory(
  restaurantId: string,
  limit = 6
): Promise<{ completed: KitchenOrder[]; cancelled: KitchenOrder[] }> {
  const supabase = await createClient();

  // History is deliberately NOT payment-filtered: an online order that was
  // cancelled before it settled is exactly the row a vendor comes here to look
  // up, and hiding it would make the cancelled tab lie about what happened.
  const byStatus = (status: string) =>
    selectVendorOrders<Record<string, unknown>[]>((columns) =>
      supabase
        .from("orders")
        .select(columns)
        .eq("restaurant_id", restaurantId)
        .eq("status", status)
        .order("created_at", { ascending: false })
        .limit(limit)
        .overrideTypes<Record<string, unknown>[]>()
    );

  const [completedRes, cancelledRes] = await Promise.all([
    byStatus("delivered"),
    byStatus("cancelled"),
  ]);

  return {
    completed: rowsOf(completedRes.data).map(mapKitchenOrder),
    cancelled: rowsOf(cancelledRes.data).map(mapKitchenOrder),
  };
}

function monthBounds(offsetMonths: number): { start: Date; end: Date } {
  const now = new Date();
  let cursor = startOfIstMonth(now);
  if (offsetMonths < 0) {
    for (let i = 0; i < -offsetMonths; i += 1) {
      cursor = startOfIstMonth(addIstDays(cursor, -1));
    }
  } else if (offsetMonths > 0) {
    for (let i = 0; i < offsetMonths; i += 1) {
      cursor = startOfIstMonth(addIstDays(cursor, 32));
    }
  }
  const start = cursor;
  const end = startOfIstMonth(addIstDays(start, 32));
  return { start, end };
}

function dayBounds(isoDate: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return null;
  const start = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+05:30`);
  if (Number.isNaN(start.getTime())) return null;
  const end = addIstDays(start, 1);
  return { start, end };
}

/** Full history for cancelled or completed, with optional date + search filters. */
export async function listVendorOrderArchive(
  query: VendorHistoryQuery
): Promise<{ orders: KitchenOrder[]; total: number }> {
  const supabase = await createClient();
  const statuses =
    query.kind === "cancelled"
      ? (["cancelled"] as const)
      : (["delivered"] as const);

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
  const range = query.range ?? "all";

  const { data, count } = await selectVendorOrders<Record<string, unknown>[]>(
    (columns) => {
      let q = supabase
        .from("orders")
        .select(columns, { count: "exact" })
        .eq("restaurant_id", query.restaurantId)
        .in("status", [...statuses])
        .order("created_at", { ascending: false });

      if (range === "this_month") {
        const { start, end } = monthBounds(0);
        q = q
          .gte("created_at", start.toISOString())
          .lt("created_at", end.toISOString());
      } else if (range === "previous_month") {
        const { start, end } = monthBounds(-1);
        q = q
          .gte("created_at", start.toISOString())
          .lt("created_at", end.toISOString());
      } else if (range === "date" && query.date) {
        const bounds = dayBounds(query.date);
        if (bounds) {
          q = q
            .gte("created_at", bounds.start.toISOString())
            .lt("created_at", bounds.end.toISOString());
        }
      }

      return q.limit(limit).overrideTypes<Record<string, unknown>[]>();
    }
  );

  let orders = rowsOf(data).map(mapKitchenOrder);

  const search = query.search?.trim().toLowerCase();
  if (search) {
    orders = orders.filter((o) => {
      const hay = [
        o.code,
        o.customer,
        o.area,
        o.deliveryLine,
        ...o.lines.map((l) => l.name),
        ...o.lines.map((l) => l.description ?? ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(search);
    });
  }

  return { orders, total: count ?? orders.length };
}

type KitchenTarget = "kitchen" | "ready" | "cancelled";

const KITCHEN_TRANSITIONS: Record<string, ReadonlyArray<KitchenTarget>> = {
  placed: ["kitchen", "cancelled"],
  kitchen: ["ready", "cancelled"],
  ready: ["cancelled"],
};

/**
 * Tell both sides of the order what just happened — and, since dispatch exists,
 * a third side: the rider who should be heading for the shop.
 *
 * Pushes are fire-and-forget by contract (order-events swallows its own
 * failures) and are therefore not awaited: the transition is already committed,
 * and a push outage must never undo a status the database has accepted.
 *
 * The refund IS awaited, because whether the money is coming back is part of
 * the sentence we are about to send the customer. Dispatch writes the offer
 * row the driver board reads, so it goes through `after()` (deferNotify) —
 * guaranteed to finish, without holding the kitchen's tap while riders are
 * ranked. Like the pushes it swallows its own failures.
 */
async function announceKitchenTransition(
  orderId: string,
  status: "kitchen" | "ready" | "cancelled",
  restaurantName: string | undefined,
  actorId: string
): Promise<void> {
  if (status === "kitchen") {
    deferNotify(() => notifyOrderAccepted(orderId, restaurantName));
    // Accepted: every phone on the restaurant account stops ringing.
    deferNotify(() => stopVendorRing(orderId));
    // And the other half of the acceptance, which nobody used to be told: a
    // rider. Orders only ever surfaced to couriers at `ready`, i.e. once the
    // food was already on the pass, so every road leg began from a standing
    // start. dispatchOrder picks the rider who is not mid-delivery (and, among
    // those, the nearest to this shop) and sends them the prep estimate so they
    // can be at the counter when the bag is.
    //
    // After the response, through `after()` (deferNotify): it WRITES the offer
    // row, so it must not be abandoned when the invocation ends — which is what
    // `after()` guarantees — but it no longer has to be waited on. Awaiting it
    // here held the kitchen's own Accept for several seconds (6.6 s measured
    // in the 28 Sept live test) while riders were ranked.
    deferNotify(() => dispatchOrder(orderId, "accepted"));
    return;
  }

  if (status === "ready") {
    deferNotify(() => notifyOrderReady(orderId));
    // Re-run rather than reuse the rider picked at acceptance: twenty minutes
    // of cooking later, that rider may be halfway across town with somebody
    // else's dinner. This is also what re-stamps `offered_at`, i.e. what starts
    // the exclusivity window the board and `acceptDelivery` both read — so it
    // runs after the response, like the acceptance branch above.
    deferNotify(() => dispatchOrder(orderId, "ready"));
    return;
  }

  // A vendor rejecting a PAID online order used to leave the customer's money
  // exactly where it was: no refund row, no admin queue entry, nothing anyone
  // could act on. queueRefundForOrder is idempotent (0026 allows one pending
  // refund per order) and answers queued:false for an order that was never
  // paid — a COD rejection costs one cheap round trip and claims nothing.
  let refundQueued = false;
  try {
    const result = await queueRefundForOrder(orderId, {
      origin: "vendor_rejected",
      requestedBy: actorId,
    });
    refundQueued = result.queued;
  } catch (err) {
    // The cancellation is already committed. Throwing here would tell the
    // vendor their rejection failed and invite a retry that can now only ever
    // return invalid_transition — so surface it in the logs, and say nothing to
    // the customer about a refund we did not actually manage to queue.
    console.error(
      `[vendor-orders] refund could not be queued for ${orderId}`,
      err
    );
  }

  // The kitchen is not making this order, so any rider dispatch asked to come
  // and get it — offered or already accepted — should stop being asked, and
  // stop being able to complete it. See cancelDeliveryForOrder's own comment
  // for why an already-accepted delivery is cancelled rather than deleted.
  await cancelDeliveryForOrder(orderId);

  deferNotify(() => notifyOrderCancelled(orderId, { byVendor: true, refundQueued }));
  // Rejected: stop the ring too.
  deferNotify(() => stopVendorRing(orderId));
}

/**
 * Vendor kitchen status update — requires restaurant ownership and a valid
 * transition from the order's current status.
 *
 * This is also where the transition gets announced. Every path that moves a
 * kitchen order goes through here, so putting the notifications in the route
 * handler would only mean the next caller forgets them — and a transition
 * nobody is told about is the bug the customer experiences as silence.
 *
 * `accepted_at` / `ready_at` / `cancelled_at` are deliberately NOT written:
 * 0026 stamps them from a trigger, and guard_order_update() rejects any update
 * that touches them.
 */
export async function updateKitchenOrderStatus(
  orderId: string,
  status: "kitchen" | "ready" | "cancelled",
  /**
   * Why, when the kitchen is rejecting. Stored on the order and shown to the
   * customer verbatim (0051) — five unexplained cancellations in a row is the
   * complaint this exists to answer. Ignored for any other transition, where a
   * reason would be a sentence attached to nothing.
   *
   * `cancelled_by` is NOT passed: this write goes out on the vendor's own
   * client, so the trigger works out for itself that a shop owner did it, and
   * a value supplied here would be discarded anyway.
   */
  reason?: string | null,
  /**
   * Accept only: the prep time the kitchen promises (1–180, 0061). Absent →
   * the shop's default applies. Ignored on a database without 0061.
   */
  prepMinutes?: number | null
): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data: order, error: loadError } = await supabase
    .from("orders")
    .select("id, status, restaurant_id, restaurants!inner(owner_id, name)")
    .eq("id", orderId)
    .maybeSingle();

  if (loadError) throw loadError;
  if (!order) return false;

  const restaurant = Array.isArray(order.restaurants)
    ? order.restaurants[0]
    : order.restaurants;
  if (!restaurant || restaurant.owner_id !== user.id) {
    throw new Error("forbidden");
  }

  const allowed = KITCHEN_TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(status)) {
    throw new Error("invalid_transition");
  }

  const { data, error } =
    status === "cancelled"
      ? await cancelOrderRow(
          (patch) =>
            supabase
              .from("orders")
              .update(patch)
              .eq("id", orderId)
              .eq("status", order.status)
              .select("id")
              .maybeSingle(),
          { reason }
        )
      : await supabase
          .from("orders")
          .update(
            status === "kitchen" && prepMinutes && !columnKnownMissing(PREP_COLUMNS)
              ? { status, prep_minutes: prepMinutes }
              : { status }
          )
          .eq("id", orderId)
          .eq("status", order.status)
          .select("id")
          .maybeSingle();

  if (error) throw error;
  // The `.eq("status", order.status)` above is the optimistic lock: no row back
  // means somebody else moved this order between our read and our write, so
  // nothing transitioned here and there is nothing to announce.
  if (!data?.id) return false;

  const restaurantName =
    typeof restaurant.name === "string" ? restaurant.name : undefined;
  await announceKitchenTransition(orderId, status, restaurantName, user.id);

  return true;
}

/**
 * Accepted → Preparing (0061). Goes through `start_preparing`, which checks
 * ownership and state inside the database: `preparing_at` is not writable
 * through the table. Throws `invalid_transition` when the order isn't an
 * accepted order of this vendor's (or was already started).
 */
export async function startPreparing(orderId: string): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_preparing", { p_order: orderId });
  if (error) {
    if (String(error.message).includes("invalid_transition")) {
      throw new Error("invalid_transition");
    }
    throw error;
  }
  return String(data);
}

/** One step in an order's history (0061 `order_status_events`). */
export interface VendorOrderEvent {
  kind: "status" | "preparing";
  from: string | null;
  to: string | null;
  /** Who moved it, from the kitchen's point of view. */
  by: "you" | "customer" | "deligro";
  reason: string | null;
  at: string;
}

/** Statuses during which the kitchen may still need to call the customer (§15.8). */
const ACTIVE_STATUSES = new Set(["placed", "kitchen", "ready", "on_the_way"]);

/**
 * Everything the Partner app shows about one order: the lines and money, the
 * customer (phone only while the order is active), the status history, and at
 * pickup the handover code and the rider. RLS scopes the read to the
 * vendor's own orders; the restaurant id pins it to the active shop.
 */
export async function getVendorOrderDetail(
  orderId: string,
  restaurantId: string
): Promise<(KitchenOrder & { events: VendorOrderEvent[] }) | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await selectVendorOrders<Record<string, unknown>[]>((columns) =>
    supabase
      .from("orders")
      .select(`${columns}, customer_id`)
      .eq("id", orderId)
      .eq("restaurant_id", restaurantId)
      .limit(1)
      .overrideTypes<Record<string, unknown>[]>()
  );
  const row = rowsOf(data)[0] as (VendorOrderRow & { customer_id?: string }) | undefined;
  if (!row) return null;

  const active = ACTIVE_STATUSES.has(row.status);
  if (row.status === "ready" || row.status === "on_the_way") {
    const codes = await getKitchenPickupOtps([row.id]);
    row.pickup_otp = codes.get(row.id) ?? null;
  }
  const order = mapKitchenOrder(row);
  if (!active && order.customerProfile) {
    order.customerProfile = { ...order.customerProfile, phone: null };
  }
  if (row.status === "ready" || row.status === "on_the_way") {
    order.rider = (await ridersForOrders([row.id])).get(row.id) ?? null;
  }

  let events: VendorOrderEvent[] = [];
  if (!columnKnownMissing(PREP_COLUMNS)) {
    const { data: rows } = await supabase
      .from("order_status_events")
      .select("kind, from_status, to_status, actor_id, reason, created_at")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true });
    events = ((rows ?? []) as {
      kind: "status" | "preparing";
      from_status: string | null;
      to_status: string | null;
      actor_id: string | null;
      reason: string | null;
      created_at: string;
    }[]).map((e) => ({
      kind: e.kind,
      from: e.from_status,
      to: e.to_status,
      by: e.actor_id === user.id ? "you" : e.actor_id && e.actor_id === row.customer_id ? "customer" : "deligro",
      reason: e.reason,
      at: e.created_at,
    }));
  }

  return { ...order, events };
}
