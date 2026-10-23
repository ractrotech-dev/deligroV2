# Manager app: performance at 100,000 orders

How to run it: `npm run test:manager-perf` (about 3 minutes; add `-- 2000` for a quick look).
It builds the real migration chain in PGlite, loads a deterministic 100,000-order database
(`scripts/perf/seed-manager-100k.mjs`, fixed random seed), times every endpoint's read, and
checks that the figures agree with an independent count. It exits 1 on a budget breach or a
figure that disagrees.

## What is measured, and what is not

- Server time for each endpoint's database reads: median of 5 runs after a warm-up. RPCs are called as
  the routes call them; list pages and the live board are the equivalent SQL written out in the script
  next to the data-access function they mirror.
- **PGlite is WebAssembly Postgres on one connection with no parallel query**, so it is slower than
  hosted Postgres. A pass here is conservative; a miss here is not proof of a miss in production,
  but it is also not excused by it. Re-run against the staging database once migrations are applied.
- Not measured: the network, and the Node work on the returned rows (small: a page is 51 rows and the
  aggregates return one JSON document).
- The machine was shared with other builds while these were taken, so single runs vary by ±30 %.

## The data

3 zones in 2 cities, 120 vendors, 2,000 menu items, 80 riders, 30,000 customers, **100,000 orders** over 400
days (85 % delivered, 8 % cancelled with the cancelling party spread, 2 % unpaid online checkouts, the rest in
flight), 1 to 5 item lines each (about 300,000), deliveries with events, refunds on about 1.5 %, paid vendor
settlements covering delivered orders older than 14 days, 2,000 tickets, 500 alerts, 20,000 audit rows.
Seed time: about 22 seconds.

## Budgets and results (median ms)

| Endpoint | Budget | First run | After the fix below | |
|---|---:|---:|---:|---|
| Dashboard, all zones | 800 | 5,923 | **1,542** | over |
| Dashboard, one zone | 800 | 2,242 | **822** | just over |
| Statistics, last month | 800 | 1,170 | 365 | ok |
| Statistics, last year | 800 | 7,510 | **2,265** | over |
| Finance overview (rollup + dues) | 800 | 3,454 | **1,488** | over |
| Orders list, first page | 400 | 4 | 4 | ok |
| Orders list, filtered | 400 | 3 | 3 | ok |
| Orders list, a page 50,000 rows deep (keyset) | 400 | 4 | 4 | ok |
| Orders queue counts | 400 | 170 | 259 | ok |
| Order detail | 400 | 4 | 4 | ok |
| Live board | 400 | 59 | 113 | ok |
| Vendors, riders, products, tickets, alerts, audit (first pages) | 400 | 1 to 125 | 1 to 125 | ok |
| Customers, first page | 400 | 972 | **405** | borderline (see below) |
| Reports, first page (orders, settlements, vendor and rider performance, refunds, support tickets, cash, reconciliation) | 1,500 | 4 to 443 | 4 to 254 | ok |

Insights (demand forecast, zone grid) arrive in Phase 9 and are added to the runner then.

## Volume parity: holds

At 100,000 orders every figure equals an independent `count(*)` / `sum()` over the raw tables. Nothing is a
1,000-row capped read.

- Dashboard Total Sales = statistics "customer paid" = finance overview summed by day = the independent sum (121,493,136).
- Dashboard Total Orders = counted orders + cancelled orders (98,041); completed + pending + cancelled = total.
- Cancelled orders, delivery fees and gross sales agree between dashboard, statistics and finance.
- The orders report's row count equals the independent count.
- Keyset paging: page 2 continues page 1 with no skipped or repeated order, and a page 50,000 rows deep is full.

## The fix made (migration 0144, edited in place: it is not applied anywhere)

The slow endpoints all price every order through `ops_order_breakdown`, the SQL copy of the settlement
arithmetic. It was PL/pgSQL, called once per order, and each call made 8 more calls to `ops_js_round`,
which carried a `set search_path` clause that stops Postgres folding a function into the query: about a
million function calls per dashboard load.

- `ops_js_round` and `ops_counts_as_order` lose the clause (they only use `pg_catalog` functions), so they inline.
- `ops_order_breakdown` becomes one `language sql` expression with the same arithmetic, line for line, so it inlines too.

Result: 2.7 to 3.8 times faster on the aggregate endpoints, with the figures unchanged: the SQL/TypeScript parity
checks (`ops-sql-parity`, 144 checks; `manager-finance-sql-parity`, 239) and every migration proof pass.

## Still over budget, and why

The dashboard, the finance overview and the year of statistics read **every order in scope every time**: the
dashboard's "Total" figures are all-time by definition (§1), so the work grows with the number of orders. The
remaining cost is that single pass, not a bad query. Two things already limit how often it is paid: the routes
cache each answer for 20 seconds per scope, and the app refreshes Home every 30 seconds only while it is on screen.

Options, most to least effort, for whoever owns this next. None is done here because each changes how figures are produced:

1. **A daily rollup table** (per zone and vendor, refreshed incrementally; today read live). The dashboard
   then reads about 400 rows per zone instead of 100,000 orders. Needs a refresh strategy and care that a late refund
   or settlement updates the right day; the parity checks above are the safety net.
2. **One scan instead of ten**: the dashboard's ten separate subselects over the same set become one pass with
   `FILTER` aggregates. Worth maybe a quarter off.
3. **Measure on the real database first.** If hosted Postgres meets the budgets (likely for the one-zone dashboard,
   which is 822 ms here), nothing more is needed. This is the first thing to do after the migrations are applied.

**Customers, first page (405 ms)** aggregates every order in scope before applying the page. That is the Phase 7
review's finding #10; its fix (push the page and the search into the orders scan) is on the Phase 7 fix branch.
Re-run this script after it merges.
