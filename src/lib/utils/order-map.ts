import type { Order, OrderStatus, PaymentMethod, PaymentStatus } from "@/types";
import { chosenAddons } from "@/lib/orders/order-options";
import type { Order as DbOrder } from "@/lib/data-access/orders";
import { formatIst, istDateKey, istDaysBetween } from "@/lib/utils/ist-time";
import { translator, type Lang } from "@/lib/i18n/lang";

/**
 * One row per `order_status` value — no folding.
 *
 * `ready` used to map to `KITCHEN`, which is why nobody outside the vendor board
 * could see the stage at all: the customer was told the food was still being
 * cooked while it sat packed on the pass, and the Cancel button stayed on screen
 * offering something the cancel route would refuse.
 */
const DB_TO_UI: Record<string, OrderStatus> = {
  placed: "PLACED",
  kitchen: "KITCHEN",
  ready: "READY",
  on_the_way: "ON_THE_WAY",
  delivered: "DELIVERED",
  cancelled: "CANCELLED",
};

export const ACTIVE_DB_STATUSES = [
  "placed",
  "kitchen",
  "ready",
  "on_the_way",
] as const;

export function dbStatusToUi(status: string): OrderStatus {
  return DB_TO_UI[status] ?? "PLACED";
}

export function formatOrderPlacedAt(iso: string, lang: Lang = "en"): string {
  // Every part of this label is computed in IST, not the runtime's zone. It is
  // built on the server (UTC on Vercel), so the time used to read 5h30m early
  // and "Today"/"Yesterday" flipped at 5:30 am IST instead of midnight.
  const date = new Date(iso);
  const now = new Date();
  const t = translator(lang);
  // The customer app may be in Hindi; operator screens call this without a
  // language and keep the en-IN labels.
  const fmt = (options: Intl.DateTimeFormatOptions) =>
    lang === "hi"
      ? date.toLocaleString("hi-IN", { ...options, timeZone: "Asia/Kolkata" })
      : formatIst(date, options);
  const time = fmt({ hour: "numeric", minute: "2-digit" });
  const days = istDaysBetween(date, now);

  if (days === 0) return t(`Today, ${time}`, `आज, ${time}`);
  if (days === 1) return t(`Yesterday, ${time}`, `कल, ${time}`);

  // Inside the week a weekday is the fastest thing to read.
  if (days < 7) {
    return fmt({
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // Past that it stops being information. Every older order rendered as
  // "Wed, 6:55 pm", so last week and last spring were the same four characters
  // and a history of one regular restaurant became a wall of rows nobody could
  // tell apart or date. Older rows get a real date, and the year once it is not
  // this one.
  const sameYear = istDateKey(date).slice(0, 4) === istDateKey(now).slice(0, 4);
  const day = fmt({
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
}

interface DbMenuItemRef {
  external_id: string | null;
  veg: boolean | null;
}

interface DbOrderItemRow {
  name: string;
  qty: number;
  price: number;
  /** 0062: the chosen size and add-ons, as the order-line guard recorded them. */
  options?: unknown;
  // Null when the dish has since been deleted from the menu — then we genuinely
  // do not know whether it was veg, and must not guess.
  menu_items?: DbMenuItemRef | DbMenuItemRef[] | null;
}

/**
 * A live order, with the fields that only exist once it came from the database.
 *
 * `Order` in `@/types` is the shape the mock catalogue also satisfies, so it
 * carries nothing about money that has (or hasn't) moved. The tracker needs
 * that: whether to offer a refund request, and what to call the total. Extending
 * rather than widening keeps every existing consumer working unchanged — a
 * `UiOrder` is an `Order`.
 */
export interface UiOrder extends Order {
  /** From migration 0025; undefined on a database that predates it (all COD). */
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  /** Raw `created_at`. `placedAt` is a human label and can't be computed from. */
  createdAt?: string;
  /**
   * From migration 0051. Undefined on a database that predates it; null on a
   * row that was cancelled before it was applied. Both mean the same thing to
   * the screen — we do not know — and neither may be dressed up as an answer.
   */
  cancelledBy?: CancelledBy | null;
  cancellationReason?: string | null;
  /**
   * The money breakdown, for the receipt. Absent on a mock order, and each
   * field absent on a database that predates the migration that added it
   * (0013 tip, 0031 discount).
   */
  charges?: OrderCharges;
  /** Where it went. `address` is nullable on the table and on old rows. */
  address?: { label?: string; line?: string } | null;
}

/** Who cancelled it — see `orders.cancelled_by` (0051). */
export type CancelledBy =
  "customer" | "vendor" | "manager" | "admin" | "system";

interface OrderCharges {
  /** Sum of the line items, before anything is added or taken off. */
  subtotal: number;
  deliveryFee: number;
  tax: number;
  tip: number;
  discount: number;
  couponCode?: string | null;
}

const CANCELLED_BY = new Set<string>([
  "customer",
  "vendor",
  "manager",
  "admin",
  "system",
]);

function asCancelledBy(v: string | null | undefined): CancelledBy | null {
  return v && CANCELLED_BY.has(v) ? (v as CancelledBy) : null;
}

/**
 * What to tell the customer about a cancellation.
 *
 * Returns null when we genuinely do not know — a row cancelled before 0051, or
 * a database that has not had it applied. The caller must render nothing in
 * that case rather than guess, because the guess people reach for ("cancelled
 * by the restaurant") is the accusation.
 */
export function cancellationNote(
  order: {
    cancelledBy?: CancelledBy | null;
    cancellationReason?: string | null;
  },
  lang: Lang = "en",
): { who: string; reason?: string } | null {
  const t = translator(lang);
  const reason = order.cancellationReason?.trim() || undefined;
  switch (order.cancelledBy) {
    case "customer":
      return {
        who: t("You cancelled this order", "आपने यह ऑर्डर कैंसिल किया"),
        reason,
      };
    case "vendor":
      return {
        who: t(
          "The restaurant could not take this order",
          "रेस्टोरेंट यह ऑर्डर नहीं ले सका",
        ),
        reason,
      };
    case "manager":
    case "admin":
      return {
        who: t("Cancelled by Deligro support", "Deligro सपोर्ट ने कैंसिल किया"),
        reason,
      };
    case "system":
      return {
        who: t("Cancelled automatically", "अपने आप कैंसिल हो गया"),
        reason,
      };
    default:
      // A reason with no party is still worth showing — it is the sentence
      // somebody actually wrote — but it cannot be attributed to anyone.
      return reason
        ? {
            who: t("This order was cancelled", "यह ऑर्डर कैंसिल हो गया"),
            reason,
          }
        : null;
  }
}

/**
 * Money we are actually holding.
 *
 * `authorized` has not been captured and `refunded` has already gone back, so
 * neither is something to offer a refund against. Getting this wrong in the
 * generous direction means inviting a customer to claim money we never took.
 */
export function isOrderPaid(order: { paymentStatus?: PaymentStatus }): boolean {
  return order.paymentStatus === "paid";
}

export function mapDbOrderRow(row: DbOrder): UiOrder {
  const restaurant = row.restaurants;
  const items = row.order_items as DbOrderItemRow[];

  return {
    id: row.id,
    restaurantSlug: restaurant?.slug ?? "",
    restaurantName: restaurant?.name ?? "Restaurant",
    restaurantImage: (restaurant as { image_url?: string } | null)?.image_url,
    restaurantAccent: (restaurant as { accent_tint?: string } | null)
      ?.accent_tint,
    status: dbStatusToUi(row.status),
    placedAt: formatOrderPlacedAt(row.created_at),
    createdAt: row.created_at,
    // The restaurant's advertised lower edge. Good enough for a list row; the
    // tracking screen computes a real one in `lib/orders/eta.ts` instead.
    etaMinutes:
      (restaurant as { eta_min?: number } | null)?.eta_min ?? undefined,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    cancelledBy: asCancelledBy(row.cancelled_by),
    cancellationReason: row.cancellation_reason ?? null,
    address: row.address,
    charges: {
      subtotal: items.reduce((sum, i) => sum + i.price * i.qty, 0),
      deliveryFee: row.delivery_fee ?? 0,
      tax: row.tax_amount ?? 0,
      tip: row.tip ?? 0,
      discount: row.discount ?? 0,
      couponCode: row.coupon_code ?? null,
    },
    total: row.total,
    lines: items.map((item) => {
      const menu = item.menu_items;
      const menuItem = Array.isArray(menu) ? menu[0] : menu;
      return {
        itemId: menuItem?.external_id ?? item.name,
        name: item.name,
        qty: item.qty,
        price: item.price,
        veg: menuItem?.veg ?? undefined,
        addons: chosenAddons(item.options),
        customised: item.options != null,
      };
    }),
  };
}

export function shortOrderId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 8).toUpperCase();
}
