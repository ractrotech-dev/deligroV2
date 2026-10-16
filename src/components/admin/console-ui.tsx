/**
 * DEPRECATED — import from `components/admin/console` instead.
 *
 * This file was the first pass at console-only primitives. The redesign turned
 * that pass into a proper design system under `console/`, and this was the
 * adapter that kept the screens still on the old names working while they
 * were converted one at a time.
 *
 * Every adapter has now been converted and removed (`StatTile` / `StatTiles`
 * became `Figure` / `FigureRow`, `KpiStrip` became `MetricRow`). What is left
 * is a plain re-export with one remaining import. Delete this file when that
 * import goes.
 */
export { ShareBar, type ShareSegment } from "@/components/admin/console";
