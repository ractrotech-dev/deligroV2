// Per-endpoint timings against the Manager app's budgets, on the 100k-order seed (Phase 10, Task 6).
//
//   node scripts/perf/manager-budgets.mjs [orders]          (default 100000; 2000 for a quick look)
//
// Budgets (server time, median of 5 runs after a warm-up):
//   dashboard and statistics ........ 800 ms     lists (orders, vendors, riders, products, customers,
//   live ............................ 400 ms     tickets, alerts, audit) first page ... 400 ms
//   a report's first page ........... 1500 ms    finance overview ....................... 800 ms
//
// How it measures: the data layer's reads are either RPCs or plain selects. RPCs are called
// exactly as the routes call them — arguments are built from each function's own parameter names
// (zone list, IST day bounds, 30-day window, limit 51, everything else null), so a new parameter
// with a default needs no change here. List pages and the live view are the equivalent SQL, written
// out below next to the data-access function they mirror. PGlite (WebAssembly Postgres, one
// connection, no shared buffers) is slower than hosted Postgres, so a pass here is conservative.
// It does NOT measure the network or the Node post-processing of the rows (small by comparison:
// a page is 51 rows; the aggregates return one JSON document).
//
// Then it checks volume parity: the dashboard, the finance figures and the orders report agree
// with an independent count/sum over the raw tables, and no figure is a 1000-row-capped read.
// Exits 1 on any budget breach or parity failure.
import { buildSeededDb } from "./seed-manager-100k.mjs";
import { one } from "../qa/sql/chain-lib.mjs";

const N = Number(process.argv[2] ?? 100_000);
const quiet = process.argv.includes("--quiet");
const log = quiet ? () => {} : console.log;
console.log(`Seeding ${N} orders (this takes a while)…`);
const { db, zones } = await buildSeededDb({ orders: N, log });

// The app's server calls these as the service role; so does the runner.
await db.exec(`select set_config('test.jwt', '{"role":"service_role"}', false)`);

const ms = () => performance.now();
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const todayStart = (await one(db, `select (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') t`))[0].t;
const tomorrowStart = new Date(new Date(todayStart).getTime() + 86_400_000);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const dateStr = (d) => new Date(d).toISOString().slice(0, 10);

// ── RPC calls built from the catalog ──
const sigs = new Map();
for (const r of await one(db, `
  select p.proname n, p.proargnames names, p.pronargs nargs, p.pronargdefaults nd,
         (select array_agg(format_type(o, null) order by ord) from unnest(p.proargtypes::oid[]) with ordinality u(o, ord)) types
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'ops\\_%'`)) {
  // table-returning functions list their output columns after the arguments in proargnames
  sigs.set(r.n, { names: (r.names ?? []).slice(0, r.nargs), types: r.types ?? [], defaults: r.nd });
}

/** The value a route would pass for a parameter of this name. */
function argFor(name, type, ctx) {
  const z = ctx.zoneIds;
  const map = {
    p_zone_ids: z, p_zones: z, p_all: false, p_all_zones: false,
    p_today_start: todayStart, p_today_end: tomorrowStart, p_now: new Date(), p_day_start: todayStart, p_today: dateStr(todayStart),
    p_start: ctx.start, p_end: ctx.end, p_from: type === "date" ? dateStr(ctx.start) : ctx.start, p_to: type === "date" ? dateStr(ctx.end) : ctx.end,
    p_commission_default: 10, p_gst_pct: 18, p_sla_minutes: 30, p_limit: 51, p_offset: 0, p_summary_only: false,
    p_window_minutes: 30, p_windows: JSON.stringify([{ kind: "vendor", minutes: 60 }]), p_incidents: true, p_kinds: null,
    p_ids: ctx.ids ?? null, p_sort: "recent",
  };
  return name in map ? map[name] : null;
}

async function rpc(name, ctx = {}, overrides = {}) {
  const sig = sigs.get(name);
  if (!sig) throw new Error(`no function ${name}`);
  const base = { zoneIds: zones, start: daysAgo(30), end: new Date(), ...ctx };
  const args = [];
  const parts = [];
  sig.names.forEach((nm, i) => {
    const type = sig.types[i];
    let v = nm in overrides ? overrides[nm] : argFor(nm, type, base);
    const hasDefault = i >= sig.names.length - sig.defaults;
    if (v === null && hasDefault && !(nm in overrides)) return; // let the default apply
    if (v instanceof Date) v = v.toISOString();
    if (Array.isArray(v) && !type.endsWith("[]")) v = null;
    args.push(v);
    parts.push(`${nm} => $${args.length}::${type}`);
  });
  return { sql: `select * from public.${name}(${parts.join(", ")})`, args };
}

async function time(fn, runs = 5) {
  await fn(); // warm-up
  const t = [];
  for (let i = 0; i < runs; i++) {
    const t0 = ms();
    await fn();
    t.push(ms() - t0);
  }
  return median(t);
}

const results = [];
async function endpoint(label, budget, fn) {
  try {
    const m = await time(fn);
    results.push({ label, budget, ms: m, ok: m <= budget });
    console.log(`${m <= budget ? "ok  " : "SLOW"} ${label.padEnd(44)} ${m.toFixed(0).padStart(6)} ms  (budget ${budget})`);
  } catch (e) {
    results.push({ label, budget, ms: NaN, ok: false, error: String(e.message).slice(0, 160) });
    console.log(`FAIL ${label.padEnd(44)} ${String(e.message).slice(0, 150)}`);
  }
}
const callRpc = (name, ctx, overrides) => async () => {
  const { sql, args } = await rpc(name, ctx, overrides);
  const rows = (await db.query(sql, args)).rows;
  return rows.length === 1 && name in rows[0] ? rows[0][name] : rows;
};
const run = (sql, args = []) => async () => (await db.query(sql, args)).rows;
const seq = (...fns) => async () => {
  for (const f of fns) await f();
};

const Z = zones;
const oneZone = [zones[0]];
console.log(`\n── budgets (median of 5, ${N} orders) ──`);

// dashboard and statistics (800)
await endpoint("dashboard, all zones", 800, callRpc("ops_dashboard_rollup"));
await endpoint("dashboard, one zone", 800, callRpc("ops_dashboard_rollup", { zoneIds: oneZone }));
await endpoint("statistics, last month", 800, callRpc("ops_stats_rollup"));
await endpoint("statistics, last year", 800, callRpc("ops_stats_rollup", { start: daysAgo(365) }));
await endpoint("finance overview (rollup + dues)", 800, seq(callRpc("ops_finance_rollup", { start: daysAgo(30) }), callRpc("ops_vendor_dues_scoped"), callRpc("ops_rider_dues")));

// lists (400): first page, a filtered page, and a page deep in the data
const LIST = `select o.id, o.short_code, o.status, o.total, o.created_at, o.payment_method, o.payment_status, r.name vendor, c.full_name customer, d.status dstatus, d.driver_id
  from public.orders o join public.restaurants r on r.id = o.restaurant_id
  left join public.profiles c on c.id = o.customer_id left join public.deliveries d on d.order_id = o.id
 where o.zone_id = any($1::uuid[]) and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)`;
await endpoint("orders: first page", 400, run(`${LIST} order by o.created_at desc, o.id desc limit 51`, [Z]));
const [vend] = await one(db, `select restaurant_id from public.orders group by 1 order by count(*) desc limit 1`);
await endpoint("orders: filtered (delivered, one vendor)", 400, run(`${LIST} and o.status = 'delivered' and o.restaurant_id = $2 order by o.created_at desc, o.id desc limit 51`, [Z, vend.restaurant_id]));
const deep = (await one(db, `select created_at, id from public.orders where zone_id = any($1::uuid[]) order by created_at desc, id desc offset ${Math.min(50_000, Math.floor(N / 2))} limit 1`, [Z]))[0];
await endpoint("orders: a page 50,000 rows deep (keyset)", 400, run(`${LIST} and (o.created_at, o.id) < ($2::timestamptz, $3::uuid) order by o.created_at desc, o.id desc limit 51`, [Z, deep.created_at, deep.id]));
await endpoint("orders: queue counts", 400, callRpc("ops_order_queue_facts"));
const [ord] = await one(db, `select id from public.orders where status = 'delivered' order by created_at desc offset 1000 limit 1`);
await endpoint("order detail (items, events, deliveries)", 400, seq(
  run(`select * from public.order_items where order_id = $1`, [ord.id]),
  run(`select * from public.delivery_events where order_id = $1 order by created_at`, [ord.id]),
  run(`select d.*, p.full_name from public.deliveries d left join public.profiles p on p.id = d.driver_id where d.order_id = $1`, [ord.id]),
  run(`select * from public.orders where id = $1`, [ord.id]),
));

// live (400): the board's three reads
await endpoint("live (active orders, riders, deliveries, failures)", 400, seq(
  run(`select o.id, o.status, o.zone_id, o.created_at, o.accepted_at, o.ready_at, o.restaurant_id from public.orders o
        where o.zone_id = any($1::uuid[]) and o.status in ('placed','kitchen','ready','on_the_way') and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
        order by o.created_at limit 500`, [Z]),
  run(`select rs.driver_id, rs.is_online, rs.last_lat, rs.last_lng, rs.last_fix_at, p.full_name from public.rider_status rs join public.profiles p on p.id = rs.driver_id where rs.is_online`),
  run(`select d.order_id, d.driver_id, d.status, d.driver_lat, d.driver_lng, d.driver_location_at from public.deliveries d where d.status in ('assigned','picked_up')`),
  run(`select e.order_id, e.kind, e.created_at from public.delivery_events e where e.kind = 'failed' order by e.created_at desc limit 200`),
));

// other list pages (400)
const [vids] = [await one(db, `select id from public.restaurants where zone_id = any($1::uuid[]) order by name, id limit 51`, [Z])];
await endpoint("vendors: first page + today's facts", 400, seq(
  run(`select r.id, r.name, r.status, r.zone_id, r.is_open from public.restaurants r where r.zone_id = any($1::uuid[]) order by r.name, r.id limit 51`, [Z]),
  run(`select restaurant_id, count(*) filter (where created_at >= $2) today, count(*) filter (where status = 'cancelled') cancelled, count(*) total
         from public.orders where restaurant_id = any($1::uuid[]) and created_at >= now() - interval '30 days' group by 1`, [vids.map((v) => v.id), todayStart]),
));
const rids = (await one(db, `select driver_id from public.rider_status order by driver_id limit 51`)).map((r) => r.driver_id);
await endpoint("riders: first page", 400, callRpc("ops_rider_list_facts", { ids: rids }));
await endpoint("products: first page + counts", 400, seq(
  run(`select m.id, m.name, m.price, m.category, r.name vendor from public.menu_items m join public.restaurants r on r.id = m.restaurant_id where r.zone_id = any($1::uuid[]) order by m.name, m.id limit 51`, [Z]),
  callRpc("ops_product_counts"),
));
await endpoint("customers: first page", 400, callRpc("ops_customer_list", {}, { p_after_key: null, p_after_id: null }));
await endpoint("tickets: first page + metrics", 400, seq(
  run(`select t.id, t.number, t.status, t.category, t.priority, t.created_at, t.requester_role from public.support_tickets t where t.zone_id = any($1::uuid[]) order by t.created_at desc, t.id desc limit 51`, [Z]),
  callRpc("ops_ticket_metrics", {}, { p_from: dateStr(daysAgo(90)), p_to: dateStr(new Date()) }),
));
await endpoint("alerts: first page + counts", 400, seq(
  run(`select a.id, a.kind, a.severity, a.title, a.status, a.opened_at from public.ops_alerts a where a.zone_id = any($1::uuid[]) and a.status in ('open','acknowledged') order by a.opened_at desc, a.id desc limit 51`, [Z]),
  callRpc("ops_alert_counts"),
));
await endpoint("audit log: first page", 400, run(`select a.id, a.action, a.entity_type, a.entity_id, a.created_at from public.ops_audit_log a where a.zone_id = any($1::uuid[]) order by a.created_at desc, a.id desc limit 51`, [Z]));

// reports, first page (1500)
await endpoint("report: orders", 1500, callRpc("ops_report_orders"));
await endpoint("report: vendor settlements", 1500, callRpc("ops_report_settlements", {}, { p_start: daysAgo(400) }));
await endpoint("report: vendor performance", 1500, callRpc("ops_report_vendor_ops"));
await endpoint("report: rider performance", 1500, callRpc("ops_report_rider_performance"));
await endpoint("report: refunds and adjustments", 1500, callRpc("ops_report_refunds_adjustments", {}, { p_start: daysAgo(400) }));
await endpoint("report: support tickets", 1500, callRpc("ops_report_support_tickets", {}, { p_start: daysAgo(400) }));
await endpoint("report: cash reconciliation", 1500, callRpc("ops_cash_reconciliation"));
await endpoint("report: reconciliation, orders", 1500, callRpc("ops_reconciliation_orders"));

const slow = results.filter((r) => !r.ok);
console.log(`\n${results.length - slow.length}/${results.length} endpoints within budget${slow.length ? `; ${slow.length} over or failing: ${slow.map((s) => s.label).join(" | ")}` : ""}`);

// ── volume parity ──
console.log("\n── volume parity ──");
let parityFails = 0;
const check = (c, m, extra) => {
  if (!c) parityFails++;
  console.log(`${c ? "ok  " : "FAIL"} ${m}${!c && extra ? ` — ${extra}` : ""}`);
};
const truth = (await one(db, `
  select count(*) filter (where status <> 'cancelled' and public.ops_counts_as_order(payment_method::text, payment_status::text))::int counted,
         coalesce(sum(total) filter (where status <> 'cancelled' and public.ops_counts_as_order(payment_method::text, payment_status::text)), 0)::bigint sales,
         count(*) filter (where status = 'cancelled')::int cancelled,
         count(*)::int all_rows
    from public.orders where zone_id = any($1::uuid[])`, [Z]))[0];
check(truth.all_rows === N, `the seed has ${N} orders`, `found ${truth.all_rows}`);
check(truth.counted % 1000 !== 0 || truth.counted === 0, `the independent count (${truth.counted}) is not a round 1000 (a capped read would be)`);

const everything = { start: new Date("2000-01-01"), end: new Date(Date.now() + 86_400_000) };
const dash = await callRpc("ops_dashboard_rollup", everything)();
const stats = (await callRpc("ops_stats_rollup", everything, { p_summary_only: true })()).summary;
const fin = await callRpc("ops_finance_rollup", everything)();
const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
const exact = (a, b, what) => check(Number(a) === Number(b), what, `${a} vs ${b}`);

exact(dash.totalSales, truth.sales, `dashboard Total Sales = independent sum of order totals (${truth.sales})`);
exact(dash.totalOrders, truth.counted + truth.cancelled, `dashboard Total Orders = counted + cancelled (${truth.counted + truth.cancelled})`);
exact(dash.cancelledOrders, truth.cancelled, `dashboard Cancelled Orders = independent count (${truth.cancelled})`);
exact(Number(dash.completedOrders) + Number(dash.pendingOrders) + Number(dash.cancelledOrders), dash.totalOrders, "dashboard: completed + pending + cancelled = total");
exact(stats.customerPaid, truth.sales, "statistics 'customer paid' = dashboard Total Sales");
exact(stats.salesOrders, truth.counted, "statistics sales orders = independent count");
exact(stats.cancelledCount, truth.cancelled, "statistics cancelled = independent count");
exact(sum(fin.byDay, "customerPaid"), truth.sales, "finance overview, summed by day = dashboard Total Sales");
exact(sum(fin.byDay, "orders"), truth.counted, "finance overview order count = independent count");
exact(sum(fin.byDay, "cancelledCount"), truth.cancelled, "finance overview cancelled = independent count");
exact(sum(fin.byDay, "grossSales"), stats.grossSales, "finance gross sales = statistics gross sales");
exact(sum(fin.byDay, "deliveryFees"), stats.deliveryFees, "finance delivery fees = statistics delivery fees");

const rep = await callRpc("ops_report_orders", everything, { p_limit: 5 })();
const repTotal = rep.total ?? rep.totalRows ?? rep.count ?? rep.totals?.orders ?? rep.totals?.count;
console.log(`  orders report keys: ${Object.keys(rep).join(", ")}`);
if (repTotal !== undefined) exact(repTotal, truth.counted + truth.cancelled, "orders report total = counted + cancelled orders");
else check(false, "orders report exposes a total row count", `keys: ${Object.keys(rep).join(", ")}`);

// every figure above is compared with count(*)/sum(), so a read capped at 1000 rows could not pass.
// Keyset paging at depth neither skips nor repeats: two pages of 51 equal one page of 102.
const two = async (cursor) => (await db.query(`${LIST} ${cursor ? "and (o.created_at, o.id) < ($2::timestamptz, $3::uuid)" : ""} order by o.created_at desc, o.id desc limit 51`, cursor ? [Z, cursor.c, cursor.i] : [Z])).rows;
const p1 = await two();
const p2 = await two({ c: p1[49].created_at, i: p1[49].id }); // the 50th row is the last one shown; the 51st only says "more"
const both = (await db.query(`${LIST} order by o.created_at desc, o.id desc limit 102`, [Z])).rows;
check(p1.length === 51 && both.length === 102, "first pages are full (51 rows)");
check([...p1.slice(0, 50), ...p2.slice(0, 50)].map((r) => r.id).join() === both.slice(0, 100).map((r) => r.id).join(), "keyset page 2 continues page 1 with no skipped or repeated order");
const deepRows = (await db.query(`${LIST} and (o.created_at, o.id) < ($2::timestamptz, $3::uuid) order by o.created_at desc, o.id desc limit 51`, [Z, deep.created_at, deep.id])).rows;
check(deepRows.length === 51, "a page 50,000 rows deep is full", `${deepRows.length} rows`);

console.log(parityFails ? `${parityFails} parity check(s) failed` : "volume parity holds");
process.exit(slow.length || parityFails ? 1 : 0);
