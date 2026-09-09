/**
 * DEPRECATED — import from `components/admin/console` instead.
 *
 * This file was the first pass at console-only primitives. The redesign turned
 * that pass into a proper design system under `console/`, and this is the
 * adapter that keeps the fourteen screens still on the old names working while
 * they are converted one at a time.
 *
 * It is adapters, not implementations. There is exactly one metric strip, one
 * figure, one attention row and one share bar in the codebase; these are other
 * names for them. Delete this file when the last import of it goes.
 *
 * What changed under each name, so a converted screen is not a surprise:
 *
 * - `StatTile` / `StatTiles` → `Figure` / `FigureRow`. The bordered tile is
 *   gone. A band of eight bordered tiles above a table was eight more boxes on
 *   a screen that already had one, and the border was carrying no meaning —
 *   the label and the space around the figure group it perfectly well.
 * - `KpiStrip` → `MetricRow`. Same shape; cells can now be links, and the
 *   delta carries an arrow.
 * - `DecisionRow` → `AttentionRow`. The count moved to the front and grew,
 *   because triaging these is a comparison between numbers.
 */
import {
  AttentionRow,
  Figure,
  FigureRow,
  MetricRow,
  type AttentionItem,
  type Delta,
  type MetricItem,
  type Tone,
} from "@/components/admin/console";

export { ShareBar, type ShareSegment } from "@/components/admin/console";
export { Sparkline } from "@/components/admin/console";

/** @deprecated Use `MetricItem`'s `delta`. */
export type KpiDelta = Delta & { note?: string };

/** @deprecated Use `MetricItem`. */
export interface KpiItem {
  label: string;
  value: string;
  unit?: string;
  delta?: KpiDelta;
  spark?: number[];
}

/** @deprecated Use `MetricRow`. */
export function KpiStrip({ items }: { items: KpiItem[] }) {
  const mapped: MetricItem[] = items.map((k) => ({
    label: k.label,
    value: k.value,
    // `unit` and the delta's `note` were two names for the same line of grey
    // under the figure, and no caller ever set both.
    note: k.unit ?? k.delta?.note,
    delta: k.delta,
    spark: k.spark,
  }));
  return <MetricRow items={mapped} />;
}

/** @deprecated Use `Figure`. */
export function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return <Figure label={label} value={value} note={note} />;
}

/** @deprecated Use `FigureRow`. */
export function StatTiles({ children }: { children: React.ReactNode }) {
  return <FigureRow>{children}</FigureRow>;
}

/** @deprecated Use `AttentionItem`. */
export interface Decision {
  href: string;
  title: string;
  detail: string;
  count: number;
  /** A CSS colour. `AttentionItem` takes a named tone instead. */
  color: string;
}

/**
 * Maps the old free-form colour back onto the kit's named tones, so a screen
 * that has not been converted yet still gets the right meaning rather than a
 * neutral row. Anything unrecognised is neutral — an unknown colour is not a
 * reason to guess "urgent".
 */
const TONE_BY_COLOR: Record<string, Tone> = {
  "var(--accent)": "accent",
  "var(--deal)": "red",
  "var(--pop)": "amber",
  "var(--blue)": "blue",
  "var(--green)": "green",
};

/** @deprecated Use `AttentionRow`. */
export function DecisionRow({ item }: { item: Decision }) {
  const mapped: AttentionItem = {
    href: item.href,
    title: item.title,
    detail: item.detail,
    count: item.count,
    tone: TONE_BY_COLOR[item.color] ?? "neutral",
  };
  return <AttentionRow item={mapped} />;
}
