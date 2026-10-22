-- ============================================================
-- 0157 — Finance rollups: sales & commission, vendor dues, rider dues,
--        reconciliation (orders ↔ settlements, cash ↔ deposits)
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database from this branch.
-- Order: after 0156 (needs 0144's ops_order_breakdown / ops_js_round /
-- ops_counts_as_order, 0142's orders.short_code, 0083's ledger, 0150's cash
-- tables).
--
-- Phase 6 (§7, §13). The Finance screens and the reports sum in Postgres —
-- the same rule Phase 2 set for the dashboard (0144): a year of orders is
-- never pulled into Node. Every figure here is the SQL mirror of the
-- reference arithmetic in src/lib/metrics and src/lib/settlements/math.ts
-- (ops_order_breakdown is that mirror, line for line), and
-- scripts/qa/manager-finance-sql-parity.ts holds them equal on one seeded
-- fixture set.
--
--   ops_finance_rollup        — the period's sales, discounts by funder,
--                               refunds (once each, on the order's day),
--                               cancelled (apart), delivery fees and platform
--                               commission; summary, by IST day, by shop.
--   ops_vendor_dues_scoped    — per shop, as of now: net of delivered orders
--                               not in a paid settlement, how many, the oldest.
--   ops_rider_dues            — per rider: unpaid ledger total (signed), the
--                               oldest unpaid date, the last payout.
--   ops_reconciliation_orders — every delivered order in the period against
--                               the settlement line that paid it (state,
--                               expected vs settled), counts by state and one
--                               keyset page.
--   ops_cash_reconciliation   — per rider × IST day: COD collected vs
--                               deposited (rider→manager legs), disputes; per
--                               manager × day: received vs handed on.
--
-- `p_zone_ids` null = every zone (an admin); an empty array = nothing. All
-- service role only — the routes authorise and scope first.
--
-- Rollback:
--   drop function if exists public.ops_finance_rollup(uuid[], timestamptz, timestamptz, uuid, text, double precision, double precision);
--   drop function if exists public.ops_vendor_dues_scoped(uuid[], double precision, double precision);
--   drop function if exists public.ops_rider_dues(uuid[], uuid);
--   drop function if exists public.ops_reconciliation_orders(uuid[], timestamptz, timestamptz, double precision, double precision, timestamptz, text, timestamptz, uuid, integer);
--   drop function if exists public.ops_cash_reconciliation(uuid[], date, date, uuid);
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Sales and commission for orders created in [p_start, p_end)
-- ------------------------------------------------------------
create or replace function public.ops_finance_rollup(
  p_zone_ids uuid[],
  p_start timestamptz,
  p_end timestamptz,
  p_restaurant uuid,
  p_payment text,
  p_commission_default double precision,
  p_gst_pct double precision
)
returns jsonb
language sql stable set search_path = public as $$
  with o as (
    select o.id, o.restaurant_id, o.status::text as status,
           to_char((o.created_at at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as day,
           public.ops_js_round(o.total::double precision) as total,
           public.ops_js_round(o.delivery_fee::double precision) as fee,
           greatest(0, public.ops_js_round(o.discount::double precision)) as discount,
           o.discount_funded_by::text as funded_by,
           o.total as raw_total, o.delivery_fee as raw_fee, o.tax_amount, o.tip, o.discount as raw_discount,
           o.payment_method::text as pm, o.payment_status::text as ps,
           case when it.n > 0 then it.subtotal
                else greatest(0,
                  public.ops_js_round(o.total::double precision)
                  - public.ops_js_round(o.delivery_fee::double precision)
                  - public.ops_js_round(o.tax_amount::double precision)
                  - public.ops_js_round(o.tip::double precision)
                  + public.ops_js_round(o.discount::double precision)) end as gross
      from public.orders o
      left join lateral (
        select count(*) as n,
               coalesce(sum(public.ops_js_round(oi.qty::double precision) * public.ops_js_round(oi.price::double precision)), 0) as subtotal
          from public.order_items oi where oi.order_id = o.id
      ) it on true
     where o.created_at >= p_start and o.created_at < p_end
       and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
       and (p_restaurant is null or o.restaurant_id = p_restaurant)
       and (p_payment is null or o.payment_method::text = p_payment)
       and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
  ),
  rf as (
    select r.order_id, count(*) as n, sum(greatest(0, public.ops_js_round(r.amount::double precision))) as amount
      from public.refunds r join o on o.id = r.order_id
     where r.status::text = 'approved'
     group by r.order_id
  ),
  p as (
    select o.*, coalesce(rf.amount, 0) as refunds, coalesce(rf.n, 0) as refund_n,
           case when o.status = 'cancelled' then 0 else b.commission end as commission,
           case when o.status = 'cancelled' then 0 else b.commission_gst end as commission_gst,
           case when o.status = 'cancelled' then 0 else b.other_charges end as other_charges,
           case when o.status = 'cancelled' then 0 else b.deductions end as deductions,
           case when o.status = 'cancelled' then 0 else greatest(0,
             o.total - o.fee
             - public.ops_js_round(o.tax_amount::double precision)
             - public.ops_js_round(o.tip::double precision)
             + case when o.funded_by = 'platform' then o.discount else 0 end) end as food
      from o
      left join public.restaurants s on s.id = o.restaurant_id
      left join rf on rf.order_id = o.id
      cross join lateral public.ops_order_breakdown(
        o.raw_total, o.raw_fee, o.tax_amount, o.tip, o.raw_discount, o.funded_by,
        case when s.id is null then 0
             else least(100, greatest(0, coalesce(s.commission_pct::double precision, p_commission_default))) end,
        p_gst_pct, coalesce(s.other_charges_per_order, 0), o.pm, o.ps, coalesce(rf.amount, 0)) b
  ),
  agg as (
    select jsonb_build_object(
      'orders', count(*) filter (where status <> 'cancelled'),
      'delivered', count(*) filter (where status = 'delivered'),
      'grossSales', coalesce(sum(gross) filter (where status <> 'cancelled'), 0),
      'customerPaid', coalesce(sum(total) filter (where status <> 'cancelled'), 0),
      'discountVendor', coalesce(sum(discount) filter (where status <> 'cancelled' and funded_by is distinct from 'platform'), 0),
      'discountPlatform', coalesce(sum(discount) filter (where status <> 'cancelled' and funded_by = 'platform'), 0),
      'refundsTotal', coalesce(sum(refunds) filter (where status <> 'cancelled'), 0),
      'refundsCount', coalesce(sum(refund_n) filter (where status <> 'cancelled'), 0),
      'refundsOnCancelled', coalesce(sum(refunds) filter (where status = 'cancelled'), 0),
      'cancelledCount', count(*) filter (where status = 'cancelled'),
      'cancelledValue', coalesce(sum(total) filter (where status = 'cancelled'), 0),
      'deliveryFees', coalesce(sum(fee) filter (where status <> 'cancelled'), 0),
      'commission', coalesce(sum(commission), 0),
      'commissionGst', coalesce(sum(commission_gst), 0),
      'otherCharges', coalesce(sum(other_charges), 0),
      'foodGross', coalesce(sum(food), 0),
      'vendorNet', coalesce(sum(food - deductions) filter (where status <> 'cancelled'), 0)
    ) as summary
    from p
  ),
  days as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'date', d.day, 'orders', d.orders, 'customerPaid', d.paid, 'grossSales', d.gross,
             'discountVendor', d.dv, 'discountPlatform', d.dp, 'refunds', d.refunds, 'deliveryFees', d.fees,
             'commission', d.commission, 'commissionGst', d.gst, 'otherCharges', d.other,
             'cancelledCount', d.cancelled, 'cancelledValue', d.cancelled_value) order by d.day), '[]'::jsonb) as by_day
      from (
        select day,
               count(*) filter (where status <> 'cancelled') as orders,
               coalesce(sum(total) filter (where status <> 'cancelled'), 0) as paid,
               coalesce(sum(gross) filter (where status <> 'cancelled'), 0) as gross,
               coalesce(sum(discount) filter (where status <> 'cancelled' and funded_by is distinct from 'platform'), 0) as dv,
               coalesce(sum(discount) filter (where status <> 'cancelled' and funded_by = 'platform'), 0) as dp,
               coalesce(sum(refunds) filter (where status <> 'cancelled'), 0) as refunds,
               coalesce(sum(fee) filter (where status <> 'cancelled'), 0) as fees,
               coalesce(sum(commission), 0) as commission,
               coalesce(sum(commission_gst), 0) as gst,
               coalesce(sum(other_charges), 0) as other,
               count(*) filter (where status = 'cancelled') as cancelled,
               coalesce(sum(total) filter (where status = 'cancelled'), 0) as cancelled_value
          from p group by day
      ) d
  ),
  vendors as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'restaurantId', v.restaurant_id, 'orders', v.orders, 'delivered', v.delivered, 'cancelled', v.cancelled,
             'customerPaid', v.paid, 'grossSales', v.gross, 'discounts', v.discounts, 'refunds', v.refunds,
             'foodGross', v.food, 'commission', v.commission, 'commissionGst', v.gst, 'otherCharges', v.other,
             'vendorNet', v.net) order by v.restaurant_id), '[]'::jsonb) as by_vendor
      from (
        select restaurant_id,
               count(*) filter (where status <> 'cancelled') as orders,
               count(*) filter (where status = 'delivered') as delivered,
               count(*) filter (where status = 'cancelled') as cancelled,
               coalesce(sum(total) filter (where status <> 'cancelled'), 0) as paid,
               coalesce(sum(gross) filter (where status <> 'cancelled'), 0) as gross,
               coalesce(sum(discount) filter (where status <> 'cancelled'), 0) as discounts,
               coalesce(sum(refunds) filter (where status <> 'cancelled'), 0) as refunds,
               coalesce(sum(food), 0) as food,
               coalesce(sum(commission), 0) as commission,
               coalesce(sum(commission_gst), 0) as gst,
               coalesce(sum(other_charges), 0) as other,
               coalesce(sum(food - deductions) filter (where status <> 'cancelled'), 0) as net
          from p group by restaurant_id
      ) v
  )
  select jsonb_build_object('summary', agg.summary, 'byDay', days.by_day, 'byVendor', vendors.by_vendor)
    from agg, days, vendors;
$$;

-- ------------------------------------------------------------
-- Vendor dues, as of now
-- ------------------------------------------------------------
create or replace function public.ops_vendor_dues_scoped(
  p_zone_ids uuid[],
  p_commission_default double precision,
  p_gst_pct double precision
)
returns jsonb
language sql stable set search_path = public as $$
  with o as (
    select o.id, o.restaurant_id, o.created_at, o.total, o.delivery_fee, o.tax_amount, o.tip, o.discount,
           o.discount_funded_by::text as funded_by, o.payment_method::text as pm, o.payment_status::text as ps,
           coalesce(d.delivered_at, o.created_at) as delivered_at
      from public.orders o
      left join public.deliveries d on d.order_id = o.id
     where o.status::text = 'delivered'
       and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
       and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
       and not exists (select 1 from public.vendor_settlement_orders vso
                         join public.vendor_settlements vs on vs.id = vso.settlement_id
                        where vso.order_id = o.id and vs.status::text = 'paid')
  ),
  rf as (
    select r.order_id, sum(greatest(0, public.ops_js_round(r.amount::double precision))) as amount
      from public.refunds r join o on o.id = r.order_id
     where r.status::text = 'approved'
     group by r.order_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'restaurantId', x.restaurant_id, 'net', x.net, 'orders', x.n, 'oldestDeliveredAt', x.oldest,
           'lastPaidAt', (select max(vs.paid_at) from public.vendor_settlements vs
                           where vs.restaurant_id = x.restaurant_id and vs.status::text = 'paid'),
           'outstandingCorrections', (select coalesce(sum(sc.amount), 0) from public.settlement_corrections sc
                                       where sc.restaurant_id = x.restaurant_id and sc.status::text = 'outstanding'))
           order by x.restaurant_id), '[]'::jsonb)
    from (
      select o.restaurant_id, sum(b.contribution) as net, count(*) as n, min(o.delivered_at) as oldest
        from o
        join public.restaurants s on s.id = o.restaurant_id
        left join rf on rf.order_id = o.id
        cross join lateral public.ops_order_breakdown(
          o.total, o.delivery_fee, o.tax_amount, o.tip, o.discount, o.funded_by,
          least(100, greatest(0, coalesce(s.commission_pct::double precision, p_commission_default))),
          p_gst_pct, coalesce(s.other_charges_per_order, 0), o.pm, o.ps, coalesce(rf.amount, 0)) b
       group by o.restaurant_id
    ) x;
$$;

-- ------------------------------------------------------------
-- Rider dues: every unpaid ledger row (0083), signed, per rider in scope
-- ------------------------------------------------------------
create or replace function public.ops_rider_dues(p_zone_ids uuid[], p_rider uuid)
returns jsonb
language sql stable set search_path = public as $$
  with riders as (
    select p.id from public.profiles p
     where p.role::text = 'driver'
       and (p_rider is null or p.id = p_rider)
       and (p_zone_ids is null or exists (
             select 1 from public.staff_zones sz where sz.user_id = p.id and sz.zone_id = any (p_zone_ids)))
  ),
  rows_ as (
    select e.driver_id, e.amount::numeric as amount, (e.earned_at at time zone 'Asia/Kolkata')::date as day
      from public.rider_earnings e join riders r on r.id = e.driver_id where e.payout_id is null
    union all
    select a.driver_id, a.amount::numeric, (coalesce(t.earned_at, a.awarded_at) at time zone 'Asia/Kolkata')::date
      from public.rider_incentive_awards a join riders r on r.id = a.driver_id
      left join public.rider_earnings t on t.id = a.trigger_earning_id
     where a.payout_id is null
    union all
    select j.driver_id, case when j.kind = 'deduction' then -j.amount else j.amount end, j.effective_on
      from public.rider_adjustments j join riders r on r.id = j.driver_id where j.payout_id is null
  ),
  dues as (
    select driver_id, sum(amount) as unpaid, min(day) as oldest from rows_ group by driver_id
  ),
  last_payout as (
    select distinct on (rp.driver_id) rp.driver_id, rp.amount, rp.paid_on, rp.reference
      from public.rider_payouts rp join riders r on r.id = rp.driver_id
     order by rp.driver_id, rp.paid_on desc, rp.created_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'riderId', d.driver_id, 'unpaid', round(d.unpaid, 2), 'oldestUnpaidOn', to_char(d.oldest, 'YYYY-MM-DD'),
           'lastPayout', case when lp.driver_id is null then null else jsonb_build_object(
             'amount', lp.amount, 'paidOn', to_char(lp.paid_on, 'YYYY-MM-DD'), 'reference', lp.reference) end)
           order by d.oldest, d.driver_id), '[]'::jsonb)
    from dues d left join last_payout lp on lp.driver_id = d.driver_id
   where d.unpaid > 0;
$$;

-- ------------------------------------------------------------
-- Orders ↔ settlements (classification = src/lib/ops/finance-rules.ts)
-- ------------------------------------------------------------
create or replace function public.ops_reconciliation_orders(
  p_zone_ids uuid[],
  p_start timestamptz,
  p_end timestamptz,
  p_commission_default double precision,
  p_gst_pct double precision,
  p_now timestamptz,
  p_state text,
  p_after_at timestamptz,
  p_after_id uuid,
  p_limit integer
)
returns jsonb
language sql stable set search_path = public as $$
  with o as (
    select o.id, o.short_code, o.restaurant_id, o.total, o.delivery_fee, o.tax_amount, o.tip, o.discount,
           o.discount_funded_by::text as funded_by, o.payment_method::text as pm, o.payment_status::text as ps,
           coalesce(d.delivered_at, o.created_at) as delivered_at
      from public.orders o
      left join public.deliveries d on d.order_id = o.id
     where o.status::text = 'delivered'
       and o.created_at >= p_start and o.created_at < p_end
       and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
       and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
  ),
  rf as (
    select r.order_id, sum(greatest(0, public.ops_js_round(r.amount::double precision))) as amount
      from public.refunds r join o on o.id = r.order_id
     where r.status::text = 'approved'
     group by r.order_id
  ),
  c as (
    select sc.order_id,
           coalesce(sum(sc.amount) filter (where sc.status::text = 'outstanding'), 0) as outstanding,
           coalesce(sum(sc.amount) filter (where sc.status::text = 'applied'), 0) as applied,
           (array_agg(sc.id order by sc.created_at) filter (where sc.status::text = 'outstanding'))[1] as correction_id
      from public.settlement_corrections sc join o on o.id = sc.order_id
     group by sc.order_id
  ),
  x as (
    select o.id, o.short_code, o.restaurant_id, o.delivered_at, b.contribution as expected,
           l.contribution as line_contribution, vs.status::text as line_status, vs.id as settlement_id,
           coalesce(c.outstanding, 0) as outstanding, coalesce(c.applied, 0) as applied, c.correction_id,
           case when s.settlement_cycle::text = 'monthly' then 34 else 10 end as due_days
      from o
      join public.restaurants s on s.id = o.restaurant_id
      left join rf on rf.order_id = o.id
      left join c on c.order_id = o.id
      left join public.vendor_settlement_orders l on l.order_id = o.id
      left join public.vendor_settlements vs on vs.id = l.settlement_id and vs.status::text in ('draft', 'paid')
      cross join lateral public.ops_order_breakdown(
        o.total, o.delivery_fee, o.tax_amount, o.tip, o.discount, o.funded_by,
        least(100, greatest(0, coalesce(s.commission_pct::double precision, p_commission_default))),
        p_gst_pct, coalesce(s.other_charges_per_order, 0), o.pm, o.ps, coalesce(rf.amount, 0)) b
  ),
  classified as (
    select x.*,
           case
             when x.settlement_id is null then
               case when p_now - x.delivered_at > make_interval(days => x.due_days) then 'unsettled_due' else 'unsettled_recent' end
             when x.line_status = 'draft' then 'in_draft'
             when x.expected - (x.line_contribution - x.applied) = 0 then 'paid_matched'
             when x.outstanding > 0 and x.expected = (x.line_contribution - x.applied) - x.outstanding then 'correction_outstanding'
             else 'paid_mismatch'
           end as state,
           case
             when x.settlement_id is null then x.expected
             when x.line_status = 'draft' then x.expected - x.line_contribution
             else x.expected - (x.line_contribution - x.applied)
           end as difference
      from x
  ),
  page as (
    select * from classified
     where (p_state is null or state = p_state)
       and (p_after_at is null or (delivered_at, id) < (p_after_at, p_after_id))
     order by delivered_at desc, id desc
     limit greatest(1, least(coalesce(p_limit, 50), 200)) + 1
  )
  select jsonb_build_object(
    'summary', (select coalesce(jsonb_object_agg(s.state, s.n), '{}'::jsonb)
                  from (select state, count(*) as n from classified group by state) s),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'orderId', p.id, 'orderCode', p.short_code, 'restaurantId', p.restaurant_id, 'deliveredAt', p.delivered_at,
                'state', p.state, 'expected', p.expected,
                'settled', case when p.settlement_id is null then null else p.line_contribution - p.applied end,
                'difference', p.difference, 'settlementId', p.settlement_id, 'correctionId', p.correction_id)
                order by p.delivered_at desc, p.id desc), '[]'::jsonb) from page p));
$$;

-- ------------------------------------------------------------
-- Cash: rider × IST day, and manager × day
-- ------------------------------------------------------------
create or replace function public.ops_cash_reconciliation(p_zone_ids uuid[], p_from date, p_to date, p_rider uuid)
returns jsonb
language sql stable set search_path = public as $$
  with collected as (
    select d.driver_id, (d.cod_collected_at at time zone 'Asia/Kolkata')::date as day,
           count(*) as cod_orders, sum(coalesce(d.cod_collected_amount, 0)) as amount
      from public.deliveries d join public.orders o on o.id = d.order_id
     where d.cod_collected_at is not null and d.driver_id is not null
       and (d.cod_collected_at at time zone 'Asia/Kolkata')::date between p_from and p_to
       and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
       and (p_rider is null or d.driver_id = p_rider)
     group by 1, 2
  ),
  deposited as (
    select h.from_user as driver_id, h.handover_date as day, sum(h.amount) as amount
      from public.cod_handovers h
     where h.leg::text = 'rider_to_manager' and h.from_user is not null
       and h.handover_date between p_from and p_to
       and (p_zone_ids is null or h.zone_id = any (p_zone_ids))
       and (p_rider is null or h.from_user = p_rider)
     group by 1, 2
  ),
  disputed as (
    select driver_id, day from public.cash_disputes where status = 'open' and day between p_from and p_to
    union
    select driver_id, (created_at at time zone 'Asia/Kolkata')::date from public.cash_deposits
     where status = 'disputed' and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  ),
  deposit_ids as (
    select driver_id, (created_at at time zone 'Asia/Kolkata')::date as day, array_agg(id order by created_at) as ids
      from public.cash_deposits
     where (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
     group by 1, 2
  ),
  keys as (
    select driver_id, day from collected union select driver_id, day from deposited
  ),
  riders as (
    select k.driver_id, k.day, coalesce(c.cod_orders, 0) as cod_orders, coalesce(c.amount, 0) as collected,
           coalesce(dp.amount, 0) as deposited,
           exists (select 1 from disputed x where x.driver_id = k.driver_id and x.day = k.day) as disputed,
           coalesce(di.ids, '{}'::uuid[]) as deposit_ids
      from keys k
      left join collected c on c.driver_id = k.driver_id and c.day = k.day
      left join deposited dp on dp.driver_id = k.driver_id and dp.day = k.day
      left join deposit_ids di on di.driver_id = k.driver_id and di.day = k.day
    -- keys are already zone-scoped: collections by the order's zone,
    -- deposits by the handover's zone.
  ),
  managers as (
    select m.manager_id, m.day, sum(m.received) as received, sum(m.handed_on) as handed_on
      from (
        select h.to_user as manager_id, h.handover_date as day, h.amount as received, 0 as handed_on
          from public.cod_handovers h
         where h.leg::text = 'rider_to_manager' and h.to_user is not null
           and h.handover_date between p_from and p_to and (p_zone_ids is null or h.zone_id = any (p_zone_ids))
        union all
        select h.from_user, h.handover_date, 0, h.amount
          from public.cod_handovers h
         where h.leg::text = 'manager_to_owner' and h.from_user is not null
           and h.handover_date between p_from and p_to and (p_zone_ids is null or h.zone_id = any (p_zone_ids))
      ) m
     where p_rider is null
     group by 1, 2
  )
  select jsonb_build_object(
    'riders', (select coalesce(jsonb_agg(jsonb_build_object(
                 'day', to_char(r.day, 'YYYY-MM-DD'), 'riderId', r.driver_id, 'codOrders', r.cod_orders,
                 'collected', r.collected, 'deposited', r.deposited, 'disputed', r.disputed, 'depositIds', to_jsonb(r.deposit_ids))
                 order by r.day desc, r.driver_id), '[]'::jsonb) from riders r),
    'managers', (select coalesce(jsonb_agg(jsonb_build_object(
                   'day', to_char(m.day, 'YYYY-MM-DD'), 'managerId', m.manager_id, 'received', m.received, 'handedOn', m.handed_on)
                   order by m.day desc, m.manager_id), '[]'::jsonb) from managers m));
$$;

-- ------------------------------------------------------------
-- Riders in scope (staff_zones), and their ledger and payouts
-- ------------------------------------------------------------
-- Signed ledger rows dated in [p_from, p_to] (IST), and everything unpaid.
create or replace function public.ops_rider_ledger_totals(p_zone_ids uuid[], p_from date, p_to date)
returns jsonb
language sql stable set search_path = public as $$
  with riders as (
    select p.id from public.profiles p
     where p.role::text = 'driver'
       and (p_zone_ids is null or exists (
             select 1 from public.staff_zones sz where sz.user_id = p.id and sz.zone_id = any (p_zone_ids)))
  ),
  rows_ as (
    select e.amount::numeric as amount, (e.earned_at at time zone 'Asia/Kolkata')::date as day, e.payout_id
      from public.rider_earnings e join riders r on r.id = e.driver_id
    union all
    select a.amount::numeric, (coalesce(t.earned_at, a.awarded_at) at time zone 'Asia/Kolkata')::date, a.payout_id
      from public.rider_incentive_awards a join riders r on r.id = a.driver_id
      left join public.rider_earnings t on t.id = a.trigger_earning_id
    union all
    select case when j.kind = 'deduction' then -j.amount else j.amount end, j.effective_on, j.payout_id
      from public.rider_adjustments j join riders r on r.id = j.driver_id
  )
  select jsonb_build_object(
    'earnedInRange', round(coalesce(sum(amount) filter (where day between p_from and p_to), 0), 2),
    'unpaid', round(coalesce(sum(amount) filter (where payout_id is null), 0), 2))
    from rows_;
$$;

-- Payouts made (paid_on in [p_from, p_to]) to riders in scope, newest first,
-- keyset on (paid_on, created_at, id); totals over every row of the filter.
create or replace function public.ops_rider_payouts_scoped(
  p_zone_ids uuid[], p_from date, p_to date, p_rider uuid,
  p_before_on date, p_before_at timestamptz, p_before_id uuid, p_limit integer
)
returns jsonb
language sql stable set search_path = public as $$
  with riders as (
    select p.id from public.profiles p
     where p.role::text = 'driver'
       and (p_rider is null or p.id = p_rider)
       and (p_zone_ids is null or exists (
             select 1 from public.staff_zones sz where sz.user_id = p.id and sz.zone_id = any (p_zone_ids)))
  ),
  f as (
    select rp.* from public.rider_payouts rp join riders r on r.id = rp.driver_id
     where rp.paid_on between p_from and p_to
  ),
  page as (
    select * from f
     where p_before_on is null or (paid_on, created_at, id) < (p_before_on, p_before_at, p_before_id)
     order by paid_on desc, created_at desc, id desc
     limit greatest(1, least(coalesce(p_limit, 50), 200)) + 1
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object('amount', round(coalesce(sum(amount), 0), 2), 'count', count(*)) from f),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', p.id, 'riderId', p.driver_id, 'periodEnd', to_char(p.period_end, 'YYYY-MM-DD'), 'amount', p.amount,
                'method', p.method, 'reference', p.reference, 'paidOn', to_char(p.paid_on, 'YYYY-MM-DD'), 'note', p.note,
                'createdBy', p.created_by, 'createdAt', p.created_at, 'requestId', p.request_id,
                'items', (select count(*) from public.rider_earnings e where e.payout_id = p.id)
                       + (select count(*) from public.rider_incentive_awards a where a.payout_id = p.id)
                       + (select count(*) from public.rider_adjustments j where j.payout_id = p.id))
                order by p.paid_on desc, p.created_at desc, p.id desc), '[]'::jsonb) from page p));
$$;

-- Settlement headers' totals for a list filter (status `pending_approval` =
-- drafts with a pending request). The range applies to paid_at when the
-- filter is `paid`, else to created_at — the list's own rule.
create or replace function public.ops_settlement_totals(
  p_zone_ids uuid[], p_status text, p_restaurant uuid, p_start timestamptz, p_end timestamptz
)
returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('netPayable', coalesce(sum(s.net_payable), 0), 'count', count(*))
    from public.vendor_settlements s
    join public.restaurants r on r.id = s.restaurant_id
   where (p_zone_ids is null or r.zone_id = any (p_zone_ids))
     and (p_restaurant is null or s.restaurant_id = p_restaurant)
     and (
       -- No status asked for: every settlement that stands (void ones left out).
       (p_status is null and s.status::text <> 'void')
       or (p_status = 'pending_approval' and s.status::text = 'draft' and exists (
             select 1 from public.payment_requests pr where pr.settlement_id = s.id and pr.status = 'pending_approval'))
       or (p_status <> 'pending_approval' and s.status::text = p_status))
     and (p_start is null or (case when p_status = 'paid' then s.paid_at else s.created_at end) >= p_start)
     and (p_end is null or (case when p_status = 'paid' then s.paid_at else s.created_at end) < p_end);
$$;

-- Online payments against their orders (§7 reconciliation): every online,
-- paid-or-refunded, non-cancelled order in range with the payment(s) the
-- gateway captured — matched, online_mismatch (amounts differ) or
-- missing_payment (no captured row). Same rule as classifyOnlinePayment
-- (finance-rules.ts). Summary over every match; one keyset page (+1 probe).
create or replace function public.ops_reconciliation_online(
  p_zone_ids uuid[], p_start timestamptz, p_end timestamptz, p_state text,
  p_after_at timestamptz, p_after_id uuid, p_limit integer
)
returns jsonb
language sql stable set search_path = public as $$
  with o as (
    select o.id, o.short_code, o.total, o.created_at,
           (select sum(p.amount_paise) from public.payments p
             where p.order_id = o.id and p.status in ('paid', 'refunded')) as paise,
           (select p.provider_payment_id from public.payments p
             where p.order_id = o.id and p.status in ('paid', 'refunded')
             order by p.created_at desc limit 1) as payment_id
      from public.orders o
     where o.payment_method = 'online' and o.payment_status in ('paid', 'refunded') and o.status <> 'cancelled'
       and o.created_at >= p_start and o.created_at < p_end
       and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
  ),
  c as (
    select o.*, case when paise is null then 'missing_payment'
                     when round(paise) = round(total * 100) then 'matched'
                     else 'online_mismatch' end as state
      from o
  ),
  page as (
    select * from c
     where (p_state is null or state = p_state)
       and (p_after_at is null or (created_at, id) < (p_after_at, p_after_id))
     order by created_at desc, id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 1000) + 1
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'matched', (select count(*) from c where state = 'matched'),
      'online_mismatch', (select count(*) from c where state = 'online_mismatch'),
      'missing_payment', (select count(*) from c where state = 'missing_payment')),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'orderId', id, 'orderCode', coalesce(short_code, upper(left(id::text, 8))), 'orderTotal', total,
        'paidAmount', case when paise is null then null else paise / 100.0 end, 'paymentId', payment_id,
        'state', state, 'at', created_at) order by created_at desc, id desc) from page), '[]'::jsonb));
$$;
revoke execute on function public.ops_reconciliation_online(uuid[], timestamptz, timestamptz, text, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.ops_reconciliation_online(uuid[], timestamptz, timestamptz, text, timestamptz, uuid, integer) to service_role;

revoke execute on function public.ops_rider_ledger_totals(uuid[], date, date) from public, anon, authenticated;
revoke execute on function public.ops_rider_payouts_scoped(uuid[], date, date, uuid, date, timestamptz, uuid, integer) from public, anon, authenticated;
revoke execute on function public.ops_settlement_totals(uuid[], text, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.ops_rider_ledger_totals(uuid[], date, date) to service_role;
grant execute on function public.ops_rider_payouts_scoped(uuid[], date, date, uuid, date, timestamptz, uuid, integer) to service_role;
grant execute on function public.ops_settlement_totals(uuid[], text, uuid, timestamptz, timestamptz) to service_role;

revoke execute on function public.ops_finance_rollup(uuid[], timestamptz, timestamptz, uuid, text, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.ops_vendor_dues_scoped(uuid[], double precision, double precision) from public, anon, authenticated;
revoke execute on function public.ops_rider_dues(uuid[], uuid) from public, anon, authenticated;
revoke execute on function public.ops_reconciliation_orders(uuid[], timestamptz, timestamptz, double precision, double precision, timestamptz, text, timestamptz, uuid, integer) from public, anon, authenticated;
revoke execute on function public.ops_cash_reconciliation(uuid[], date, date, uuid) from public, anon, authenticated;
grant execute on function public.ops_finance_rollup(uuid[], timestamptz, timestamptz, uuid, text, double precision, double precision) to service_role;
grant execute on function public.ops_vendor_dues_scoped(uuid[], double precision, double precision) to service_role;
grant execute on function public.ops_rider_dues(uuid[], uuid) to service_role;
grant execute on function public.ops_reconciliation_orders(uuid[], timestamptz, timestamptz, double precision, double precision, timestamptz, text, timestamptz, uuid, integer) to service_role;
grant execute on function public.ops_cash_reconciliation(uuid[], date, date, uuid) to service_role;

commit;
