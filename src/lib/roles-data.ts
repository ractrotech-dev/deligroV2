/* ============================================================
   Mock data for the role dashboards (Driver / Restaurant / Admin).
   Phase 1 = static UI. In production these come from the SAME backend
   API as the customer app, gated by server-side role + ownership checks
   (a /driver URL is a UI convenience, not a security boundary).
   Money is whole rupees — render with formatINR().
   ============================================================ */

import type { PaymentMethod, PaymentStatus } from "@/types";

interface RoleOrderLine {
  name: string;
  qty: number;
  price: number;
  description?: string | null;
  imageUrl?: string | null;
}

/* ---------- Restaurant (merchant) ---------- */
interface KitchenOrderCustomer {
  name: string;
  phone: string | null;
  initials: string;
}

export interface KitchenOrder {
  id: string;
  code: string; // short human ref, e.g. "#D-4821"
  customer: string;
  customerProfile?: KitchenOrderCustomer;
  area: string;
  deliveryLine?: string;
  placedAgo: string; // "2 min ago"
  placedAt: string; // absolute date/time for history cards
  lines: RoleOrderLine[];
  total: number;
  note?: string;
  status?: string;
  /**
   * How this order is being paid, once migration 0025 is applied. Undefined on
   * a database that predates it (where every order is COD by definition).
   *
   * The kitchen and the rider both need this and neither had it: with online
   * payment on, a rider who assumes cash will ask a prepaid customer to pay
   * twice.
   */
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  /** When the kitchen accepted / packed it (0026) — drives the late badge. */
  acceptedAt?: string | null;
  readyAt?: string | null;
  /**
   * `orders.pickup_otp` (0006) — the code the counter reads to the rider at
   * collection, and which the rider must then enter to mark the pickup. Shown
   * on the Ready column only: it is the kitchen's proof that the person taking
   * the bag is the courier this order was assigned to.
   */
  pickupOtp?: string | null;
  /**
   * The rider on this order once one has taken it — Ready column only. The
   * kitchen used to have no idea who was coming, or that the bag had already
   * left: the card sat in Ready until the order was delivered.
   */
  rider?: KitchenOrderRider | null;
}

export interface KitchenOrderRider {
  name: string;
  /** `assigned`: heading to the counter. `picked_up`: has the food. */
  stage: "assigned" | "picked_up";
}

/* ---------- Driver (rider) ---------- */

/**
 * One end of a delivery, as a rider needs to read it.
 *
 * `area` is the short line a card can show without wrapping — a shop name, a
 * "Home"/"Work" label. `address` is the thing you can actually find: the street
 * line the customer typed, flat number and entry code included, or the address
 * the vendor pinned. They are separate fields because the board used to have
 * only the first one and call it an address, which is how a rider ended up
 * standing in a lane with the word "Home" on their screen.
 *
 * `address` is optional because it genuinely may not be recorded — a shop that
 * has never been pinned (pre-0009), an order imported from the legacy system.
 * The UI says so in that case rather than leaving a blank line where the
 * directions should be.
 */
export interface DeliveryStop {
  /** Short label: the shop's name, or the customer's "Home"/"Work". */
  area: string;
  /** The findable address. Undefined when none was ever recorded. */
  address?: string;
  /** Landmark/pincode tail, when the shop or address carries one. */
  landmark?: string;
  /** Map pin, when this end has one. */
  point?: { lat: number; lng: number };
}

export interface DeliveryJob {
  id: string;
  code: string;
  restaurant: string;
  pickup: DeliveryStop;
  drop: DeliveryStop;
  /** Undefined when the shop or the address has no coordinates. */
  distanceKm?: number;
  items: number;
  customer: string;
}

export const AVAILABLE_JOBS: DeliveryJob[] = [
  {
    id: "j-2201",
    code: "#D-4821",
    restaurant: "Saffron Kitchen",
    pickup: {
      area: "Saffron Kitchen",
      address: "12, 6th Block, Koramangala",
      landmark: "Opposite Jyoti Nivas College",
    },
    drop: {
      area: "Home",
      address: "402, Ashirwad Residency, 5th Block, Koramangala",
      landmark: "Gate 2",
    },
    distanceKm: 2.3,
    items: 4,
    customer: "Aarav M.",
  },
  {
    id: "j-2202",
    code: "#B-9910",
    restaurant: "Blue Tokai Cafe",
    pickup: { area: "Blue Tokai Cafe", address: "946, 12th Main, Indiranagar" },
    drop: {
      area: "Work",
      address: "Prestige Atlanta, 80 Feet Road, Domlur",
      landmark: "Tower B reception",
    },
    distanceKm: 3.1,
    items: 2,
    customer: "Karan V.",
  },
  {
    id: "j-2203",
    code: "#P-3345",
    restaurant: "Pizza Loft",
    pickup: { area: "Pizza Loft", address: "27, HSR Sector 1" },
    drop: { area: "Home", address: "8, 14th Main, HSR Sector 4" },
    distanceKm: 1.8,
    items: 3,
    customer: "Divya N.",
  },
];

/**
 * The demo rider's day. `earnings`, `onlineHours` and `rating` are gone: the
 * board no longer shows a money figure (riders here are salaried — see the
 * "Salary model on the board" task in build-plan.ts), and the other two were
 * numbers this platform has never tracked for anybody.
 */
export const DRIVER_TODAY = {
  trips: 12,
};

/* ---------- Admin ---------- */

export interface AdminOrderRow {
  /** The real order id, for drilling into the detail view. */
  id?: string;
  code: string;
  customer: string;
  restaurant: string;
  /**
   * READY is its own stage now. It used to be folded into KITCHEN, so an
   * operator could not tell a kitchen that was still cooking from one whose
   * food had been sitting on the pass waiting for a rider — which is the state
   * they most need to see.
   */
  status: "PLACED" | "KITCHEN" | "READY" | "ON_THE_WAY" | "DELIVERED" | "CANCELLED";
  total: number;
  /** Formatted for display, e.g. "24 Jul, 8:24 PM". Not parseable — see below. */
  placedAt: string;
  /**
   * The raw `created_at`, for anything that needs to do arithmetic on the age
   * of an order. `placedAt` is a localised string; parsing it back to a time is
   * guesswork. Absent on the demo seed rows, which have no real timestamp.
   */
  placedAtIso?: string;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  /** Minutes past the expected handover, when the order is running late. */
  lateByMinutes?: number | null;
  /**
   * What was ordered, name and quantity only — enough to answer "what did they
   * order?" without opening the row, which is the question an operator on a
   * phone call actually has. Prices are not here; the detail view prints the
   * bill. Empty when every line was unnamed (legacy imports), never faked.
   */
  items?: { name: string; qty: number }[];
  /** Units across all lines, so "3 items" doesn't have to be recomputed per render. */
  itemCount?: number;
  /**
   * What the platform keeps from this order — commission + GST on commission +
   * other charges, at the vendor's own rate. Null for a cancelled order (no
   * food value to take a cut of) and undefined on the demo seed rows.
   */
  profit?: number | null;
}

export const ADMIN_ORDERS: AdminOrderRow[] = [
  { code: "#D-4823", customer: "Rahul K.", restaurant: "Saffron Kitchen", status: "PLACED", total: 900, placedAt: "24 Jul, 8:24 PM", items: [{ name: "Paneer Butter Masala", qty: 2 }, { name: "Butter Naan", qty: 4 }, { name: "Gulab Jamun", qty: 2 }], itemCount: 8 },
  { code: "#B-9910", customer: "Karan V.", restaurant: "Blue Tokai Cafe", status: "KITCHEN", total: 420, placedAt: "24 Jul, 8:21 PM", items: [{ name: "Cold Coffee", qty: 2 }, { name: "Veg Sandwich", qty: 1 }], itemCount: 3 },
  { code: "#P-3345", customer: "Divya N.", restaurant: "Pizza Loft", status: "ON_THE_WAY", total: 660, placedAt: "24 Jul, 8:14 PM", items: [{ name: "Farmhouse Pizza", qty: 1 }, { name: "Garlic Bread", qty: 2 }], itemCount: 3 },
  { code: "#D-4818", customer: "Neha R.", restaurant: "Saffron Kitchen", status: "ON_THE_WAY", total: 560, placedAt: "24 Jul, 8:09 PM", items: [{ name: "Veg Biryani", qty: 2 }], itemCount: 2 },
  { code: "#S-7781", customer: "Meera J.", restaurant: "South Spice", status: "DELIVERED", total: 340, placedAt: "24 Jul, 7:58 PM", items: [{ name: "Masala Dosa", qty: 2 }, { name: "Filter Coffee", qty: 2 }], itemCount: 4 },
  { code: "#D-4801", customer: "Imran H.", restaurant: "Saffron Kitchen", status: "DELIVERED", total: 720, placedAt: "24 Jul, 7:44 PM", items: [{ name: "Chicken Handi", qty: 1 }, { name: "Tandoori Roti", qty: 6 }], itemCount: 7 },
  { code: "#B-9902", customer: "Sana P.", restaurant: "Blue Tokai Cafe", status: "CANCELLED", total: 210, placedAt: "24 Jul, 7:31 PM", items: [{ name: "Cappuccino", qty: 1 }, { name: "Choco Croissant", qty: 1 }], itemCount: 2 },
];

