// A deterministic 100,000-order database for the Manager app's budgets (Phase 10, Task 6).
//
// Builds the real migration chain in PGlite (scripts/qa/sql/chain-lib.mjs), then loads, with
// set-based SQL and a fixed random seed (setseed(0.42)):
//   3 zones in 2 cities · 120 vendors · 2,000 menu items · 80 riders · 30,000 customers
//   100,000 orders over 400 days — about 85 % delivered, 8 % cancelled (cancelled_by spread),
//   2 % unpaid online checkouts, the rest in flight — 1 to 5 item lines each, deliveries and
//   delivery events, refunds on about 1.5 %, vendor settlements covering delivered orders
//   older than 14 days, 2,000 tickets, 500 alerts, 20,000 audit rows, rider shifts.
//
// Triggers and foreign keys are switched off while loading (session_replication_role = replica)
// so the load is quick; every column a trigger would have filled is set explicitly instead.
// The shape of the data, not the trigger logic, is what the budgets measure.
//
// Usage:  import { buildSeededDb } from "./seed-manager-100k.mjs"
//         node scripts/perf/seed-manager-100k.mjs [orders]      (builds it and prints the counts)
import { freshChain, one } from "../qa/sql/chain-lib.mjs";

const IDS = {
  admin: "00000000-0000-0000-0000-00000000a001",
  mgrA: "00000000-0000-0000-0000-00000000a002",
  mgrB: "00000000-0000-0000-0000-00000000a003",
};

/** Insert only the columns this schema has, so the seed keeps working as migrations add columns. */
async function insertInto(db, table, sourceSql, cols) {
  // Columns the schema generates (short_code, identity ALWAYS) are skipped; absent ones too.
  const have = new Set(
    (await one(db, `select column_name c from information_schema.columns where table_schema = 'public' and table_name = $1
                      and is_generated <> 'ALWAYS' and coalesce(identity_generation, '') <> 'ALWAYS'`, [table])).map((r) => r.c)
  );
  const use = Object.entries(cols).filter(([c]) => have.has(c));
  const names = use.map(([c]) => `"${c}"`).join(", ");
  const exprs = use.map(([, e]) => e).join(", ");
  try {
    await db.exec(`insert into public.${table} (${names}) select ${exprs} from (${sourceSql}) s`);
  } catch (e) {
    throw new Error(`seeding ${table}: ${String(e.message).slice(0, 220)}`);
  }
  return use.map(([c]) => c);
}

const t = () => performance.now();

export async function buildSeededDb({ orders = 100_000, log = () => {} } = {}) {
  const { db, err } = await freshChain();
  if (err) throw new Error(`migration chain failed: ${err}`);
  const lap = (what, t0) => log(`  seeded ${what} in ${((t() - t0) / 1000).toFixed(1)} s`);
  const T0 = t();

  await db.exec(`select setseed(0.42); set session_replication_role = replica;`);

  // ── zones and staff ──
  let t0 = t();
  await db.exec(`
    insert into public.cities (id, name, slug) values ('00000000-0000-0000-0000-0000000c0002', 'Durg', 'durg') on conflict do nothing;
  `);
  const [city1] = await one(db, `select id from public.cities where slug <> 'durg' order by created_at nulls last, id limit 1`);
  await db.exec(`
    insert into public.delivery_zones (id, city_id, name, slug, center_lat, center_lng, radius_km) values
      ('00000000-0000-0000-0000-0000000e0002', '${city1.id}', 'Nawagarh', 'nawagarh', 21.75, 81.55, 6),
      ('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000c0002', 'Durg Central', 'durg-central', 21.19, 81.28, 8)
    on conflict do nothing;
  `);
  const zones = (await one(db, `select id from public.delivery_zones order by slug`)).map((z) => z.id);
  if (zones.length < 3) throw new Error(`expected 3 zones, found ${zones.length}`);
  const zoneArr = `array[${zones.map((z) => `'${z}'::uuid`).join(",")}]`;
  const zoneOf = (i) => `(${zoneArr})[1 + (${i}) % 3]`;
  lap("zones", t0);

  // ── people ──
  t0 = t();
  await db.exec(`
    insert into public.profiles (id, role, full_name) values
      ('${IDS.admin}', 'admin', 'Admin'), ('${IDS.mgrA}', 'manager', 'Manager A'), ('${IDS.mgrB}', 'manager', 'Manager B') on conflict (id) do nothing;
    delete from public.staff_zones where user_id in ('${IDS.mgrA}', '${IDS.mgrB}');
    insert into public.staff_zones (user_id, zone_id) values ('${IDS.mgrA}', '${zones[0]}'), ('${IDS.mgrA}', '${zones[1]}'), ('${IDS.mgrB}', '${zones[2]}');
  `);
  await insertInto(db, "profiles", `select md5('c' || g)::uuid id, g from generate_series(1, 30000) g`, {
    id: "id", role: "'customer'", full_name: "'Customer ' || g", phone: "'+9198' || lpad(g::text, 8, '0')",
  });
  await insertInto(db, "profiles", `select md5('r' || g)::uuid id, g from generate_series(1, 80) g`, {
    id: "id", role: "'driver'", full_name: "'Rider ' || g", phone: "'+9197' || lpad(g::text, 8, '0')",
  });
  await insertInto(db, "profiles", `select md5('v' || g)::uuid id, g from generate_series(1, 120) g`, {
    id: "id", role: "'restaurant'", full_name: "'Owner ' || g",
  });
  lap("people", t0);

  // ── vendors and menus ──
  t0 = t();
  await insertInto(db, "restaurants", `select md5('rest' || g)::uuid id, md5('v' || g)::uuid owner, g, ${zoneOf("g")} z from generate_series(1, 120) g`, {
    id: "id", owner_id: "owner", slug: "'vendor-' || g", name: "'Vendor ' || g", zone_id: "z", approved: "true", is_open: "(g % 9 <> 0)",
    status: "'active'", commission_pct: "10", lat: "21.7 + (g % 20) * 0.003", lng: "81.5 + (g % 20) * 0.003", eta_min: "20", eta_max: "40",
  });
  await insertInto(db, "menu_items", `select md5('mi' || g)::uuid id, md5('rest' || (1 + g % 120))::uuid rid, g from generate_series(1, 2000) g`, {
    id: "id", restaurant_id: "rid", name: "'Dish ' || g", price: "40 + (g * 7) % 360", category: "(array['Starters','Mains','Breads','Rice','Desserts','Drinks'])[1 + g % 6]",
    available: "(g % 17 <> 0)",
  });
  lap("vendors and menu", t0);

  // ── orders ──
  t0 = t();
  // r drives the outcome; in-flight and unpaid orders are recent, the rest spread over 400 days.
  await db.exec(`
    create temp table seed_orders as
    select g,
           md5('o' || g)::uuid id,
           md5('c' || (1 + (g * 7919) % 30000))::uuid customer,
           md5('rest' || (1 + (g * 31) % 120))::uuid vendor,
           ${zoneOf("1 + ((g * 31) % 120) - 1")} zone,
           random() r, random() r2, random() r3
    from generate_series(1, ${orders}) g;
    alter table seed_orders add column outcome text, add column created timestamptz, add column method text, add column pay text, add column fee int, add column rider uuid;
    update seed_orders set outcome = case when r < 0.85 then 'delivered' when r < 0.93 then 'cancelled' when r < 0.95 then 'unpaid' when r < 0.97 then 'placed'
                                          when r < 0.98 then 'kitchen' when r < 0.99 then 'ready' else 'on_the_way' end;
    update seed_orders set created = case when outcome in ('placed','kitchen','ready','on_the_way','unpaid') then now() - (r2 * interval '110 minutes')
                                          else now() - (r2 * interval '400 days') - interval '3 hours' end,
                           method = case when outcome = 'unpaid' or r3 < 0.40 then 'online' else 'cod' end,
                           fee = 20 + (g % 4) * 10,
                           rider = md5('r' || (1 + g % 80))::uuid;
    update seed_orders set pay = case when method = 'online' and outcome = 'unpaid' then 'pending' when method = 'online' then 'paid' else 'pending' end;
    create index on seed_orders (g);
  `);
  // items first, so each order's total can be their sum plus the fee
  await db.exec(`
    create temp table seed_items as
    select o.id order_id, k, 'Item ' || k name, 1 + (o.g + k) % 3 qty, 40 + ((o.g * 13 + k * 29) % 360) price
    from seed_orders o, lateral generate_series(1, 1 + (o.g % 5)) k;
  `);
  await db.exec(`create index on seed_items (order_id);`);
  await db.exec(`
    create temp table seed_totals as select order_id, sum(qty * price)::int sub from seed_items group by order_id;
    create index on seed_totals (order_id);
  `);
  const orderCols = await insertInto(
    db,
    "orders",
    `select o.*, st.sub from seed_orders o join seed_totals st on st.order_id = o.id`,
    {
      id: "id", customer_id: "customer", restaurant_id: "vendor", zone_id: "zone",
      status: "(case outcome when 'delivered' then 'delivered' when 'cancelled' then 'cancelled' when 'unpaid' then 'placed' else outcome end)::public.order_status",
      total: "sub + fee", subtotal: "sub", delivery_fee: "fee", tax: "0", tip: "0", discount: "0",
      payment_method: "method::public.payment_method", payment_status: "pay::public.payment_status",
      created_at: "created", updated_at: "created",
      accepted_at: "case when outcome in ('delivered','kitchen','ready','on_the_way') then created + interval '2 minutes' end",
      ready_at: "case when outcome in ('delivered','ready','on_the_way') then created + interval '16 minutes' end",
      delivered_at: "case when outcome = 'delivered' then created + interval '38 minutes' end",
      cancelled_at: "case when outcome = 'cancelled' then created + interval '5 minutes' end",
      cancelled_by: "case when outcome = 'cancelled' then (array['customer','vendor','admin','manager','system'])[1 + g % 5] end",
      cancellation_reason: "case when outcome = 'cancelled' then 'Seeded reason ' || (g % 7) end",
      short_code: "upper(substr(md5(id::text), 1, 8))",
      address: "jsonb_build_object('line1', 'House ' || g, 'lat', 21.7, 'lng', 81.5)",
    }
  );
  log(`  orders columns set: ${orderCols.join(", ")}`);
  await db.exec(`drop table seed_totals;`);
  lap(`${orders} orders`, t0);

  t0 = t();
  await insertInto(db, "order_items", `select * from seed_items`, {
    order_id: "order_id", name: "name", qty: "qty", price: "price",
  });
  lap("order items", t0);

  // ── deliveries and their events ──
  t0 = t();
  await insertInto(db, "deliveries", `select o.*, md5('d' || o.id::text)::uuid did from seed_orders o where outcome in ('delivered','ready','on_the_way')`, {
    id: "did", order_id: "id", driver_id: "rider",
    status: "(case outcome when 'delivered' then 'delivered' when 'on_the_way' then 'picked_up' else 'assigned' end)::public.delivery_status",
    assigned_at: "created + interval '17 minutes'", picked_up_at: "case when outcome in ('delivered','on_the_way') then created + interval '22 minutes' end",
    delivered_at: "case when outcome = 'delivered' then created + interval '38 minutes' end",
    cod_collected_amount: "case when outcome = 'delivered' and method = 'cod' then fee + 150 end",
    cod_collected_at: "case when outcome = 'delivered' and method = 'cod' then created + interval '38 minutes' end",
    driver_lat: "21.7", driver_lng: "81.5", driver_location_at: "case when outcome <> 'delivered' then now() - interval '40 seconds' end",
    created_at: "created",
  });
  await insertInto(
    db,
    "delivery_events",
    `select md5('d' || o.id::text)::uuid did, o.id oid, o.rider, o.created, e.kind, e.mins
       from seed_orders o, (values ('accepted', 17), ('picked_up', 22), ('delivered', 38)) e(kind, mins)
      where o.outcome = 'delivered'`,
    { delivery_id: "did", order_id: "oid", kind: "kind", actor_id: "rider", actor_role: "'driver'", created_at: "created + (mins || ' minutes')::interval" }
  );
  lap("deliveries and events", t0);

  // ── refunds, settlements ──
  t0 = t();
  await insertInto(db, "refunds", `select o.id, o.g, o.total_ from (select id, g, (g % 300 + 60) total_ from seed_orders where outcome in ('delivered') and g % 67 = 0) o`, {
    order_id: "id", amount: "total_", reason: "'Seeded refund'", status: "(case g % 3 when 0 then 'approved' when 1 then 'pending' else 'denied' end)::public.refund_status",
    origin: "'customer'", created_at: "now() - (g % 300 || ' days')::interval",
  }).catch((e) => log(`  (refunds skipped: ${String(e.message).slice(0, 90)})`));
  // an approved refund must be unique per order and a pending one too — g % 67 selects each order once.
  await db.exec(`
    create temp table seed_periods as
    select md5('s' || o.vendor::text || p)::uuid sid, o.vendor, p,
           now() - ((p + 1) * 14 || ' days')::interval ps, now() - (p * 14 || ' days')::interval pe
    from (select distinct vendor, floor(extract(epoch from (now() - created)) / 86400 / 14)::int p from seed_orders where outcome = 'delivered') o
    where p >= 1;
  `);
  await insertInto(db, "vendor_settlements", `select * from seed_periods`, {
    id: "sid", restaurant_id: "vendor", period_start: "ps", period_end: "pe", status: "'paid'::public.vendor_settlement_status",
    paid_at: "pe + interval '2 days'", created_at: "pe", kind: "'batch'", net_payable: "0",
  });
  await insertInto(
    db,
    "vendor_settlement_orders",
    `select o.id oid, o.fee, st.sub, sp.sid, o.method from seed_orders o join seed_totals_2 st on st.order_id = o.id
       join seed_periods sp on sp.vendor = o.vendor and sp.p = floor(extract(epoch from (now() - o.created)) / 86400 / 14)::int
      where o.outcome = 'delivered'`.replace("seed_totals_2", "(select order_id, sum(qty * price)::int sub from seed_items group by order_id)"),
    { settlement_id: "sid", order_id: "oid", food_gross: "sub", commission: "round(sub * 0.1)::int", vendor_net: "sub - round(sub * 0.1)::int", contribution: "sub - round(sub * 0.1)::int", payment_status: "case when method = 'online' then 'paid' else 'pending' end" }
  );
  await db.exec(`
    update public.vendor_settlements s set net_payable = coalesce((select sum(l.contribution) from public.vendor_settlement_orders l where l.settlement_id = s.id), 0);
  `).catch(() => {});
  lap("refunds and settlements", t0);

  // ── riders, shifts, tickets, alerts, audit ──
  t0 = t();
  await insertInto(db, "rider_status", `select md5('r' || g)::uuid did, g from generate_series(1, 80) g`, {
    driver_id: "did", is_online: "(g % 3 <> 0)", last_lat: "21.7", last_lng: "81.5", last_fix_at: "now() - ((g % 7) * 40 || ' seconds')::interval", online_since: "now() - interval '3 hours'",
  });
  await insertInto(db, "rider_shifts", `select md5('r' || r)::uuid did, r, d from generate_series(1, 80) r, generate_series(1, 30) d`, {
    driver_id: "did", started_at: "now() - (d || ' days')::interval", ended_at: "now() - (d || ' days')::interval + interval '8 hours'",
  });
  await insertInto(db, "support_tickets", `select g, md5('c' || g)::uuid req, md5('t' || g)::uuid id from generate_series(1, 2000) g`, {
    id: "id", number: "g", requester_id: "req", requester_role: "(array['customer','restaurant','driver'])[1 + g % 3]", category: "(array['order','payment','delivery','account','other'])[1 + g % 5]",
    subject: "'Seeded ticket ' || g", status: "(array['open','in_progress','escalated','resolved','closed'])[1 + g % 5]", zone_id: zoneOf("g"),
    priority: "(array['normal','high','normal','normal'])[1 + g % 4]", created_at: "now() - (g % 90 || ' days')::interval - ((g % 24) || ' hours')::interval",
  });
  await insertInto(db, "ops_alerts", `select g from generate_series(1, 500) g`, {
    kind: "(array['order_unassigned','delivery_delayed','vendor_downtime','rider_shortage','settlement_delayed'])[1 + g % 5]", severity: "(array['info','warning','critical'])[1 + g % 3]",
    title: "'Seeded alert ' || g", body: "'Seeded'", entity_type: "'order'", entity_id: "g::text", dedupe_key: "'seed-' || g", status: "(array['open','acknowledged','resolved'])[1 + g % 3]",
    zone_id: zoneOf("g"), opened_at: "now() - (g % 40 || ' days')::interval", last_seen_at: "now() - (g % 40 || ' days')::interval",
  });
  await insertInto(db, "ops_audit_log", `select g from generate_series(1, 20000) g`, {
    actor_id: `'${IDS.mgrA}'::uuid`, actor_role: "'manager'", action: "(array['order.advance','order.cancel','vendor.status','rider.status','customer.suspend'])[1 + g % 5]",
    entity_type: "(array['order','order','vendor','rider','customer'])[1 + g % 5]", entity_id: "g::text", zone_id: zoneOf("g"), reason: "'Seeded'",
    created_at: "now() - (g % 200 || ' days')::interval - ((g % 1440) || ' minutes')::interval",
  });
  lap("riders, tickets, alerts, audit", t0);

  await db.exec(`set session_replication_role = origin; drop table seed_orders; drop table seed_items; drop table seed_periods;`);
  t0 = t();
  await db.exec(`analyze;`);
  lap("analyze", t0);
  log(`seed done in ${((t() - T0) / 1000).toFixed(0)} s`);
  return { db, zones, ids: IDS };
}

if (import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`) {
  const n = Number(process.argv[2] ?? 100_000);
  const { db } = await buildSeededDb({ orders: n, log: console.log });
  for (const tbl of ["orders", "order_items", "deliveries", "delivery_events", "refunds", "vendor_settlements", "vendor_settlement_orders", "support_tickets", "ops_alerts", "ops_audit_log", "restaurants", "profiles", "rider_shifts"]) {
    const [r] = await one(db, `select count(*)::int c from public.${tbl}`);
    console.log(`${tbl.padEnd(26)} ${r.c}`);
  }
  process.exit(0);
}
