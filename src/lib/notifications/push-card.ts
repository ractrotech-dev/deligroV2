/**
 * The `card` a push can carry so the Android apps draw it as a layout instead of
 * plain text (apps/customer/third_party/deligro_push_style, PushStyle.kt reads
 * exactly these keys). No server-only import, so scripts/qa can check it.
 *
 * A push without a card is an ordinary notification, and so is a card on a
 * phone or app version that cannot draw it: the title and text are always sent
 * too, and the card only adds to them.
 *
 * Anything in a card is shown on the lock screen and passes through the push
 * provider, so only put in it what the title and text could carry. The one
 * deliberate exception is the customer's delivery code (`code`), which the
 * rider asks for at the door.
 */

export type CardTone = "orange" | "green" | "red" | "blue" | "amber" | "dark";
export type TileTone = CardTone | "neutral";

export interface PushCard {
  /** Accent colour of the notification's small icon. */
  tone?: CardTone;
  /** A big value on the right of the title ("12" "min", "₹780"). */
  tile?: { v: string; u?: string; tone?: TileTone };
  /** Progress bar. `at` is the current step (1-based); `at > of` draws every step as done. */
  steps?: { at: number; of: number };
  /** A 4-digit handover code drawn as tiles. */
  code?: string;
  /** Pickup and drop, shown when the notification is expanded. */
  route?: { from: string; fromNote?: string; to: string };
  /** Up to four short lines, shown when expanded. */
  lines?: string[];
  /** Up to three stat tiles, shown when expanded. */
  stats?: { v: string; l: string; tone?: TileTone }[];
}

/** The customer's order tracker: sent, accepted, packed, on the way, delivered. */
export const ORDER_STEP_COUNT = 5;
export const ORDER_STEP = { sent: 1, accepted: 2, packed: 3, onTheWay: 4, delivered: 5 } as const;

/** Progress card for the customer's order tracker. `done` draws every step as finished. */
export function orderProgressCard(step: number, opts: { done?: boolean; tone?: CardTone } = {}): PushCard {
  return {
    tone: opts.tone ?? (opts.done ? "green" : "orange"),
    steps: { at: opts.done ? ORDER_STEP_COUNT + 1 : step, of: ORDER_STEP_COUNT },
  };
}

const MAX_TEXT = 60;
const TONES: ReadonlySet<string> = new Set(["orange", "green", "red", "blue", "amber", "dark", "neutral"]);

function text(v: unknown, max = MAX_TEXT): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function tone<T extends string>(v: unknown, fallback?: T): T | undefined {
  return typeof v === "string" && TONES.has(v) ? (v as T) : fallback;
}

/**
 * What actually goes on the wire: known keys only, bounded text, a code of at
 * most four digits. Keeps a caller's mistake or a long restaurant name from
 * making a push oversized, and keeps the phone's parser to the shape it expects.
 */
export function sanitizeCard(card: PushCard): PushCard {
  const out: PushCard = {};
  if (card.tone && card.tone !== ("neutral" as string) && TONES.has(card.tone)) out.tone = card.tone;

  if (card.tile && text(card.tile.v)) {
    out.tile = { v: text(card.tile.v, 12) };
    const u = text(card.tile.u, 12);
    if (u) out.tile.u = u;
    const tt = tone<TileTone>(card.tile.tone);
    if (tt) out.tile.tone = tt;
  }

  if (card.steps) {
    const of = Math.min(6, Math.max(0, Math.trunc(card.steps.of)));
    const at = Math.min(of + 1, Math.max(0, Math.trunc(card.steps.at)));
    if (of > 0) out.steps = { at, of };
  }

  if (card.code) {
    const digits = card.code.replace(/\D/g, "").slice(0, 4);
    if (digits) out.code = digits;
  }

  if (card.route && text(card.route.from) && text(card.route.to)) {
    out.route = { from: text(card.route.from), to: text(card.route.to) };
    const note = text(card.route.fromNote, 30);
    if (note) out.route.fromNote = note;
  }

  if (card.lines?.length) {
    const lines = card.lines.slice(0, 4).map((l) => text(l)).filter(Boolean);
    if (lines.length) out.lines = lines;
  }

  if (card.stats?.length) {
    const stats = card.stats
      .slice(0, 3)
      .filter((s) => text(s.v) && text(s.l))
      .map((s) => {
        const o: { v: string; l: string; tone?: TileTone } = { v: text(s.v, 12), l: text(s.l, 16) };
        const st = tone<TileTone>(s.tone);
        if (st) o.tone = st;
        return o;
      });
    if (stats.length) out.stats = stats;
  }

  return out;
}

/**
 * Colour for a staff (manager / admin) notice, by what kind it is, so an SOS
 * does not look like a ticket reply. A caller that builds its own card wins.
 */
export function staffCardFor(kind: string): PushCard {
  switch (kind) {
    case "incident":
      return { tone: "red" };
    case "order_needs_intervention":
    case "order_unassigned":
      return { tone: "orange" };
    case "payout":
    case "low_stock":
      return { tone: "amber" };
    case "verification":
      return { tone: "green" };
    default:
      return { tone: "blue" };
  }
}
