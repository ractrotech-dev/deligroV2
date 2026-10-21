-- ============================================================
-- 0144 — Ops metrics in SQL: the dashboard and statistics as rollups
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database from this repo.
-- Order: after 0061 → 0081 → 0141 (→ 0142/0143 when Phase 3 lands).
--
-- The gap this closes (Phase 2 review, finding 1): the manager dashboard read
-- every order in scope for all time — plus every refund and every paid
-- settlement line — into Node every 30 s per open app, and the statistics
-- screen read two periods of orders plus every item line. At 100k orders that
-- is ~100 sequential deep-OFFSET pages and ~1000 refund requests at once; past
-- 200k orders `read-all`'s ceiling turns the dashboard into a permanent 500.
--
-- The figures are now summed where the rows live. Three rules keep them the
-- same numbers as before:
--
--   * `src/lib/metrics` stays the reference implementation. Every function
--     here is a transcription of one there, and scripts/qa/ops-sql-parity.ts
--     runs both over the same randomised fixtures and requires identical
--     output — every figure, to the rupee.
--   * `ops_order_breakdown` mirrors `breakdownOrder` in
--     src/lib/settlements/math.ts in double precision with JavaScript's
--     Math.round (`ops_js_round` = floor(x + 0.5)), so a commission computed
--     here rounds exactly as the settlement statement does — including the
--     cases where 0.15 is not exactly 0.15.
--   * `ops_counts_as_order` is `isCountedOrder`: an online checkout whose
--     payment is pending or failed is not an order in any figure.
--
-- Callers: /api/manager/dashboard and /api/manager/stats, through
-- src/lib/data-access/ops-metrics.ts, behind managerApiContext(). Service role
-- only — these functions bypass RLS by running as the caller's role with the
-- zone list the caller passes, so they must never be reachable by a client.
--
-- Rollback:
--   drop function if exists public.ops_stats_rollup(uuid[], timestamptz, timestamptz, uuid, boolean);
--   drop function if exists public.ops_dashboard_rollup(uuid[], timestamptz, timestamptz, timestamptz, double precision, double precision);
--   drop function if exists public.ops_order_breakdown(numeric, numeric, numeric, numeric, numeric, text, double precision, double precision, numeric, text, text, numeric);
--   drop function if exists public.ops_counts_as_order(text, text);
--   drop function if exists public.ops_js_round(double precision);
-- ============================================================

begin;

-- JavaScript's Math.round over a double: halves round up (towards +∞).
create or replace function public.ops_js_round(x double precision)
returns bigint
language sql immutable parallel safe set search_path = public as $$
  select floor(coalesce(x, 0) + 0.5)::bigint;
$$;

-- `isCountedOrder` (src/lib/metrics/definitions.ts).
create or replace function public.ops_counts_as_order(p_method text, p_payment text)
returns boolean
language sql immutable parallel safe set search_path = public as $$
  select coalesce(p_method, '') <> 'online'
      or coalesce(p_payment, '') in ('authorized', 'paid', 'refunded');
$$;

-- `breakdownOrder` (src/lib/settlements/math.ts), the parts the ops figures
-- read. `deductions` is what the platform keeps (commission + its GST + other
-- charges, clamped to the food value); the three components are the clamped
-- figures the statement prints, so they always sum to it.
create or replace function public.ops_order_breakdown(
  p_total numeric,
  p_fee numeric,
  p_tax numeric,
  p_tip numeric,
  p_discount numeric,
  p_funded_by text,
  p_commission_pct double precision,
  p_gst_pct double precision,
  p_other_charges numeric,
  p_method text,
  p_payment text,
  p_refunds numeric,
  out commission bigint,
  out commission_gst bigint,
  out other_charges bigint,
  out deductions bigint,
  out contribution bigint
)
language plpgsql immutable parallel safe set search_path = public as $$
declare
  platform_discount bigint := 0;
  food bigint;
  pct double precision;
  gst_pct double precision;
  c bigint;
  g bigint;
  o bigint;
  d bigint;
  refunded bigint;
begin
  if p_funded_by = 'platform' then
    platform_discount := greatest(0, public.ops_js_round(p_discount::double precision));
  end if;
  food := greatest(0,
    public.ops_js_round(p_total::double precision)
    - public.ops_js_round(p_fee::double precision)
    - public.ops_js_round(p_tax::double precision)
    - public.ops_js_round(p_tip::double precision)
    + platform_discount);
  pct := least(100, greatest(0, coalesce(p_commission_pct, 0)));
  gst_pct := least(100, greatest(0, coalesce(p_gst_pct, 0)));
  c := public.ops_js_round(food::double precision * (pct / 100));
  g := public.ops_js_round(c::double precision * (gst_pct / 100));
  o := greatest(0, public.ops_js_round(p_other_charges::double precision));
  d := least(food, c + g + o);
  refunded := greatest(0, public.ops_js_round(p_refunds::double precision));

  commission := least(c, d);
  commission_gst := least(g, greatest(0, d - c));
  other_charges := greatest(0, d - c - g);
  deductions := d;
  if p_method = 'online' and p_payment in ('paid', 'refunded') then
    contribution := (food - d) - refunded;
  else
    contribution := platform_discount - d - refunded;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- The dashboard (§1): `computeDashboard` over all-time orders in scope, plus
-- the vendor, rider, marketing and support counts. `p_zone_ids` null = every
-- zone (an admin); an empty array = nothing (a manager with no zones).
-- A count whose table or column does not exist yet comes back null and the
-- caller reports it as unavailable.
-- ------------------------------------------------------------
create or replace function public.ops_dashboard_rollup(
  p_zone_ids uuid[],
  p_today_start timestamptz,
  p_today_end timestamptz,
  p_now timestamptz,
  p_commission_default double precision,
  p_gst_pct double precision
)
returns jsonb
language plpgsql stable set search_path = public as $$
declare
  orders_part jsonb;
  vendor_part jsonb;
  active_vendors bigint;
  online_vendors bigint;
  active_riders bigint;
  online_riders bigint;
  riders_on_delivery bigint;
  pending_marketing bigint;
  pending_support bigint;
begin
  with o as (
    select o.id, o.restaurant_id, o.status::text as status, o.created_at,
           o.total, o.delivery_fee, o.tax_amount, o.tip, o.discount,
           o.discount_funded_by::text as funded_by,
           o.payment_method::text as pm, o.payment_status::text as ps
      from public.orders o
     where (p_zone_ids is null or o.zone_id = any (p_zone_ids))
       and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
  ),
  rf as (
    select r.order_id, sum(greatest(0, public.ops_js_round(r.amount::double precision))) as amount
      from public.refunds r
      join o on o.id = r.order_id
     where r.status::text = 'approved'
     group by r.order_id
  ),
  priced as (
    select o.id, o.restaurant_id, o.status, b.deductions, b.contribution
      from o
      left join public.restaurants s on s.id = o.restaurant_id
      left join rf on rf.order_id = o.id
      cross join lateral public.ops_order_breakdown(
        o.total, o.delivery_fee, o.tax_amount, o.tip, o.discount, o.funded_by,
        case when s.id is null then 0
             else least(100, greatest(0, coalesce(s.commission_pct::double precision, p_commission_default))) end,
        p_gst_pct,
        coalesce(s.other_charges_per_order, 0),
        o.pm, o.ps, coalesce(rf.amount, 0)) b
     where o.status <> 'cancelled'
  ),
  paid as (
    select vso.order_id
      from public.vendor_settlement_orders vso
      join public.vendor_settlements vs on vs.id = vso.settlement_id
     where vs.status::text = 'paid'
  ),
  dues as (
    select p.restaurant_id, sum(p.contribution) as net
      from priced p
     where p.status = 'delivered'
       and not exists (select 1 from paid where paid.order_id = p.id)
     group by p.restaurant_id
  )
  select jsonb_build_object(
           'todaysOrders', (select count(*) from o where o.created_at >= p_today_start and o.created_at < p_today_end),
           'todaysTotalSales', (select coalesce(sum(public.ops_js_round(o.total::double precision)), 0) from o
                                 where o.created_at >= p_today_start and o.created_at < p_today_end and o.status <> 'cancelled'),
           'totalOrders', (select count(*) from o),
           'totalSales', (select coalesce(sum(public.ops_js_round(o.total::double precision)), 0) from o where o.status <> 'cancelled'),
           'pendingOrders', (select count(*) from o where o.status in ('placed', 'kitchen', 'ready', 'on_the_way')),
           'completedOrders', (select count(*) from o where o.status = 'delivered'),
           'cancelledOrders', (select count(*) from o where o.status = 'cancelled'),
           'totalDeliveryFees', (select coalesce(sum(public.ops_js_round(o.delivery_fee::double precision)), 0) from o where o.status <> 'cancelled'),
           'totalPlatformCommission', (select coalesce(sum(p.deductions), 0) from priced p),
           'vendorPaymentsDue', (select coalesce(sum(greatest(d.net, 0)), 0) from dues d),
           'vendorRecoverable', (select coalesce(sum(greatest(-d.net, 0)), 0) from dues d)
         )
    into orders_part;

  select count(*) filter (where r.status::text = 'active'),
         count(*) filter (where r.status::text = 'active' and r.is_open is true)
    into active_vendors, online_vendors
    from public.restaurants r
   where p_zone_ids is null or r.zone_id = any (p_zone_ids);

  if p_zone_ids is null then
    select count(*) into active_riders from public.profiles p where p.role::text = 'driver';
  else
    select count(distinct sz.user_id) into active_riders
      from public.staff_zones sz
      join public.profiles p on p.id = sz.user_id and p.role::text = 'driver'
     where sz.zone_id = any (p_zone_ids);
  end if;

  select count(distinct d.driver_id) into riders_on_delivery
    from public.deliveries d
    join public.orders o on o.id = d.order_id
   where d.status::text in ('assigned', 'picked_up')
     and d.driver_id is not null
     and (p_zone_ids is null or o.zone_id = any (p_zone_ids));

  begin
    execute $q$
      select count(*)
        from public.rider_status rs
       where rs.is_online
         and (rs.break_until is null or rs.break_until <= $2)
         and ($1 is null or exists (
               select 1 from public.staff_zones sz
                where sz.user_id = rs.driver_id and sz.zone_id = any ($1)))
    $q$ into online_riders using p_zone_ids, p_now;
  exception when undefined_table or undefined_column then
    online_riders := null;
  end;

  begin
    execute $q$
      select count(*)
        from public.marketing_requests m
        join public.restaurants r on r.id = m.restaurant_id
       where m.status::text = 'pending'
         and ($1 is null or r.zone_id = any ($1))
    $q$ into pending_marketing using p_zone_ids;
  exception when undefined_table or undefined_column then
    pending_marketing := null;
  end;

  begin
    execute $q$
      select count(*)
        from public.support_tickets t
       where t.status::text in ('open', 'in_progress', 'escalated')
         and ($1 is null or t.zone_id = any ($1))
    $q$ into pending_support using p_zone_ids;
  exception when undefined_table or undefined_column then
    pending_support := null;
  end;

  return orders_part || jsonb_build_object(
    'activeVendors', active_vendors,
    'onlineVendors', online_vendors,
    'activeRiders', active_riders,
    'onlineRiders', online_riders,
    'ridersOnDelivery', riders_on_delivery,
    'pendingMarketingRequests', pending_marketing,
    'pendingSupportTickets', pending_support
  );
end;
$$;

-- ------------------------------------------------------------
-- Statistics (§2): the sums `computeStats` makes, for orders created in
-- [p_start, p_end), grouped every way the screen groups them. Rankings,
-- averages, zero-filling and bucketing to weeks/months stay in TypeScript
-- (`statsFromRollup`), over these sums. `p_summary_only` skips the groupings
-- (the previous period only needs its totals).
-- ------------------------------------------------------------
create or replace function public.ops_stats_rollup(
  p_zone_ids uuid[],
  p_start timestamptz,
  p_end timestamptz,
  p_restaurant uuid default null,
  p_summary_only boolean default false
)
returns jsonb
-- Volatile, not stable: it stages the period's orders in a temporary table
-- (dropped at commit) so each grouping below reads them once.
language plpgsql volatile set search_path = public as $$
declare
  result jsonb;
  groups jsonb := '{}'::jsonb;
begin
  create temporary table if not exists ops_stats_o (
    id uuid primary key,
    restaurant_id uuid,
    zone_id uuid,
    status text,
    ist timestamp,
    total bigint,
    fee bigint,
    discount bigint,
    funded_by text,
    cancelled_by text,
    reason text,
    gross bigint
  ) on commit drop;
  truncate ops_stats_o;

  insert into ops_stats_o
  select o.id, o.restaurant_id, o.zone_id, o.status::text,
         o.created_at at time zone 'Asia/Kolkata',
         public.ops_js_round(o.total::double precision),
         public.ops_js_round(o.delivery_fee::double precision),
         greatest(0, public.ops_js_round(o.discount::double precision)),
         o.discount_funded_by::text,
         case when o.cancelled_by::text in ('customer', 'vendor', 'manager', 'admin', 'system')
              then o.cancelled_by::text else 'unknown' end,
         nullif(btrim(o.cancellation_reason, E' \t\r\n'), ''),
         case when it.n > 0 then it.subtotal
              else greatest(0,
                public.ops_js_round(o.total::double precision)
                - public.ops_js_round(o.delivery_fee::double precision)
                - public.ops_js_round(o.tax_amount::double precision)
                - public.ops_js_round(o.tip::double precision)
                + public.ops_js_round(o.discount::double precision)) end
    from public.orders o
    left join lateral (
      select count(*) as n,
             coalesce(sum(public.ops_js_round(oi.qty::double precision) * public.ops_js_round(oi.price::double precision)), 0) as subtotal
        from public.order_items oi
       where oi.order_id = o.id
    ) it on true
   where o.created_at >= p_start and o.created_at < p_end
     and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
     and (p_restaurant is null or o.restaurant_id = p_restaurant)
     and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text);

  with rf as (
    select r.order_id, greatest(0, public.ops_js_round(r.amount::double precision)) as amount
      from public.refunds r
      join ops_stats_o o on o.id = r.order_id
     where r.status::text = 'approved'
  )
  select jsonb_build_object(
    'salesOrders', count(*) filter (where o.status <> 'cancelled'),
    'grossSales', coalesce(sum(o.gross) filter (where o.status <> 'cancelled'), 0),
    'customerPaid', coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0),
    'discountVendor', coalesce(sum(o.discount) filter (where o.status <> 'cancelled' and o.funded_by is distinct from 'platform'), 0),
    'discountPlatform', coalesce(sum(o.discount) filter (where o.status <> 'cancelled' and o.funded_by = 'platform'), 0),
    'refundsTotal', (select coalesce(sum(rf.amount), 0) from rf join ops_stats_o x on x.id = rf.order_id where x.status <> 'cancelled'),
    'refundsCount', (select count(*) from rf join ops_stats_o x on x.id = rf.order_id where x.status <> 'cancelled'),
    'refundsOnCancelled', (select coalesce(sum(rf.amount), 0) from rf join ops_stats_o x on x.id = rf.order_id where x.status = 'cancelled'),
    'cancelledCount', count(*) filter (where o.status = 'cancelled'),
    'cancelledValue', coalesce(sum(o.total) filter (where o.status = 'cancelled'), 0),
    'completedCount', count(*) filter (where o.status = 'delivered'),
    'completedValue', coalesce(sum(o.total) filter (where o.status = 'delivered'), 0),
    'deliveryFees', coalesce(sum(o.fee) filter (where o.status <> 'cancelled'), 0)
  )
    into result
    from ops_stats_o o;

  if p_summary_only then
    return jsonb_build_object('summary', result);
  end if;

  select groups || jsonb_build_object('byDay', coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(d.day, 'YYYY-MM-DD'), 'orders', d.orders, 'sales', d.sales, 'cancelled', d.cancelled)
           order by d.day), '[]'::jsonb))
    into groups
    from (select o.ist::date as day,
                 count(*) filter (where o.status <> 'cancelled') as orders,
                 coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0) as sales,
                 count(*) filter (where o.status = 'cancelled') as cancelled
            from ops_stats_o o group by 1) d;

  select groups || jsonb_build_object('byCancelledBy', coalesce(jsonb_object_agg(c.by, jsonb_build_object('count', c.n, 'value', c.v)), '{}'::jsonb))
    into groups
    from (select o.cancelled_by as by, count(*) as n, sum(o.total) as v
            from ops_stats_o o where o.status = 'cancelled' group by 1) c;

  select groups || jsonb_build_object('reasons', coalesce(jsonb_agg(jsonb_build_object('reason', r.reason, 'count', r.n)), '[]'::jsonb))
    into groups
    from (select o.reason, count(*) as n
            from ops_stats_o o where o.status = 'cancelled' and o.reason is not null
           group by 1 order by 2 desc, 1 limit 200) r;

  select groups || jsonb_build_object('peak', coalesce(jsonb_agg(jsonb_build_object('weekday', p.wd, 'hour', p.hr, 'orders', p.n)), '[]'::jsonb))
    into groups
    from (select extract(isodow from o.ist)::int - 1 as wd, extract(hour from o.ist)::int as hr, count(*) as n
            from ops_stats_o o where o.status <> 'cancelled' group by 1, 2) p;

  select groups || jsonb_build_object('byVendor', coalesce(jsonb_agg(jsonb_build_object(
           'restaurantId', v.restaurant_id, 'orders', v.orders, 'sales', v.sales,
           'cancelled', v.cancelled, 'refunds', v.refunds)), '[]'::jsonb))
    into groups
    from (select o.restaurant_id,
                 count(*) filter (where o.status <> 'cancelled') as orders,
                 coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0) as sales,
                 count(*) filter (where o.status = 'cancelled') as cancelled,
                 coalesce(max(vr.amount), 0) as refunds
            from ops_stats_o o
            left join (
              select x.restaurant_id, sum(greatest(0, public.ops_js_round(r.amount::double precision))) as amount
                from public.refunds r
                join ops_stats_o x on x.id = r.order_id
               where r.status::text = 'approved' and x.status <> 'cancelled'
               group by x.restaurant_id
            ) vr on vr.restaurant_id = o.restaurant_id
           group by o.restaurant_id) v;

  select groups || jsonb_build_object('byCategory', coalesce(jsonb_agg(jsonb_build_object(
           'category', c.category, 'sales', c.sales, 'qty', c.qty, 'orders', c.orders)), '[]'::jsonb))
    into groups
    from (select coalesce(nullif(btrim(mi.category, E' \t\r\n'), ''), 'Uncategorised') as category,
                 sum(public.ops_js_round(oi.qty::double precision) * public.ops_js_round(oi.price::double precision)) as sales,
                 sum(public.ops_js_round(oi.qty::double precision)) as qty,
                 count(distinct oi.order_id) as orders
            from ops_stats_o o
            join public.order_items oi on oi.order_id = o.id
            left join public.menu_items mi on mi.id = oi.menu_item_id
           where o.status <> 'cancelled'
           group by 1) c;

  select groups || jsonb_build_object('byZone', coalesce(jsonb_agg(jsonb_build_object(
           'zoneId', z.zone_id, 'orders', z.orders, 'sales', z.sales, 'cancelled', z.cancelled)), '[]'::jsonb))
    into groups
    from (select o.zone_id,
                 count(*) filter (where o.status <> 'cancelled') as orders,
                 coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0) as sales,
                 count(*) filter (where o.status = 'cancelled') as cancelled
            from ops_stats_o o group by o.zone_id) z;

  return jsonb_build_object('summary', result) || groups;
end;
$$;

-- Service role only. These take the scope as an argument, so a client able to
-- call them could pass any zone.
revoke execute on function public.ops_dashboard_rollup(uuid[], timestamptz, timestamptz, timestamptz, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.ops_stats_rollup(uuid[], timestamptz, timestamptz, uuid, boolean) from public, anon, authenticated;
grant execute on function public.ops_dashboard_rollup(uuid[], timestamptz, timestamptz, timestamptz, double precision, double precision) to service_role;
grant execute on function public.ops_stats_rollup(uuid[], timestamptz, timestamptz, uuid, boolean) to service_role;

-- The orders scans above are by zone and by created_at.
create index if not exists orders_zone_created_idx on public.orders (zone_id, created_at);

commit;
