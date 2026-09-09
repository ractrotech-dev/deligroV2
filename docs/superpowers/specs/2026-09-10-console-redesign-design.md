# Ops console redesign — admin + vendor web shells

**Date:** 2026-09-10
**Scope:** the `web` shell branch of the admin and vendor portals. UI/UX only.
**Not in scope:** the phone-frame branch, the customer PWA, driver, manager,
schema, auth, settlement/commission arithmetic, any server action or API route.

## Why

The console grew out of a card-based mobile UI. Almost every section is a
bordered container, so the screens carry a lot of chrome and little
information: large panels, wide gaps, weak typographic hierarchy, and tables
that read as generic database dumps rather than as an operations tool. The
dashboard states figures without answering *what should I do next*, and
Reports — the screen whose whole job is communicating a trend — draws no
charts at all.

The target is a dense, dark-first operations console: an information system
built out of typography, tables, charts, dividers and inline metrics, in which
a bordered card is the exception rather than the default.

## Invariants

These hold at every commit. They are the reason this is safe to do at all.

1. **The two shells stay separate.** `AdminShell` / `VendorShell` keep their
   `effective === "app"` early return. No `.device`, `StatusBar`, `TabBar`,
   `app-shell` or `app-scroll` below the console return.
   `npm run test:platform` asserts this structurally and must stay green.
2. **Container queries only.** Pages size against `@container`, using `@3xl:` /
   `@5xl:`. A viewport breakpoint reports "wide" for the 390px phone frame
   previewed on a 1920px screen. Viewport queries are for chrome that really is
   viewport-scale (the rail's `lg:hidden`).
3. **`reach: "console"` keeps both halves** — nav entry dropped from
   `ADMIN_PHONE_MENU` *and* the route renders `<ConsoleOnly variant="page">`.
4. **Platform is presentation; roles are the boundary.** No shell mode, user
   agent or media query is ever consulted for authorization. `requireRole()`
   stays at the top of every exported `"use server"` function and API route,
   above every `createAdminClient()`, with RLS underneath.
5. **No invented data.** Every figure and every chart point comes from an
   existing `data-access` reader, or from a new read-only aggregate written in
   the same file and the same style as its neighbours. A metric with no
   trustworthy source is omitted, not estimated.
6. **Shared primitives are not restyled directly.** `components/ui/button`,
   `ui/field` and `shared/empty-state` are imported by 53+ files across the
   customer PWA, driver, manager and vendor portals. They carry `ui-btn`,
   `ui-field` and `ui-empty` hooks that `.console-theme` retunes in CSS; that
   is the only lever this redesign uses on them.
7. **`npx tsc --noEmit` and `npm run test:platform` are green at every phase.**
   Both are green at the branch point.

## 1. Token layer

`.console-theme` in `globals.css` is rewritten dark-first. It is applied by the
web branch of both shells (and the nav drawer and upload dock, which render
outside the shell div), never by the phone frame and never near the customer
app.

Neutrals: near-black page, lifted surfaces, hairline borders.

| Token | Dark (default) | Role |
| --- | --- | --- |
| `--bg` | `#0b0d10` | page ground |
| `--surface` | `#121519` | raised panel |
| `--surface-2` | `#171b20` | table header, inset rows |
| `--ink` | `#e8eaed` | primary text |
| `--muted` | `#8b929c` | secondary text |
| `--line` | `#22272e` | hairline |

Accents carry meaning only: green success/delivered/paid, red
critical/late/failed, amber pending/warning, blue informational. Every grey and
every accent used as text is held to WCAG AA against the surface it actually
sits on, at the size it is actually set — this codebase already holds that line
(see the token comments at the top of `globals.css`) and the redesign keeps it.

A **density scale** is added as custom properties (`--c-row-h`, `--c-gap`,
`--c-pad-x`, `--c-r`) so pages stop hard-coding pixel values and the whole
console can be tightened or loosened in one place.

The existing light console palette is preserved as
`.console-theme[data-console="light"]`.

### Theme preference

Console theme is **scoped to the console** and independent of `data-theme`,
which is a global localStorage toggle shared with the customer PWA and defaults
to light. Flipping that would re-skin the customer app.

Resolution mirrors `resolveShellMode` exactly, for the same reason: a
client-only decision has no answer during SSR.

1. Cookie `deligro-console-theme`, read in the portal layout.
2. Falls back to `"dark"`.

The layout passes the answer to the shell, which stamps
`data-console="dark|light"` on the console div. No bootstrap script, no flash,
per-request by construction. `color-scheme` is set on the console subtree so
scrollbars and native controls follow it.

## 2. Shell

**Sidebar.** Collapsible: icon rail (~56px) ↔ full (~216px), persisted in the
same cookie mechanism. Active state becomes a left accent bar plus a surface
tint rather than a filled pill. Group labels tightened. Badges stay only where
there is a real queue behind them (approvals, refunds) — a count that is
activity rather than work stays neutral, as it does today.

**Top bar.** Section label, global search (keeping the existing `⌘K` binding
and scope select), a health chip fed by `getConsoleHealth`, the queue cluster,
account menu, layout switch.

The hard-coded "New campaign" button is **removed**. It renders on all 45 admin
pages today regardless of context; a page's primary action belongs in that
page's header.

## 3. Primitives

New, in `components/admin/console/`:

- `PageHeader` — title (20px), one-line description, status chip, action
  cluster. Two faces via container query, as `AdminHero` already is, so it
  works in the phone frame.
- `Toolbar` — the row under the header: search, filters, tabs. Sticks under the
  top bar.
- `Section` / `SectionHeader` — **no border and no background by default**.
  Grouping comes from a top hairline and spacing. This is the structural change
  that stops the console reading as a pile of cards.
- `Panel` — the bordered box, kept for the cases that need one: a chart, a
  form.
- `MetricRow` / `Metric` — evolves `KpiStrip`. Hairline-divided, 26px tabular
  value, previous-period delta, sparkline, optional drill-through href.
- `Empty` — compact inline empty state, one sentence and one action. The large
  centred `EmptyState` survives only for a whole page that is empty.
- `StatusDot` / `StatusBadge` — small indicators, not coloured containers.

`DataTable` keeps its column-definition API (six pages depend on it) and gains
a sticky header, a `density` prop, expandable rows, tabular-figure numeric
alignment, and a compact inline empty row.

`components/admin/charts/` gains `TrendChart`, `BarCompare`, `StackedShare` and
`Sparkline` over one shared recharts theme, all lazy-loaded the way
`gmv-chart-lazy` already does it.

`AdminHero`, `StatCard`, `KpiStrip`, `StatTile`, `VendorHero` and
`VendorMetricCard` become **adapters** over the kit — each a prop mapping onto
the one implementation, marked deprecated in its doc comment.

> **Amended after the sweep.** This section originally said they would be
> deleted once every call site was converted. They were not, and the reason is
> worth writing down rather than leaving as an unkept promise.
>
> AGENTS.md's rule is against two *implementations* of one thing, "because the
> next person cannot tell which one is live". That is not the situation here:
> there is exactly one page header, one metric strip, one figure and one
> attention row in the tree, and each adapter is ten lines that forward to it.
> Which one is live is unambiguous. Converting the remaining ~40 call sites is
> a mechanical rename with no user-visible effect and a real chance of
> introducing a typo into a screen the redesign otherwise never touched.
>
> So: the adapters stay, each carrying a `DEPRECATED — use X` comment naming
> its replacement, and AGENTS.md records that new code uses the kit. Converting
> a screen is a one-line import change whenever someone is in there anyway.

## 4. Dashboard data map

Every block, and where its numbers come from. Nothing is seeded or sampled.

| Block | Source |
| --- | --- |
| KPI row — revenue, orders, platform earnings, avg order value, active riders, in flight | `getAdminDashboard`, `getPlatformEarnings`, `getLiveBoard` |
| Trend chart — Revenue / Orders / Avg order value | `getAdminSeries(days)` |
| Order status distribution | `getOrderStatusMix(days)` |
| Cash vs online | **new** `getPaymentMix(days)`, a read-only aggregate written beside `getOrderStatusMix` in `admin-series.ts` |
| Top vendors by revenue / orders / avg order value | `listVendorRanking()` |
| Happening now | `getLiveBoard(n)` |
| Attention centre | `listPendingRestaurants`, `getAdminNavCounts.pendingRefunds`, `getLiveBoard.unassigned`, `getLiveBoard.atRisk`, `getSettlementStats.draftCount`, orders with `payment_status = 'failed'` |

### Deliberate omissions

- **Average preparation time, average delivery time, on-time delivery rate, and
  a late-order trend are not shown.** There is no trustworthy completion stamp:
  `minutesLate` returns `null` for delivered and cancelled orders precisely
  because of this (`admin-orders.ts`), and migration 0033 records that there is
  no usable `orders.delivered_at`. Only *current* lateness is real, and that is
  what the console shows. Inventing the rest on an operations screen would be
  worse than the gap.
- **Platform earnings gets a KPI and a delta but no daily series**, and is not
  offered as a trend-chart toggle. A per-day earnings line needs a per-day
  vendor-rate recompute the series query does not do.

## 5. Pages

In order, each verified before the next:

1. Design system (§1–3)
2. Dashboard
3. Orders — sticky header, vendor/payment/rider filters, status tabs,
   expandable rows; order detail rebuilt around a lifecycle timeline
4. Settlements and Order payouts — financial breakdown, aligned money columns
5. Reports — a report workspace: kind tabs, filters, primary and secondary
   chart, KPI summary, table. The existing xlsx and print exports are untouched.
6. Cash & expenses — three hand-rolled `<table>`s replaced with `DataTable`,
   filters added, the rider → manager → owner chain made legible
7. Vendors — summary counts, filters, table; tabbed vendor profile
8. Vendor portal — 7 routes, same language
9. Sweep — the remaining ~30 admin routes (observability, campaigns, promo
   codes, customers, team, settings, platform config, storage, food images,
   vendor categories, featured slots, settlement sub-routes)

## 6. Verification

Per phase: `npx tsc --noEmit`, `npm run test:platform`, `npm run lint`.
At the end: `npm run build`.

Nothing in this redesign touches an RLS policy, a grant, an auth path, an
upload, or a column exposed to anon/authenticated, so `docs/SECURITY_AUDIT.md`
is not triggered by it. If that stops being true mid-flight, the audit runs
before the change lands.
