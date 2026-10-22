-- ============================================================
-- 0158 — Report aggregates: the row-heavy reports, paged and totalled in SQL
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database from this branch.
-- Order: after 0157.
--
-- Phase 6 (§13). Reports whose rows are orders, refunds or tickets can run
-- to tens of thousands of rows a year. Each function here returns ONE page
-- (offset/limit; exports are capped at 10 000 rows by the server) together
-- with totals over EVERY row the filter matches — so a report's totals never
-- depend on which page is on screen, and nothing is pulled into Node to be
-- summed. Day-based and per-shop money reports keep using 0157's
-- ops_finance_rollup, so they agree with the dashboard and Finance to the
-- rupee.
--
--   ops_report_orders            — orders (and the cancellation report:
--                                  p_cancelled_only), with totals.
--   ops_report_refunds_adjustments — every refund once (on its order's IST
--                                  day, as net sales attribute it) and every
--                                  settlement correction, apart.
--   ops_report_vendor_ops        — per shop: order counts, cancellation and
--                                  rejection, accept and prep minutes, rating.
--   ops_report_rider_performance — per rider: delivered, failed, offers and
--                                  acceptance, delivery minutes, online hours,
--                                  rating, COD collected.
--   ops_report_support_tickets   — tickets with first-response and resolution
--                                  minutes; highlights over every row.
--   ops_report_marketing         — banners (impressions, clicks, orders from
--                                  banner_events in range) and promo codes
--                                  (redemptions, discount by funder,
--                                  attributed orders and sales).
--   ops_report_settlements       — vendor settlements, one page plus totals
--                                  over every match and per status. Void
--                                  ones are left out unless asked for by
--                                  name; pending_approval = a draft with an
--                                  open payment request. One jsonb value, so
--                                  an export is never cut at PostgREST's
--                                  row cap.
--
-- Unpaid online checkouts are not orders (ops_counts_as_order, 0144). All
-- service role only; `p_zone_ids` null = every zone, empty = nothing.
--
-- Rollback:
--   drop function if exists public.ops_report_orders(uuid[], timestamptz, timestamptz, uuid, uuid, text, text, boolean, text, integer, integer);
--   drop function if exists public.ops_report_refunds_adjustments(uuid[], timestamptz, timestamptz, uuid, text, integer, integer);
--   drop function if exists public.ops_report_vendor_ops(uuid[], timestamptz, timestamptz, uuid);
--   drop function if exists public.ops_report_rider_performance(uuid[], timestamptz, timestamptz, uuid);
--   drop function if exists public.ops_report_support_tickets(uuid[], timestamptz, timestamptz, text, integer, integer);
--   drop function if exists public.ops_report_marketing(uuid[], text[], timestamptz, timestamptz, uuid);
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Orders / cancellations
-- ------------------------------------------------------------
create or replace function public.ops_report_orders(
  p_zone_ids uuid[], p_start timestamptz, p_end timestamptz, p_restaurant uuid, p_rider uuid,
  p_status text, p_payment text, p_cancelled_only boolean, p_cancelled_by text, p_offset integer, p_limit integer
)
returns jsonb
language sql stable set search_path = public as $$
  with o as (
    select o.id, o.short_code, o.created_at, o.cancelled_at, o.restaurant_id, o.status::text as status,
           o.payment_method::text as pm, o.payment_status::text as ps,
           public.ops_js_round(o.total::double precision) as total,
           greatest(0, public.ops_js_round(o.discount::double precision)) as discount,
           public.ops_js_round(o.delivery_fee::double precision) as fee,
           o.cancelled_by::text as cancelled_by, nullif(btrim(o.cancellation_reason), '') as reason,
           d.driver_id
      from public.orders o
      left join public.deliveries d on d.order_id = o.id
     where o.created_at >= p_start and o.created_at < p_end
       and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
       and (p_restaurant is null or o.restaurant_id = p_restaurant)
       and (p_rider is null or d.driver_id = p_rider)
       and (p_payment is null or o.payment_method::text = p_payment)
       and (p_status is null or o.status::text = p_status)
       and (not coalesce(p_cancelled_only, false) or o.status::text = 'cancelled')
       and (p_cancelled_by is null or o.cancelled_by::text = p_cancelled_by)
       and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
  ),
  rf as (
    select r.order_id, sum(greatest(0, public.ops_js_round(r.amount::double precision))) as amount
      from public.refunds r join o on o.id = r.order_id
     where r.status::text = 'approved'
     group by r.order_id
  ),
  page as (
    select o.* from o order by o.created_at desc, o.id desc
     offset greatest(0, coalesce(p_offset, 0)) limit greatest(0, least(coalesce(p_limit, 50), 10001))
  )
  select jsonb_build_object(
    'totalRows', (select count(*) from o),
    'totals', (select jsonb_build_object(
                 'orders', count(*),
                 'total', coalesce(sum(o.total), 0),
                 'discount', coalesce(sum(o.discount), 0),
                 'deliveryFee', coalesce(sum(o.fee), 0),
                 'items', coalesce(sum((select coalesce(sum(oi.qty), 0) from public.order_items oi where oi.order_id = o.id)), 0),
                 'refunded', coalesce(sum(rf.amount), 0))
                 from o left join rf on rf.order_id = o.id),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'code', p.short_code, 'placedAt', p.created_at, 'cancelledAt', p.cancelled_at,
               'restaurantId', p.restaurant_id, 'vendor', s.name, 'riderId', p.driver_id, 'rider', pr.full_name,
               'status', p.status, 'paymentMethod', p.pm, 'paymentStatus', p.ps,
               'items', (select coalesce(sum(oi.qty), 0) from public.order_items oi where oi.order_id = p.id),
               'total', p.total, 'discount', p.discount, 'deliveryFee', p.fee,
               'cancelledBy', p.cancelled_by, 'cancellationReason', p.reason, 'refunded', coalesce(rf.amount, 0))
               order by p.created_at desc, p.id desc), '[]'::jsonb)
               from page p
               left join public.restaurants s on s.id = p.restaurant_id
               left join public.profiles pr on pr.id = p.driver_id
               left join rf on rf.order_id = p.id));
$$;

-- ------------------------------------------------------------
-- Refunds (once each, on the order's day) and corrections (apart)
-- ------------------------------------------------------------
create or replace function public.ops_report_refunds_adjustments(
  p_zone_ids uuid[], p_start timestamptz, p_end timestamptz, p_restaurant uuid, p_status text, p_offset integer, p_limit integer
)
returns jsonb
language sql stable set search_path = public as $$
  with r as (
    select f.id, o.created_at as at, 'refund'::text as type, o.short_code as order_code, o.restaurant_id,
           greatest(0, public.ops_js_round(f.amount::double precision)) as amount, f.status::text as status,
           f.origin, f.reason, f.decided_by,
           case
             when f.status::text <> 'approved' then 'none'
             when exists (select 1 from public.settlement_corrections sc where sc.refund_id = f.id) then 'correction_created'
             when exists (select 1 from public.vendor_settlement_orders l join public.vendor_settlements vs on vs.id = l.settlement_id
                           where l.order_id = o.id and vs.status::text = 'draft') then 'draft_flagged'
             else 'none' end as effect
      from public.refunds f
      join public.orders o on o.id = f.order_id
     where o.created_at >= p_start and o.created_at < p_end
       and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
       and (p_restaurant is null or o.restaurant_id = p_restaurant)
       and (p_status is null or f.status::text = p_status)
       and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
  ),
  c as (
    select sc.id, sc.created_at as at, 'correction'::text as type, o.short_code as order_code, sc.restaurant_id,
           sc.amount, sc.status::text as status, null::text as origin, sc.reason, sc.created_by as decided_by,
           'none'::text as effect
      from public.settlement_corrections sc
      join public.restaurants s on s.id = sc.restaurant_id
      join public.orders o on o.id = sc.order_id
     where p_status is null
       and sc.created_at >= p_start and sc.created_at < p_end
       and (p_zone_ids is null or s.zone_id = any (p_zone_ids))
       and (p_restaurant is null or sc.restaurant_id = p_restaurant)
  ),
  u as (select * from r union all select * from c),
  page as (
    select * from u order by at desc, id desc
     offset greatest(0, coalesce(p_offset, 0)) limit greatest(0, least(coalesce(p_limit, 50), 10001))
  )
  select jsonb_build_object(
    'totalRows', (select count(*) from u),
    'totals', jsonb_build_object(
      'refundsApproved', (select coalesce(sum(amount), 0) from r where status = 'approved'),
      'refundsApprovedCount', (select count(*) from r where status = 'approved'),
      'refundsPending', (select coalesce(sum(amount), 0) from r where status = 'pending'),
      'refundsDenied', (select coalesce(sum(amount), 0) from r where status = 'denied'),
      'corrections', (select coalesce(sum(amount), 0) from c),
      'correctionsCount', (select count(*) from c)),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'at', p.at, 'type', p.type, 'orderCode', p.order_code, 'restaurantId', p.restaurant_id,
               'vendor', s.name, 'amount', p.amount, 'status', p.status, 'origin', p.origin, 'reason', p.reason,
               'settlementEffect', p.effect, 'decidedBy', pr.full_name)
               order by p.at desc, p.id desc), '[]'::jsonb)
               from page p
               left join public.restaurants s on s.id = p.restaurant_id
               left join public.profiles pr on pr.id = p.decided_by));
$$;

-- ------------------------------------------------------------
-- Per shop: counts and timings (money comes from ops_finance_rollup)
-- ------------------------------------------------------------
create or replace function public.ops_report_vendor_ops(p_zone_ids uuid[], p_start timestamptz, p_end timestamptz, p_restaurant uuid)
returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'restaurantId', x.restaurant_id, 'vendor', x.name, 'zoneId', x.zone_id,
           'orders', x.orders, 'delivered', x.delivered, 'cancelled', x.cancelled, 'rejected', x.rejected,
           'acceptMinutesSum', x.accept_sum, 'acceptCount', x.accept_n, 'prepMinutesSum', x.prep_sum, 'prepCount', x.prep_n,
           'rating', x.rating, 'ratingCount', x.rating_count) order by x.name, x.restaurant_id), '[]'::jsonb)
    from (
      select o.restaurant_id, s.name, s.zone_id, s.rating, s.rating_count,
             count(*) as orders,
             count(*) filter (where o.status::text = 'delivered') as delivered,
             count(*) filter (where o.status::text = 'cancelled') as cancelled,
             count(*) filter (where o.status::text = 'cancelled' and o.cancelled_by::text = 'vendor') as rejected,
             coalesce(sum(extract(epoch from (o.accepted_at - o.created_at)) / 60) filter (where o.accepted_at is not null), 0) as accept_sum,
             count(*) filter (where o.accepted_at is not null) as accept_n,
             coalesce(sum(extract(epoch from (o.ready_at - o.accepted_at)) / 60) filter (where o.ready_at is not null and o.accepted_at is not null), 0) as prep_sum,
             count(*) filter (where o.ready_at is not null and o.accepted_at is not null) as prep_n
        from public.orders o
        join public.restaurants s on s.id = o.restaurant_id
       where o.created_at >= p_start and o.created_at < p_end
         and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
         and (p_restaurant is null or o.restaurant_id = p_restaurant)
         and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
       group by o.restaurant_id, s.name, s.zone_id, s.rating, s.rating_count
    ) x;
$$;

-- ------------------------------------------------------------
-- Per rider
-- ------------------------------------------------------------
create or replace function public.ops_report_rider_performance(p_zone_ids uuid[], p_start timestamptz, p_end timestamptz, p_rider uuid)
returns jsonb
language sql stable set search_path = public as $$
  with riders as (
    select p.id, p.full_name from public.profiles p
     where p.role::text = 'driver'
       and (p_rider is null or p.id = p_rider)
       and (p_zone_ids is null or exists (
             select 1 from public.staff_zones sz where sz.user_id = p.id and sz.zone_id = any (p_zone_ids)))
  ),
  dl as (
    select d.driver_id, count(*) as delivered,
           coalesce(sum(extract(epoch from (d.delivered_at - d.assigned_at)) / 60) filter (where d.assigned_at is not null), 0) as minutes_sum,
           count(*) filter (where d.assigned_at is not null) as minutes_n,
           coalesce(sum(coalesce(d.cod_collected_amount, 0)), 0) as cod
      from public.deliveries d join riders r on r.id = d.driver_id
     where d.status::text = 'delivered' and d.delivered_at >= p_start and d.delivered_at < p_end
     group by d.driver_id
  ),
  ev as (
    select e.driver_id,
           count(*) filter (where e.kind = 'offered') as offers,
           count(*) filter (where e.kind = 'accepted') as accepted,
           count(*) filter (where e.kind = 'failed') as failed
      from public.delivery_events e join riders r on r.id = e.driver_id
     where e.created_at >= p_start and e.created_at < p_end
     group by e.driver_id
  ),
  sh as (
    select s.driver_id,
           sum(extract(epoch from (least(coalesce(s.ended_at, now()), p_end) - greatest(s.started_at, p_start))) / 3600) as hours
      from public.rider_shifts s join riders r on r.id = s.driver_id
     where s.started_at < p_end and coalesce(s.ended_at, now()) > p_start
     group by s.driver_id
  ),
  rt as (
    select rr.driver_id, avg(rr.rating) as avg_rating, count(*) as n
      from public.rider_ratings rr join riders r on r.id = rr.driver_id
     where rr.created_at >= p_start and rr.created_at < p_end
     group by rr.driver_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'riderId', r.id, 'rider', r.full_name, 'code', rp.rider_code,
           'delivered', coalesce(dl.delivered, 0), 'failed', coalesce(ev.failed, 0),
           'offers', coalesce(ev.offers, 0), 'accepted', coalesce(ev.accepted, 0),
           'deliverMinutesSum', coalesce(dl.minutes_sum, 0), 'deliverCount', coalesce(dl.minutes_n, 0),
           'onlineHours', round(coalesce(sh.hours, 0)::numeric, 2),
           'rating', case when rt.n > 0 then round(rt.avg_rating::numeric, 1) end, 'ratingCount', coalesce(rt.n, 0),
           'codCollected', coalesce(dl.cod, 0)) order by r.full_name, r.id), '[]'::jsonb)
    from riders r
    left join public.rider_profiles rp on rp.driver_id = r.id
    left join dl on dl.driver_id = r.id
    left join ev on ev.driver_id = r.id
    left join sh on sh.driver_id = r.id
    left join rt on rt.driver_id = r.id;
$$;

-- ------------------------------------------------------------
-- Support tickets
-- ------------------------------------------------------------
create or replace function public.ops_report_support_tickets(
  p_zone_ids uuid[], p_start timestamptz, p_end timestamptz, p_status text, p_offset integer, p_limit integer
)
returns jsonb
language sql stable set search_path = public as $$
  with t as (
    select t.id, t.number, t.created_at, t.requester_role, t.category, t.priority, t.status, t.escalation_level,
           t.assigned_to, t.order_id, t.restaurant_id,
           case when t.first_response_at is not null then extract(epoch from (t.first_response_at - t.created_at)) / 60 end as first_min,
           case when t.resolved_at is not null then extract(epoch from (t.resolved_at - t.created_at)) / 60 end as resolve_min
      from public.support_tickets t
     where t.created_at >= p_start and t.created_at < p_end
       and (p_zone_ids is null or t.zone_id = any (p_zone_ids))
       and (p_status is null or t.status = p_status)
  ),
  page as (
    select * from t order by created_at desc, id desc
     offset greatest(0, coalesce(p_offset, 0)) limit greatest(0, least(coalesce(p_limit, 50), 10001))
  )
  select jsonb_build_object(
    'totalRows', (select count(*) from t),
    'totals', jsonb_build_object(
      'count', (select count(*) from t),
      'firstResponseMinutesSum', (select coalesce(sum(first_min), 0) from t), 'firstResponseCount', (select count(first_min) from t),
      'resolutionMinutesSum', (select coalesce(sum(resolve_min), 0) from t), 'resolutionCount', (select count(resolve_min) from t),
      'topCategories', (select coalesce(jsonb_agg(jsonb_build_object('category', c.category, 'count', c.n) order by c.n desc, c.category), '[]'::jsonb)
                          from (select category, count(*) as n from t group by category order by count(*) desc, category limit 3) c)),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'number', p.number, 'createdAt', p.created_at, 'requesterRole', p.requester_role,
               'category', p.category, 'priority', p.priority, 'status', p.status, 'escalationLevel', p.escalation_level,
               'assignedTo', pr.full_name, 'firstResponseMinutes', round(p.first_min::numeric, 0),
               'resolutionMinutes', round(p.resolve_min::numeric, 0), 'orderCode', o.short_code, 'vendor', s.name)
               order by p.created_at desc, p.id desc), '[]'::jsonb)
               from page p
               left join public.profiles pr on pr.id = p.assigned_to
               left join public.orders o on o.id = p.order_id
               left join public.restaurants s on s.id = p.restaurant_id));
$$;

-- ------------------------------------------------------------
-- Marketing: banners and promo codes
-- ------------------------------------------------------------
create or replace function public.ops_report_marketing(
  p_zone_ids uuid[], p_zone_names text[], p_start timestamptz, p_end timestamptz, p_restaurant uuid
)
returns jsonb
language sql stable set search_path = public as $$
  with b as (
    select bn.id, bn.name, bn.kind, bn.status, bn.starts_at, bn.ends_at, bn.sponsor_name
      from public.banners bn
     where p_restaurant is null
       and coalesce(bn.starts_at, '-infinity'::timestamptz) < p_end
       and coalesce(bn.ends_at, 'infinity'::timestamptz) >= p_start
       and (p_zone_ids is null or coalesce(array_length(bn.target_zones, 1), 0) = 0
            or exists (select 1 from unnest(bn.target_zones) tz where lower(btrim(tz)) = any (p_zone_names)))
  ),
  be as (
    select e.banner_id,
           count(*) filter (where e.kind = 'impression') as impressions,
           count(*) filter (where e.kind = 'click') as clicks,
           count(*) filter (where e.kind = 'order') as orders
      from public.banner_events e join b on b.id = e.banner_id
     where e.created_at >= p_start and e.created_at < p_end
     group by e.banner_id
  ),
  red as (
    select cr.code, count(*) as redemptions, coalesce(sum(cr.discount), 0) as discount,
           count(*) filter (where o.status::text <> 'cancelled') as orders,
           coalesce(sum(public.ops_js_round(o.total::double precision)) filter (where o.status::text <> 'cancelled'), 0) as sales
      from public.coupon_redemptions cr
      join public.orders o on o.id = cr.order_id
     where o.created_at >= p_start and o.created_at < p_end
       and (p_zone_ids is null or o.zone_id = any (p_zone_ids))
       and (p_restaurant is null or o.restaurant_id = p_restaurant)
       and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
     group by cr.code
  ),
  cp as (
    select c.code, c.label, c.restaurant_id, c.funded_by, c.starts_at, c.expires_at, c.active
      from public.coupons c
      left join public.restaurants s on s.id = c.restaurant_id
     where (p_restaurant is null or c.restaurant_id = p_restaurant)
       and (c.restaurant_id is null or p_zone_ids is null or s.zone_id = any (p_zone_ids))
       and (exists (select 1 from red where red.code = c.code)
            or (coalesce(c.starts_at, '-infinity'::timestamptz) < p_end and coalesce(c.expires_at, 'infinity'::timestamptz) >= p_start and c.active))
  )
  select jsonb_build_object(
    'banners', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', b.id, 'campaign', b.name, 'type', case when b.kind = 'sponsored' then 'sponsored_banner' else 'banner' end,
                  'vendor', b.sponsor_name, 'start', b.starts_at, 'end', b.ends_at, 'status', b.status,
                  'fundedBy', case when b.kind = 'sponsored' then 'vendor' else 'deligro' end,
                  'impressions', coalesce(be.impressions, 0), 'clicks', coalesce(be.clicks, 0), 'attributedOrders', coalesce(be.orders, 0))
                  order by b.name, b.id), '[]'::jsonb)
                  from b left join be on be.banner_id = b.id),
    'codes', (select coalesce(jsonb_agg(jsonb_build_object(
                'code', cp.code, 'campaign', coalesce(nullif(btrim(cp.label), ''), cp.code), 'vendor', s.name, 'restaurantId', cp.restaurant_id,
                'start', cp.starts_at, 'end', cp.expires_at,
                'status', case when not cp.active then 'inactive' when cp.expires_at is not null and cp.expires_at < now() then 'expired' else 'active' end,
                'fundedBy', case when cp.funded_by = 'vendor' then 'vendor' else 'deligro' end,
                'redemptions', coalesce(red.redemptions, 0), 'discountGiven', coalesce(red.discount, 0),
                'attributedOrders', coalesce(red.orders, 0), 'attributedSales', coalesce(red.sales, 0))
                order by cp.code), '[]'::jsonb)
                from cp left join red on red.code = cp.code left join public.restaurants s on s.id = cp.restaurant_id));
$$;

revoke execute on function public.ops_report_orders(uuid[], timestamptz, timestamptz, uuid, uuid, text, text, boolean, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.ops_report_refunds_adjustments(uuid[], timestamptz, timestamptz, uuid, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.ops_report_vendor_ops(uuid[], timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.ops_report_rider_performance(uuid[], timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.ops_report_support_tickets(uuid[], timestamptz, timestamptz, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.ops_report_marketing(uuid[], text[], timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.ops_report_orders(uuid[], timestamptz, timestamptz, uuid, uuid, text, text, boolean, text, integer, integer) to service_role;
grant execute on function public.ops_report_refunds_adjustments(uuid[], timestamptz, timestamptz, uuid, text, integer, integer) to service_role;
grant execute on function public.ops_report_vendor_ops(uuid[], timestamptz, timestamptz, uuid) to service_role;
grant execute on function public.ops_report_rider_performance(uuid[], timestamptz, timestamptz, uuid) to service_role;
grant execute on function public.ops_report_support_tickets(uuid[], timestamptz, timestamptz, text, integer, integer) to service_role;
grant execute on function public.ops_report_marketing(uuid[], text[], timestamptz, timestamptz, uuid) to service_role;

-- ------------------------------------------------------------
-- Vendor settlements report
-- ------------------------------------------------------------
create or replace function public.ops_report_settlements(
  p_zone_ids uuid[], p_status text, p_restaurant uuid, p_start timestamptz, p_end timestamptz,
  p_offset integer, p_limit integer
)
returns jsonb
language sql stable set search_path = public as $$
  with base as (
    select s.id, s.restaurant_id, r.name as vendor, coalesce(s.kind::text, 'batch') as kind, s.status::text as status,
           s.period_start, s.period_end, s.food_gross, s.commission, s.refunds_recovered, s.net_payable,
           s.payment_ref, s.paid_at, s.paid_by, s.created_at,
           exists (select 1 from public.payment_requests pr
                    where pr.settlement_id = s.id and pr.status = 'pending_approval') as pending_approval,
           case when p_status = 'paid' then s.paid_at else s.created_at end as at
      from public.vendor_settlements s
      join public.restaurants r on r.id = s.restaurant_id
     where (p_zone_ids is null or r.zone_id = any (p_zone_ids))
       and (p_restaurant is null or s.restaurant_id = p_restaurant)
  ),
  in_range as (
    select * from base
     where (p_start is null or at >= p_start) and (p_end is null or at < p_end)
  ),
  matched as (
    select * from in_range
     where case
             when p_status is null then status <> 'void'
             when p_status = 'pending_approval' then status = 'draft' and pending_approval
             else status = p_status
           end
  ),
  page as (
    select m.*,
           (select count(*) from public.vendor_settlement_orders l where l.settlement_id = m.id) as orders,
           (select p.full_name from public.profiles p where p.id = m.paid_by) as paid_by_name
      from matched m
     order by m.at desc, m.id desc
     offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 50), 1), 10000)
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'restaurantId', restaurant_id, 'vendor', coalesce(nullif(trim(vendor), ''), 'Shop'), 'kind', kind, 'status', status,
        'pendingApproval', pending_approval, 'periodStart', period_start, 'periodEnd', period_end,
        'orders', orders, 'foodGross', food_gross, 'commission', commission, 'refundsRecovered', refunds_recovered,
        'netPayable', net_payable, 'paymentRef', payment_ref, 'paidAt', paid_at,
        'paidBy', case when paid_by is null then null else coalesce(nullif(trim(paid_by_name), ''), 'Staff') end)
        order by at desc, id desc) from page), '[]'::jsonb),
    'totalRows', (select count(*) from matched),
    'totals', jsonb_build_object('netPayable', coalesce((select sum(net_payable) from matched), 0),
                                 'count', (select count(*) from matched),
                                 'foodGross', coalesce((select sum(food_gross) from matched), 0),
                                 'commission', coalesce((select sum(commission) from matched), 0),
                                 'refundsRecovered', coalesce((select sum(refunds_recovered) from matched), 0)),
    'byStatus', coalesce((select jsonb_object_agg(k, v) from (
        select case when status = 'draft' and pending_approval then 'pending_approval' else status end as k,
               jsonb_build_object('count', count(*), 'netPayable', coalesce(sum(net_payable), 0)) as v
          from in_range group by 1) g), '{}'::jsonb)
      || case when exists (select 1 from in_range where status = 'draft' and pending_approval)
              then jsonb_build_object('draft', jsonb_build_object(
                     'count', (select count(*) from in_range where status = 'draft'),
                     'netPayable', coalesce((select sum(net_payable) from in_range where status = 'draft'), 0)))
              else '{}'::jsonb end
  );
$$;
revoke execute on function public.ops_report_settlements(uuid[], text, uuid, timestamptz, timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.ops_report_settlements(uuid[], text, uuid, timestamptz, timestamptz, integer, integer) to service_role;

commit;
