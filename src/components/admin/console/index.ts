/**
 * The console design system.
 *
 * One import for every screen in the admin and vendor portals, so a page never
 * has to know which file a primitive happens to live in and the kit can be
 * reorganised without touching fifty call sites.
 *
 * The vocabulary, and what each thing is *for*:
 *
 * - `PageHeader`, `Toolbar`, `Tabs` — the top of a screen: what it is, and the
 *   controls that change what it shows.
 * - `Section`, `SectionRow`, `SectionCol` — grouping by hairline and space.
 *   The default. Reach for these before reaching for a box.
 * - `Panel`, `ChartPanel` — the box, for content that needs an edge.
 * - `MetricRow`, `Figure`, `FigureRow` — figures.
 * - `StatusDot`, `StatusText`, `StatusBadge`, `LiveBadge` — state, said with
 *   the smallest mark that can carry it.
 * - `AttentionCards` — what needs a person, worst first.
 * - `Empty` — a filtered list that came back with nothing.
 *
 * Tables live in `components/admin/data-table`, charts in
 * `components/admin/charts`. Both are large enough to be their own module and
 * are imported directly.
 *
 * `console/chrome` is deliberately NOT re-exported here. It is a `"use client"`
 * module, and this barrel is imported by server components: re-exporting it
 * would pull the provider and its two toggles into the client bundle of every
 * screen that only wanted a `Section`. The shells import it by path.
 */
export {
  PageHeader,
  Toolbar,
  Tabs,
} from "./page-header";

export {
  Section,
  SectionRow,
  SectionCol,
  Panel,
  ChartPanel,
} from "./section";

export {
  MetricRow,
  Figure,
  FigureRow,
  type Delta,
  type MetricItem,
} from "./metric";

export {
  StatusDot,
  StatusText,
  StatusBadge,
  LiveBadge,
  AttentionCards,
  type AttentionItem,
  type Tone,
} from "./status";

export { Empty } from "./empty";

export { ShareBar, type ShareSegment } from "./share-bar";

export {
  Timeline,
  FinancialBreakdown,
  FactList,
  Fact,
  type Stage,
  type StageState,
} from "./timeline";
