import type { Tone } from "@/components/admin/console";
import type { AdminOrderRow } from "@/lib/roles-data";

/**
 * How an order's stage is labelled and coloured, in one place.
 *
 * The Orders screen and the dashboard's live board both render this pill, and
 * two copies of the mapping is how "Ready for pickup" ends up amber on one
 * screen and blue on the other. Given a bare `Record`, a missing key is not a
 * blank cell — `ORDER_STATUS[o.status].cls` throws and takes the screen with
 * it, so every member of the union must be present.
 */
export const ORDER_STATUS: Record<
  AdminOrderRow["status"],
  { label: string; short: string; cls: string }
> = {
  // The four steps the admin desk uses: Order placed, Preparing, Picked up,
  // Delivered. READY stays a real state underneath (dispatch runs on it) but
  // reads as Preparing; ON_THE_WAY is set at the moment of pickup.
  PLACED: { label: "Order placed", short: "Order placed", cls: "pill-accent" },
  KITCHEN: { label: "Preparing", short: "Preparing", cls: "pill-accent" },
  READY: { label: "Preparing", short: "Preparing", cls: "pill-accent" },
  ON_THE_WAY: { label: "Picked up", short: "Picked up", cls: "pill-blue" },
  DELIVERED: { label: "Delivered", short: "Delivered", cls: "pill-green" },
  CANCELLED: { label: "Cancelled", short: "Cancelled", cls: "pill-muted" },
};

/** Draw order for filter chips, so they don't reshuffle between renders. */
export const ORDER_STATUS_ORDER: AdminOrderRow["status"][] = [
  "PLACED",
  "KITCHEN",
  "READY",
  "ON_THE_WAY",
  "DELIVERED",
  "CANCELLED",
];

/**
 * The same six stages as console tones, for the places that show a status as a
 * dot and a word rather than as a tinted capsule — which is most of them now.
 *
 * Kept beside `ORDER_STATUS` rather than derived from its `cls` string: the two
 * vocabularies do not map one-to-one (`pill-accent` is the console's orange,
 * `accent` here is the same idea, but `pill-muted` for a cancelled order is a
 * grey capsule where the dot wants to be explicitly neutral), and a lookup that
 * parses a class name to recover a meaning is a lookup waiting to drift.
 *
 * A bare `Record` over the union, for the same reason `ORDER_STATUS` is one: a
 * missing key here is a crash on the row that has it, not a colourless dot.
 */
export const STATUS_TONE: Record<AdminOrderRow["status"], Tone> = {
  PLACED: "accent",
  KITCHEN: "accent",
  READY: "accent",
  ON_THE_WAY: "blue",
  DELIVERED: "green",
  CANCELLED: "neutral",
};
