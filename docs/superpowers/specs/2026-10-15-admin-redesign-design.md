# Admin console redesign — first pass (shell + dashboard)

Date: 2026-10-15 · Target: `deligro/` (not `deligro-ringing/`) · Status: implemented (first pass)

Source design: Claude artifact "Deligro Admin" (https://claude.ai/artifact/PEqJbit2b1NpJHw58cw7Fo),
a static mockup with demo data. Treated as a **visual reference**, not code to copy.

## Goal

Give the real admin console the mockup's look and dashboard layout, keeping its
real data, behaviour and security properties. Operators should see a light,
warm-neutral console with a clear "what needs me" row at the top of the dashboard.

## Scope

In (this pass):

1. Console design tokens (palette, radii, shadow) — light and dark.
2. Plus Jakarta Sans, scoped to the console.
3. Shell: sidebar, top bar, nav drawer.
4. Shared primitives in `components/admin/console/*`, `data-table.tsx`,
   `admin-ui.tsx`, and the pill styles in `globals.css`.
5. Dashboard (`app/admin/page.tsx`) re-laid-out to the mockup's order.

Out (later passes, reviewed one at a time): per-page redesign of orders,
refunds, settlements, reports, vendors, customers, coupons, banners, storage,
settings, employees, platform config. They inherit tokens and primitives
automatically and get a contrast/visual check only.

Also out: `deligro-ringing/`, the customer app, the vendor portal's own layout
(it shares `.console-theme`, so it is **checked** for regressions, not redesigned).

## Decisions

| Topic | Decision | Reason |
|---|---|---|
| Approach | Re-token the existing console; no parallel component set | Tailwind colour utilities compile to `var(--bg)` etc., so remapping variables re-skins every page; avoids two sources of truth (CLAUDE.md "delete the loser") |
| Default theme | **Light** for operators with no saved preference; dark remains selectable | Mockup is light-first. Today's default is dark — this is a deliberate change |
| Theme mechanism | Unchanged: `data-console` attribute from cookie (`lib/console-theme.server.ts`) | No flash, no hydration mismatch, independent of customer `data-theme` |
| Currency/locale | Keep ₹ / en-IN | Mockup's `$` is demo data |
| Icons | Keep lucide-react | Mockup uses emoji placeholders |
| Data | No data-access or server-action changes | Redesign is presentational |
| Unbacked mockup items | Not built (see below) | Don't ship controls or numbers with nothing behind them |

## Design

### 1. Tokens (`src/app/globals.css`, `.console-theme` block ~L1333+)

- Light palette (`[data-console="light"]`) takes the mockup values:
  page `#f5f4f1`, surface `#ffffff`, border `#e6e4df`, hairline `#f0ede8`,
  ink `#1a1a2e`, secondary text `#4a4840`, muted `#8a877e`,
  accent `#e84d1c` / soft `#fef1ed`, green `#22b573`, amber `#f5a623`,
  blue `#3b7ff5` with matching tints.
- Dark palette takes the mockup's dark values (`#141416` page, `#1e2024` surface,
  accent `#ff6035`, …).
- Existing token **names** are preserved (`--bg`, `--surface`, `--line`, `--accent`,
  `--deal`, `--pop`, `--c-*`, `--sb-*`). Only values change, plus new names where the
  mockup has a concept the current set lacks (e.g. `--blue-soft`, shadow).
- **Contrast is re-verified.** The existing file documents AA ratios per token; the
  mockup's muted greys (`#b5b2aa` on white ≈ 2:1) fail AA for text. Where a mockup
  value is used for *text* it is darkened to pass AA; the mockup value is kept only
  for non-text uses (tracks, placeholders, dividers). Pill inks are checked against
  their tint.
- `body:has(.console-theme.dashboard-shell…)` background restatements updated to the
  new page colours.
- `resolveConsolePrefs` default theme flips to `light`. The "loses its attribute →
  dark" cascade note in the CSS comment is rewritten to match (bare `.console-theme`
  becomes light, `[data-console="dark"]` the variant) — or the dark values stay on the
  bare rule and the default is applied only in `resolveConsolePrefs`. Plan picks the
  smaller diff; behaviour is identical.

### 2. Typography

- Load Plus Jakarta Sans (400–800) via `next/font/google` in `app/layout.tsx`
  (alongside Inter / JetBrains Mono), exposed as `--font-jakarta`.
- Applied only under `.console-theme`. Customer app unchanged.

### 3. Shell

- **Sidebar** (`admin-sidebar.tsx`): light surface rail, full width 238px
  (compact 56px kept). Group labels uppercase 9px; items 13px/500; active item =
  accent-soft background + accent text + 3px accent left border; badges per mockup
  (accent for hot queues, neutral for live orders — keeping the existing `HOT` logic).
  Rail stays collapsible; account row, "Customer app" link, sign-out unchanged.
  The "rail is dark in both palettes" decision is reversed and its comments updated.
- **Top bar** (`admin-top-bar.tsx`): 52px, title + subtitle stacked, actions right.
- **Nav drawer** (`admin-nav-drawer.tsx`): follows the same tokens.
- `admin-nav.ts` structure, groups, badges and route contracts are unchanged.

### 4. Primitives

Restyle, don't fork: `PageHeader`, `Panel`, `MetricRow`/`Figure`, `AttentionList`,
`StatusBadge`/pills, `Tabs`, `DataTable` (header row tint, 12–13px cells, hover),
filters/search inputs, buttons, toggle. Public props stay the same so existing
call sites don't change. `data-table.tsx` has uncommitted user edits — modified in
place, preserving them.

### 5. Dashboard

Order, top to bottom:

1. **Attention cards** (4, coloured left border, large number, action link):
   Refunds pending → `/admin/refunds` (`counts.pendingRefunds`);
   Orders late → `/admin/orders` (`board.atRisk`);
   Settlement drafts awaiting payout → `/admin/settlements` (`settlements.draftCount`);
   Vendor applications → `/admin/vendors` (`counts.pendingApprovals`).
   Failed payments, currently surfaced elsewhere on the page, remains reachable
   (shown in the attention list or as a conditional fifth card when > 0).
2. **Metric strip** (6): existing figures and trends — revenue, orders, platform
   earnings, AOV, riders delivering, in flight.
3. **Two-column row:** Live orders (existing `LiveBoard`, restyled) | right stack:
   Top vendors (existing `RankBars`) and an "At a glance" stat list built only from
   real values (completed, cancelled, in flight, payment mix).
4. **Trend chart** and **approval queue** (existing), restyled.

Range control: existing `RangeTabs` (7 / 14 / 30 / all-time). `ConsoleOnly` wrappers
are retained.

### Mockup items deliberately not built

- Avg delivery time, SLA compliance, "orders > 60 min": no trustworthy delivery
  timestamp (see header comment in `app/admin/page.tsx`, migration 0033).
- Dashboard "Today" / "Custom" date buttons: no backend for arbitrary ranges.
- Settings "Danger Zone" (suspend all orders / delete all test data), "Process All"
  settlements: new destructive/bulk capabilities, not a visual change. Separate
  decision if wanted.
- Mockup's invented pages/fields (e.g. rider payout table, storage quota bar) —
  addressed, if at all, in the per-page passes.

## Verification

- `npm run lint`, `npm run test:platform`, `npm run test:layering`, and `next build`
  type-check.
- Run the app and screenshot with Playwright: dashboard + 3 representative inner pages
  (orders, vendors, settings) in light and dark, rail full and compact, at ≥1280px and
  at the `lg` breakpoint where the drawer takes over.
- Vendor portal smoke check (shared `.console-theme`).
- Contrast spot-check of text tokens and pills in both palettes.

## Risks

- **Shared `.console-theme`**: the vendor portal re-skins too. Accepted; verified, not
  separately designed.
- **Default flip to light** changes what existing operators with no cookie see.
- **Hard-coded colours** in components (e.g. `text-[#ff9a5a]` in the sidebar badge) will
  not follow tokens; the pass greps `#` literals under `components/admin` and
  `app/admin` and tokenises them.
- **Uncommitted working-tree edits** in two admin files; no stash/reset.

## Open questions

None blocking. Default theme (light) was proposed and accepted in review.

## As built (differences from the design above)

- Theme cookie renamed to `deligro-console-theme-v2` so existing operators' saved
  "dark" choice no longer overrides the new light default.
- Dashboard attention row is four fixed cards from real counts (refunds pending, late
  deliveries, shop payments ready, shops waiting), shown even at zero; "orders with no
  rider" and "failed payments" are appended only when non-zero. The separate
  "Needs attention" list was removed. No "At a glance" panel was added: the outcome and
  payment-mix panels already cover it.
- Light accent is `#d4410f` (not the mockup's `#e84d1c`) and light green/blue/amber text
  colours are darker than the mockup's, to keep WCAG AA contrast for text.
- Nav drawer and rail toggles were moved from hard-coded white to tokens.
- Verified: tsc, eslint, `test:platform`, `test:layering`; visual check of dashboard,
  orders, vendors, refunds, settlements, reports, platform config, and the mobile drawer.
  Vendor portal not visually checked (needs a vendor login).
