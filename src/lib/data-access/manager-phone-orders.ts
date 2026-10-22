import "server-only";
import { readLiveDishes } from "@/lib/menu/live";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveAccountByPhone } from "@/lib/auth/customer-account";
import { toE164 } from "@/lib/auth/phone";
import { getVendorPaymentRules } from "@/lib/payments/vendor-rules";
import { refusePayment } from "@/lib/payments/cod-rules";
import { computeChargesWith, type OrderCharges } from "@/lib/pricing";
import { effectivePrice } from "@/lib/utils/cart";
import { getSettings } from "@/lib/settings";
import { shortOrderId } from "@/lib/utils/order-map";
import {
  notifyOrderPlaced,
  notifyVendorNewOrder,
} from "@/lib/notifications/order-events";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import type { Profile } from "@/lib/auth";
import { deferNotify } from "@/lib/notifications/defer";
import { foldIntoAddressLine, normalizeInstructions } from "@/lib/orders/instructions";
import { writeWithColumnFallback } from "@/lib/data-access/column-fallback";
import { INSTRUCTIONS_COLUMN } from "@/lib/data-access/order-instructions";

/**
 * Phone-in orders — the job the manager role was created for.
 *
 * Someone rings the shop instead of using the app; an operator takes the order
 * and puts it into the same pipeline as every other one. From the kitchen's
 * side and the rider's side there is nothing special about it, which is the
 * point: a phone order is an order, not a parallel system.
 *
 * ## Why the write is a service-role call
 *
 * Migration 0023 gave a manager read-and-advance on `orders` and withheld
 * INSERT on purpose, saying so in its header. That still holds. An INSERT
 * policy is a privilege the role carries everywhere — including into a raw
 * PostgREST call whose body a manager writes themselves, with any customer_id,
 * any total and no attribution. What a phone order actually needs is much
 * narrower: one function that computes the money from the database's own
 * prices, pins the customer to the number that rang, and stamps who took the
 * call. That is a code path, not a privilege, so it is built as one.
 *
 * The bargain that makes it safe is `placed_by` (migration 0029). Every row
 * this file writes says which operator wrote it, the column is locked against
 * every later update, and the path refuses to run at all on a database that
 * cannot record it. An unattributable order in someone else's name is the exact
 * thing being guarded against, so producing one is not an acceptable
 * degradation — see `assertProvenance()`.
 *
 * Reads are ordinary RLS reads through the manager's own JWT. The catalog is
 * public, `profiles` is granted to managers by 0023, and routing either through
 * the service role would convert a deliberate limit into no limit.
 */

/** Set by 0029. Its absence is what `phoneOrdersReady()` reports. */
const CHANNEL_COLUMN = "orders.channel";

/** A sane ceiling on one call's order — a typo in a qty box is not a 400-item order. */
const MAX_QTY_PER_LINE = 50;
const MAX_LINES = 40;

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

/**
 * Is this database able to record a phone order?
 *
 * Checked before the composer renders rather than after the operator has typed
 * out someone's dinner: the answer is a property of the deployment, not of the
 * order, so learning it at submit time wastes a call the customer is on.
 */
export async function phoneOrdersReady(): Promise<boolean> {
  if (columnKnownMissing(CHANNEL_COLUMN)) return false;

  const supabase = await createClient();
  const { error } = await supabase.from("orders").select("channel").limit(1);

  if (error && isMissingColumn(error)) {
    rememberColumn(CHANNEL_COLUMN, false);
    return false;
  }
  // Anything else — offline, RLS not applied — is not evidence about the
  // schema, so it is neither cached nor reported as "migration missing".
  // Telling an operator to apply a migration that is already applied sends
  // them somewhere the problem isn't; let the caller show a load failure.
  if (error) throw error;

  rememberColumn(CHANNEL_COLUMN, true);
  return true;
}

/* ------------------------------------------------------------------ *
 * Looking the caller up
 * ------------------------------------------------------------------ */

export interface CallerLookup {
  /** E.164, the form everything else in the app stores and compares. */
  phone: string;
  /** Null when no account holds this number — the order will create one. */
  existing: { name: string | null; isStaff: boolean; status?: "active" | "suspended" | "restricted" } | null;
}

/**
 * Who owns this number, if anyone.
 *
 * Deliberately returns a name and nothing else. A manager taking a call needs
 * to greet the right person and to know whether they are about to create an
 * account; they do not need the caller's address history, and this screen is
 * not a customer-lookup tool wearing a phone-order hat.
 *
 * `isStaff` exists because attaching an order to a vendor's or a rider's own
 * account is legitimate but surprising — the operator should see it before they
 * commit, not discover it on the board afterwards.
 */
export async function lookupCaller(raw: string): Promise<CallerLookup | null> {
  const phone = toE164(raw);
  if (!phone) return null;

  // 0162: a first-time caller has no order in the manager's zones, so the
  // scoped profiles policy would hide them; ops_lookup_caller answers the
  // desk's one question (who is this, staff or not, can they order) and
  // nothing else — never an id, never a phone.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ops_lookup_caller", { p_phone: phone });
  if (error || !data) return { phone, existing: null };

  const row = data as { name: string | null; is_staff: boolean; status?: string };
  const status = row.status === "suspended" || row.status === "restricted" ? row.status : "active";
  return { phone, existing: { name: row.name?.trim() || null, isStaff: row.is_staff, status } };
}

/* ------------------------------------------------------------------ *
 * The catalog, as an order-taker needs it
 * ------------------------------------------------------------------ */

export interface OrderableShop {
  slug: string;
  name: string;
  open: boolean;
}

/**
 * Every approved shop, open or not, alphabetically.
 *
 * Closed shops are listed and marked rather than hidden. An operator whose
 * caller has asked for a restaurant that isn't in the list has to work out
 * whether it is closed, unapproved or misspelled while somebody waits on the
 * line; saying "closed" is one word and answers it.
 */
export async function listOrderableShops(): Promise<OrderableShop[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select("slug, name, is_open")
    .eq("approved", true)
    .order("name");

  if (error) throw error;

  return ((data ?? []) as { slug: string; name: string; is_open: boolean }[]).map(
    (r) => ({ slug: r.slug, name: r.name, open: r.is_open })
  );
}

interface OrderableItem {
  /** `external_id ?? id`, matching how the customer app identifies a dish. */
  id: string;
  name: string;
  price: number;
  category: string;
  veg: boolean;
}

export interface ShopMenu {
  slug: string;
  name: string;
  open: boolean;
  /** Sold-out dishes are dropped here — you cannot order what the kitchen hasn't got. */
  items: OrderableItem[];
}

/**
 * One shop's orderable menu.
 *
 * Narrower than `getRestaurantFromDb()` on purpose: that returns the storefront
 * — photography, ratings, popularity ranking, an ETA band — and none of it
 * helps someone typing an order dictated down a phone. What helps is a flat,
 * searchable list of names and prices, which is what this is.
 */
export async function getShopMenu(slug: string): Promise<ShopMenu | null> {
  const supabase = await createClient();
  // Managers can read pending and hidden dishes (0146); the phone menu offers
  // only what a customer could order.
  const { data, error } = await readLiveDishes((live) =>
    live(
      supabase
        .from("restaurants")
        .select(
          "slug, name, is_open, menu_items(id, external_id, name, price, discount_price, veg, available, category)"
        )
        .eq("slug", slug)
        .eq("approved", true),
      "menu_items"
    ).maybeSingle()
  );

  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as {
    slug: string;
    name: string;
    is_open: boolean;
    menu_items:
      | {
          id: string;
          external_id: string | null;
          name: string;
          price: number;
          discount_price: number | null;
          veg: boolean;
          available: boolean;
          category: string | null;
        }[]
      | null;
  };

  const items = (row.menu_items ?? [])
    .filter((m) => m.available)
    .map((m) => ({
      // `external_id ?? id` is the identity the whole app uses for a dish
      // (see mapMenuItem) — matching it here means the id this screen hands
      // back is the same one every other order path speaks.
      id: m.external_id ?? m.id,
      name: m.name,
      // What the dish is actually sold for, discount honoured — the same
      // `effectivePrice` the storefront shows and `createOrder` bills, so the
      // operator quotes the caller the price the app shows.
      price: effectivePrice(m.price, m.discount_price),
      category: m.category ?? "Menu",
      veg: m.veg,
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  return { slug: row.slug, name: row.name, open: row.is_open, items };
}

/* ------------------------------------------------------------------ *
 * Placing it
 * ------------------------------------------------------------------ */

interface PhoneOrderLine {
  itemId: string;
  qty: number;
}

export interface PhoneOrderInput {
  /** As typed by the operator; normalised to E.164 here. */
  phone: string;
  /** Optional. Only ever fills a blank name — see `resolveAccountByPhone`. */
  customerName?: string;
  restaurantSlug: string;
  lines: PhoneOrderLine[];
  /** Dictated over the phone; there is no saved-address picker on this path. */
  address: { label: string; line: string };
  /**
   * Anything the caller said that the rider or kitchen needs. Stored as the
   * order's delivery instructions (at most 300 characters), not folded into the
   * address line.
   */
  note?: string;
}

export interface PhoneOrderResult {
  orderId: string;
  /** The `#ABC12345` form the boards and notifications use. */
  code: string;
  charges: OrderCharges;
  customerName: string;
  /** True when this call brought a brand-new person onto the platform. */
  customerCreated: boolean;
}

/**
 * Every way this can fail that the operator can do something about. Anything
 * else throws and surfaces as a generic failure — an operator on a call cannot
 * act on a Postgres error string, and showing them one only delays the retry.
 */
export type PhoneOrderError =
  | "not_migrated"
  | "invalid_phone"
  | "restaurant_not_found"
  | "restaurant_closed"
  | "empty_cart"
  | "invalid_items"
  | "too_many_items"
  | "account_failed"
  | "cod_not_accepted"
  | "cod_over_limit"
  | "instructions_too_long"
  | "account_restricted"
  | "order_not_created";

class PhoneOrderFailure extends Error {
  constructor(public readonly code: PhoneOrderError) {
    super(code);
    this.name = "PhoneOrderFailure";
  }
}

export function phoneOrderErrorCode(err: unknown): PhoneOrderError | null {
  return err instanceof PhoneOrderFailure ? err.code : null;
}

/**
 * Refuse to place an unattributable order.
 *
 * The whole justification for a service-role insert on someone else's account
 * is that the row records who did it. On a database without 0029 there is no
 * such column, so the order would be indistinguishable from one the customer
 * placed themselves — the audit trail this feature is *built on* would simply
 * be absent, silently, for as long as nobody noticed.
 *
 * This is the same call migration 0013's tip branch makes in `createOrder`:
 * when the database cannot record the thing that makes an action legitimate,
 * refuse the action rather than perform it and lose the record.
 */
async function assertProvenance(): Promise<void> {
  if (!(await phoneOrdersReady())) throw new PhoneOrderFailure("not_migrated");
}

/** At least one line, and no more than one call can sensibly dictate. */
function assertCartSize(lines: PhoneOrderLine[]): void {
  if (!lines.length) throw new PhoneOrderFailure("empty_cart");
  if (lines.length > MAX_LINES) throw new PhoneOrderFailure("too_many_items");
}

/** The name the operator gave, or what to call a caller who gave none. */
function customerLabel(name: string | undefined, isNewUser: boolean): string {
  return name?.trim() || (isNewUser ? "New customer" : "Customer");
}

/**
 * Merge duplicates before validating: "2 naan" typed twice is 4 naan, not two
 * lines the order_items table will show the kitchen as separate dishes.
 */
function mergeLines(lines: PhoneOrderLine[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const line of lines) {
    const qty = Math.trunc(Number(line.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      throw new PhoneOrderFailure("invalid_items");
    }
    merged.set(line.itemId, (merged.get(line.itemId) ?? 0) + qty);
  }
  return merged;
}

interface PricedMenuItem {
  id: string;
  external_id: string | null;
  name: string;
  price: number;
  discount_price: number | null;
  available: boolean;
}

/**
 * Price the merged lines against the shop's menu as the database holds it.
 * Throws `invalid_items` for a dish that is missing, unavailable or over the
 * per-line cap.
 */
function priceLines(
  merged: Map<string, number>,
  menuItems: PricedMenuItem[]
): {
  itemSubtotal: number;
  orderItems: { menu_item_id: string; name: string; qty: number; price: number }[];
} {
  const byId = new Map<string, PricedMenuItem>();
  for (const item of menuItems) byId.set(item.external_id ?? item.id, item);

  let itemSubtotal = 0;
  const orderItems: {
    menu_item_id: string;
    name: string;
    qty: number;
    price: number;
  }[] = [];

  for (const [itemId, qty] of merged) {
    const item = byId.get(itemId);
    if (!item?.available || qty > MAX_QTY_PER_LINE) {
      throw new PhoneOrderFailure("invalid_items");
    }
    // Same price the storefront charges (discount honoured). Using the list
    // price here billed a phone customer more than an app customer for the
    // same dish.
    const unitPrice = effectivePrice(item.price, item.discount_price);
    itemSubtotal += unitPrice * qty;
    orderItems.push({
      menu_item_id: item.id,
      name: item.name,
      qty,
      price: unitPrice,
    });
  }
  return { itemSubtotal, orderItems };
}

/**
 * Take an order on behalf of a caller.
 *
 * `actor` is the operator whose session authorized this, and it is re-checked
 * here rather than trusted from the caller. Everything below runs on the
 * service-role client, which has no role of its own to fall back on: if this
 * function is ever reached from a path that forgot its `requireRole`, the check
 * in the same scope as the privileged client is the one that still holds.
 */
export async function placePhoneOrder(
  actor: Profile,
  input: PhoneOrderInput
): Promise<PhoneOrderResult> {
  // AGENTS.md #5: createAdminClient() bypasses RLS, so an authorization check
  // lives above every call to it in the same path. This is that check — the
  // server action's requireRole() is the first one, not the only one.
  if (actor.role !== "manager" && actor.role !== "admin") {
    throw new Error("unauthorized");
  }

  await assertProvenance();

  const phone = toE164(input.phone);
  if (!phone) throw new PhoneOrderFailure("invalid_phone");

  assertCartSize(input.lines);

  // The caller's note, checked before anything is written.
  const noted = normalizeInstructions(input.note);
  if (!noted.ok) throw new PhoneOrderFailure("instructions_too_long");
  const instructions = noted.value;

  const admin = createAdminClient();

  // ---- the shop -------------------------------------------------------
  // Approved and open, exactly as createOrder requires. A manager is an
  // operator, not an override: a closed kitchen has said it cannot cook, and
  // "the customer is on the phone" does not change that. The platform-wide
  // `acceptingOrders` switch is surfaced to the operator as a warning instead —
  // see the composer — because that one is a business pause, not a kitchen
  // saying no, and taking the call may be the whole point of pausing the app.
  const { data: restaurant, error: shopError } = await admin
    .from("restaurants")
    .select("id, name, is_open")
    .eq("slug", input.restaurantSlug)
    .eq("approved", true)
    .maybeSingle();

  if (shopError) throw shopError;
  if (!restaurant?.id) throw new PhoneOrderFailure("restaurant_not_found");
  if (!restaurant.is_open) throw new PhoneOrderFailure("restaurant_closed");

  // ---- the items, priced by the database ------------------------------
  // The composer sends dish ids and quantities and never an amount, so what an
  // operator sees on screen has no authority over what the customer is billed.
  const { data: menuItems, error: menuError } = await readLiveDishes((live) =>
    live(
      admin
        .from("menu_items")
        .select("id, external_id, name, price, discount_price, available")
        .eq("restaurant_id", restaurant.id)
    )
  );

  if (menuError) throw menuError;

  const { itemSubtotal, orderItems } = priceLines(
    mergeLines(input.lines),
    menuItems ?? []
  );

  // ---- the bill -------------------------------------------------------
  // The same arithmetic and the same live platform settings the app checkout
  // bills with. A phone order is not a discount channel.
  const settings = await getSettings();
  const charges = computeChargesWith(
    {
      deliveryFee: settings.deliveryFee,
      taxRate: settings.taxRate,
      freeDeliveryThreshold: settings.freeDeliveryThreshold,
    },
    itemSubtotal,
    // No tip. The tip UI asks the customer to choose one at checkout, and there
    // is no checkout here — an operator picking a tip on someone's behalf is
    // adding a charge the caller never agreed to.
    0
  );

  // ---- can this shop take cash for this amount? -----------------------
  // A phone order is always COD (see the insert below), so the shop's cash
  // rules decide whether it can be taken at all. Checked here rather than left
  // to the app checkout's copy of the rule: an operator on a live call needs to
  // hear "that shop only takes cash up to ₹300" while the caller is still on
  // the line, not after the order has been written.
  const rules = await getVendorPaymentRules(restaurant.id);
  const refusal = refusePayment(rules, "cod", charges.total);
  if (refusal === "cod_limit_exceeded") {
    throw new PhoneOrderFailure("cod_over_limit");
  }
  if (refusal) throw new PhoneOrderFailure("cod_not_accepted");

  // ---- the customer ---------------------------------------------------
  // After the validation above, so a mistyped dish doesn't leave a new account
  // behind for an order that was never placed.
  const account = await resolveAccountByPhone(phone, {
    fullName: input.customerName,
  });
  if (!account) throw new PhoneOrderFailure("account_failed");

  // ---- the order ------------------------------------------------------
  const addressLabel = input.address.label.trim() || "Phone order";
  const addressText = input.address.line.trim();

  const insertOrder = (withInstructions: boolean) =>
    admin
      .from("orders")
      .insert({
        customer_id: account.id,
        restaurant_id: restaurant.id,
        status: "placed",
        delivery_fee: charges.deliveryFee,
        tax_amount: charges.taxes,
        tip: 0,
        // Placeholder: recompute_order_total() below writes the authoritative sum.
        total: 0,
        // The note rides on its own column (0082). Where the database has not
        // got it yet it goes back onto the end of the address, as it always did.
        address: {
          label: addressLabel,
          line:
            withInstructions || !instructions
              ? addressText
              : foldIntoAddressLine(addressText, instructions, " · "),
        },
        ...(withInstructions && instructions ? { delivery_instructions: instructions } : {}),
        // Cash, always. There is no way to take a card over a phone call in this
        // app — an online phone order would need a payment link the customer
        // opens, which does not exist — and `force_order_payment_pending` does
        // not fire for the service role, so 'pending' is stated rather than
        // assumed. A rider collects at the door like any other COD order.
        payment_method: "cod",
        payment_status: "pending",
        // The provenance that makes this insert defensible. Locked by 0029's
        // guard the instant this statement commits.
        channel: "phone",
        placed_by: actor.id,
      })
      .select("id")
      .single();

  const { data: order, error: orderError } = instructions
    ? await writeWithColumnFallback(
        {
          knownMissing: () => columnKnownMissing(INSTRUCTIONS_COLUMN),
          remember: (present) => rememberColumn(INSTRUCTIONS_COLUMN, present),
        },
        insertOrder
      )
    : await insertOrder(false);

  // 0162: Deligro suspended or restricted this caller's account.
  if (orderError && String((orderError as { message?: string }).message ?? "").includes("account_restricted")) {
    throw new PhoneOrderFailure("account_restricted");
  }
  if (orderError) throw orderError;
  if (!order) throw new PhoneOrderFailure("order_not_created");

  const { error: itemsError } = await admin
    .from("order_items")
    .insert(orderItems.map((i) => ({ ...i, order_id: order.id })));

  // An order with no lines is worse than no order: the kitchen sees a ticket
  // with nothing on it and the customer is billed a delivery fee for air. Roll
  // it back — `order_items` cascades, and nothing downstream has run yet.
  if (itemsError) {
    await admin.from("orders").delete().eq("id", order.id);
    throw itemsError;
  }

  const { error: totalError } = await admin.rpc("recompute_order_total", {
    oid: order.id,
  });
  if (totalError) {
    await admin.from("orders").delete().eq("id", order.id);
    throw totalError;
  }

  // Fire-and-forget, exactly as createOrder does: the order is already real and
  // a push outage must not fail one that is.
  //
  // The customer is notified too — they may well have the app installed even
  // though they rang, and a confirmation for an order somebody else typed on
  // their behalf is the one case where a notification is genuinely load-bearing:
  // it is how a caller finds out if the number was misheard.
  deferNotify(() => notifyOrderPlaced(order.id));
  deferNotify(() => notifyVendorNewOrder(order.id, orderItems.length));

  return {
    orderId: order.id,
    code: `#${shortOrderId(order.id)}`,
    charges,
    customerName: customerLabel(input.customerName, account.isNewUser),
    customerCreated: account.isNewUser,
  };
}
