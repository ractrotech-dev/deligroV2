/**
 * QA — 0162's ops_retention against the reference TypeScript
 * (retentionSummary / retentionCohorts in src/lib/metrics/customers.ts).
 *
 * Loads 1,500 customers' orders — more than the 1,000 rows an API listing
 * would be cut to — across two zones and fourteen months, with cancelled
 * orders, unpaid online checkouts, orders either side of an IST month end and
 * ties at the rounding boundary, into an in-process Postgres, and requires the
 * SQL's one-row answer to equal what the reference computes from every order.
 *
 * Needs: npm i --no-save @electric-sql/pglite@0.2.17
 * Usage: npx tsx scripts/qa/manager-retention-sql.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { retentionCohorts, retentionSummary, type CustomerFact } from "../../src/lib/metrics/customers";
import { isCountedOrder } from "../../src/lib/metrics/definitions";
import { rangeBounds } from "../../src/lib/metrics/ist";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail, null, 1).slice(0, 2500)); }
}

/** JSON with sorted keys: Postgres orders jsonb keys by length, the reference by insertion. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x);

let seed = 162;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const read = (f: string) => readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fn = (src: string, name: string) => {
  const m = src.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  if (!m) throw new Error(`${name} not found`);
  return m[0];
};

interface Order { id: string; customer: string; zone: string; status: string; method: string; payment: string | null; total: number; at: Date }

async function main() {
  const db = new PGlite();
  const Z1 = uuid(9001), Z2 = uuid(9002);
  await db.exec(`
    create table public.orders (id uuid primary key, customer_id uuid, zone_id uuid, status text, payment_method text,
      payment_status text, total integer, created_at timestamptz);
  `);
  await db.exec(fn(read("0142_manager_orders_live.sql"), "ops_counts_as_order"));
  await db.exec(fn(read("0162_manager_customers.sql"), "ops_retention"));

  const to = "2026-10-21";
  const range = { from: "2026-09-01", to };
  const { start, endExclusive } = rangeBounds(range);
  const orders: Order[] = [];
  let oid = 1;
  const ms = (d: string) => new Date(d).getTime();
  // IST month ends: the last and first minutes either side of midnight IST.
  const edges = ["2026-05-31T18:29:00.000Z", "2026-05-31T18:31:00.000Z", "2026-06-30T18:29:00.000Z", "2026-06-30T18:31:00.000Z",
    "2026-07-31T18:29:00.000Z", "2026-07-31T18:31:00.000Z", "2026-08-31T18:29:00.000Z", "2026-08-31T18:31:00.000Z"];
  for (let c = 1; c <= 1500; c++) {
    const n = pick([1, 1, 1, 2, 2, 3, 5]);
    let t = ms("2025-09-01T00:00:00Z") + Math.floor(rnd() * 410 * 864e5);
    for (let k = 0; k < n; k++) {
      const edge = k === 0 && rnd() < 0.04 ? pick(edges) : null;
      const at = new Date(edge ? ms(edge) : Math.min(t, ms("2026-10-21T18:00:00Z")));
      orders.push({
        id: uuid(100000 + oid++), customer: uuid(c), zone: rnd() < 0.7 ? Z1 : Z2,
        status: pick(["delivered", "delivered", "delivered", "cancelled", "on_the_way", "placed"]),
        method: pick(["cod", "online", "online"]), payment: pick(["paid", "pending", "failed", "authorized", null]),
        total: 100 + Math.floor(rnd() * 900), at,
      });
      t += Math.floor((1 + rnd() * 70) * 864e5);
    }
  }
  const values = orders.map((o) => `('${o.id}','${o.customer}','${o.zone}','${o.status}','${o.method}',${o.payment ? `'${o.payment}'` : "null"},${o.total},'${o.at.toISOString()}')`);
  for (let i = 0; i < values.length; i += 500) await db.exec(`insert into public.orders values ${values.slice(i, i + 500).join(",")}`);
  check("more customers than an API row cap", new Set(orders.map((o) => o.customer)).size > 1000);

  // The reference: per-customer facts from every order, then the pure functions.
  const factsFor = (zones: string[] | null): CustomerFact[] => {
    const by = new Map<string, Order[]>();
    for (const o of orders) {
      if (o.status === "cancelled" || !isCountedOrder({ paymentMethod: o.method, paymentStatus: o.payment })) continue;
      if (zones && !zones.includes(o.zone)) continue;
      if (o.at >= endExclusive) continue;
      (by.get(o.customer) ?? by.set(o.customer, []).get(o.customer)!).push(o);
    }
    const out: CustomerFact[] = [];
    for (const [customerId, list] of by) {
      list.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1));
      const inRange = list.filter((o) => o.at >= start);
      out.push({
        customerId, firstOrderAt: list[0].at.toISOString(), secondOrderAt: list[1] ? list[1].at.toISOString() : null,
        ordersInRange: inRange.length, spentInRange: inRange.reduce((s, o) => s + o.total, 0),
        lastOrderAt: list[list.length - 1].at.toISOString(),
      });
    }
    return out;
  };

  for (const [label, zones] of [["every zone", null], ["zone 1", [Z1]], ["both zones listed", [Z1, Z2]]] as const) {
    const ref = factsFor(zones as string[] | null);
    const expected = { summary: retentionSummary(ref, range), cohorts: retentionCohorts(ref, to) };
    const arr = zones ? `array[${zones.map((z) => `'${z}'`).join(",")}]::uuid[]` : "null::uuid[]";
    const r = await db.query<{ r: { summary: unknown; cohorts: unknown } }>(
      `select public.ops_retention(${arr}, '${start.toISOString()}', '${endExclusive.toISOString()}') as r`);
    const got = r.rows[0].r;
    check(`${label}: the summary equals the reference`, canon(got.summary) === canon(expected.summary), { got: got.summary, expected: expected.summary });
    check(`${label}: the six cohorts equal the reference`, canon(got.cohorts) === canon(expected.cohorts), { got: got.cohorts, expected: expected.cohorts });
    check(`${label}: the figures are not trivial`, expected.summary.customers > 100 && expected.cohorts.some((c) => c.r30 !== null && c.customers > 0));
  }

  // The tie at the rounding boundary: 1 of 16 → 6.25 % → JavaScript rounds .5 up to 6.3.
  const t = new PGlite();
  await t.exec(`create table public.orders (id uuid primary key, customer_id uuid, zone_id uuid, status text, payment_method text,
    payment_status text, total integer, created_at timestamptz);`);
  await t.exec(fn(read("0142_manager_orders_live.sql"), "ops_counts_as_order"));
  await t.exec(fn(read("0162_manager_customers.sql"), "ops_retention"));
  const tie: string[] = [];
  for (let c = 1; c <= 16; c++) {
    tie.push(`('${uuid(200000 + c * 2)}','${uuid(7000 + c)}','${Z1}','delivered','cod',null,100,'2026-10-05T10:00:00Z')`);
    if (c === 1) tie.push(`('${uuid(200001)}','${uuid(7000 + c)}','${Z1}','delivered','cod',null,100,'2026-10-06T10:00:00Z')`);
  }
  await t.exec(`insert into public.orders values ${tie.join(",")}`);
  const tr = { from: "2026-10-01", to: "2026-10-31" };
  const tb = rangeBounds(tr);
  const tg = (await t.query<{ r: { summary: { repeatRate: number } } }>(
    `select public.ops_retention(null, '${tb.start.toISOString()}', '${tb.endExclusive.toISOString()}') as r`)).rows[0].r;
  check("a half-way tie rounds up, as JavaScript does (1 of 16 → 6.3)", tg.summary.repeatRate === 6.3, tg.summary);
  const none = (await t.query<{ r: { summary: { customers: number }; cohorts: unknown[] } }>(
    `select public.ops_retention(array['${Z2}']::uuid[], '${tb.start.toISOString()}', '${tb.endExclusive.toISOString()}') as r`)).rows[0].r;
  check("a scope with no orders answers zeros, six cohorts, not an error", none.summary.customers === 0 && none.cohorts.length === 6);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 400)); process.exit(1); });
