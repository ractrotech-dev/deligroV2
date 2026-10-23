-- ============================================================
-- 0163 — Campaign performance and the marketing report, in SQL
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database. Runs after 0160–0162
-- and 0158 (ops_report_marketing, re-declared here).
--
-- One attribution rule, the one src/lib/marketing/attribution.ts states and
-- scripts/qa/manager-marketing-rules.ts tests: a counted, non-cancelled order
-- inside the campaign's window is attributed when it redeemed the campaign's
-- code, or it is at one of the campaign's shops (sponsored: holds one of its
-- dishes) and its customer clicked the campaign — its own surface or its
-- banner — within the 24 h before ordering. Each order once.
--
--   * _ops_campaign_attributed(campaign, from, to): the attributed orders.
--   * ops_campaign_headlines(ids[]): list figures for a page of campaigns.
--   * ops_campaign_performance(campaign, from, to): the detail screen's
--     figures, daily by IST day, and Before / During for featured and
--     sponsored campaigns.
--   * ops_report_marketing: 0158's, plus a campaigns section (budget, funding,
--     status, attributed sales); a campaign-owned banner is reported once, as
--     its campaign.
--
-- Rollback:
--   drop function if exists public.ops_campaign_performance(uuid, timestamptz, timestamptz),
--     public.ops_campaign_headlines(uuid[]), public._ops_campaign_attributed(uuid, timestamptz, timestamptz);
--   -- re-run 0158's ops_report_marketing
-- ============================================================

begin;

create index if not exists orders_coupon_code_idx on public.orders (coupon_code) where coupon_code is not null;

create or replace function public._ops_campaign_attributed(p_campaign uuid, p_from timestamptz, p_to timestamptz)
returns table (order_id uuid, customer_id uuid, total integer, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  with c as (
    select cp.* from public.campaigns cp where cp.id = p_campaign
  ),
  win as (
    select greatest(c.starts_at, p_from) as s, least(c.ends_at, p_to) as e from c
  ),
  clicks as (
    select e.customer_id, e.created_at from public.campaign_events e
     where e.campaign_id = p_campaign and e.kind = 'click' and e.customer_id is not null
    union all
    select b.customer_id, b.created_at from public.banner_events b join c on b.banner_id = c.banner_id
     where b.kind = 'click' and b.customer_id is not null
  )
  select o.id, o.customer_id, o.total, o.created_at
    from c, win, public.orders o
   where o.created_at >= win.s and o.created_at < win.e
     and o.zone_id = c.zone_id
     and o.status <> 'cancelled'
     and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
     and (
       (c.offer_code is not null and o.coupon_code = c.offer_code)
       or (
         (case when c.kind = 'sponsored_product'
               then exists (select 1 from public.order_items oi join public.campaign_items ci
                             on ci.menu_item_id = oi.menu_item_id and ci.campaign_id = c.id where oi.order_id = o.id)
               else (not exists (select 1 from public.campaign_vendors cv where cv.campaign_id = c.id)
                     or exists (select 1 from public.campaign_vendors cv where cv.campaign_id = c.id and cv.restaurant_id = o.restaurant_id))
          end)
         and exists (select 1 from clicks k
                      where k.customer_id = o.customer_id and k.created_at <= o.created_at
                        and k.created_at >= o.created_at - interval '24 hours')));
$$;
revoke execute on function public._ops_campaign_attributed(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public._ops_campaign_attributed(uuid, timestamptz, timestamptz) to service_role;

-- Impressions and clicks of a campaign: its own events plus its banner's.
create or replace function public._ops_campaign_events(p_campaign uuid, p_from timestamptz, p_to timestamptz)
returns table (kind text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.kind, e.created_at from public.campaign_events e
   where e.campaign_id = p_campaign and e.created_at >= p_from and e.created_at < p_to
  union all
  select b.kind, b.created_at from public.banner_events b
    join public.campaigns c on c.banner_id = b.banner_id and c.id = p_campaign
   where b.kind in ('impression', 'click') and b.created_at >= p_from and b.created_at < p_to;
$$;
revoke execute on function public._ops_campaign_events(uuid, timestamptz, timestamptz) from public, anon, authenticated;

create or replace function public.ops_campaign_headlines(p_ids uuid[])
returns table (campaign_id uuid, impressions integer, clicks integer, attributed_orders integer, attributed_sales integer)
language sql stable security definer set search_path = public as $$
  -- Each campaign's events and attributed orders are worked out once (a lateral join),
  -- not once per figure.
  select c.id,
         coalesce(ev.imp, 0)::integer, coalesce(ev.clk, 0)::integer,
         coalesce(att.n, 0)::integer, coalesce(att.s, 0)::integer
    from public.campaigns c
    left join lateral (
      select (count(*) filter (where e.kind = 'impression')) as imp, (count(*) filter (where e.kind = 'click')) as clk
        from public._ops_campaign_events(c.id, c.starts_at, c.ends_at) e) ev on true
    left join lateral (
      select count(*) as n, coalesce(sum(a.total), 0) as s
        from public._ops_campaign_attributed(c.id, c.starts_at, c.ends_at) a) att on true
   where c.id = any (p_ids);
$$;

create or replace function public.ops_campaign_performance(p_campaign uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c        record;
  len      interval := p_to - p_from;
  daily    jsonb;
  result   jsonb;
  cmp      jsonb := null;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.id is null then
    return null;
  end if;

  with days as (
    select generate_series((p_from at time zone 'Asia/Kolkata')::date, ((p_to - interval '1 microsecond') at time zone 'Asia/Kolkata')::date,
                           interval '1 day')::date as d
  ),
  ev as (
    select (created_at at time zone 'Asia/Kolkata')::date as d, kind from public._ops_campaign_events(p_campaign, p_from, p_to)
  ),
  att as (
    select (created_at at time zone 'Asia/Kolkata')::date as d, total from public._ops_campaign_attributed(p_campaign, p_from, p_to)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(days.d, 'YYYY-MM-DD'),
           'impressions', (select count(*) from ev where ev.d = days.d and ev.kind = 'impression'),
           'clicks', (select count(*) from ev where ev.d = days.d and ev.kind = 'click'),
           'attributedOrders', (select count(*) from att where att.d = days.d),
           'attributedSales', (select coalesce(sum(att.total), 0) from att where att.d = days.d)) order by days.d), '[]'::jsonb)
    into daily from days;

  if c.kind in ('featured_store', 'sponsored_product') then
    with shop_orders as (
      select o.created_at, o.total from public.orders o
       where o.created_at >= p_from - len and o.created_at < p_to
         and o.status <> 'cancelled' and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
         and (case when c.kind = 'sponsored_product'
                   then exists (select 1 from public.order_items oi join public.campaign_items ci
                                 on ci.menu_item_id = oi.menu_item_id and ci.campaign_id = c.id where oi.order_id = o.id)
                   else exists (select 1 from public.campaign_vendors cv where cv.campaign_id = c.id and cv.restaurant_id = o.restaurant_id)
              end)
    )
    select jsonb_build_object(
             'beforeOrders', count(*) filter (where created_at < p_from),
             'beforeSales', coalesce(sum(total) filter (where created_at < p_from), 0),
             'duringOrders', count(*) filter (where created_at >= p_from),
             'duringSales', coalesce(sum(total) filter (where created_at >= p_from), 0))
      into cmp from shop_orders;
  end if;

  select jsonb_build_object(
    'impressions', (select count(*) from public._ops_campaign_events(p_campaign, p_from, p_to) ev where ev.kind = 'impression'),
    'clicks', (select count(*) from public._ops_campaign_events(p_campaign, p_from, p_to) ev where ev.kind = 'click'),
    'redemptions', (select count(*) from public.coupon_redemptions r join public.orders o on o.id = r.order_id
                     where c.offer_code is not null and r.code = c.offer_code and o.status <> 'cancelled'
                       and r.created_at >= p_from and r.created_at < p_to),
    'discountGiven', (select coalesce(sum(r.discount), 0) from public.coupon_redemptions r join public.orders o on o.id = r.order_id
                       where c.offer_code is not null and r.code = c.offer_code and o.status <> 'cancelled'
                         and r.created_at >= p_from and r.created_at < p_to),
    'attributedOrders', (select count(*) from public._ops_campaign_attributed(p_campaign, p_from, p_to)),
    'attributedSales', (select coalesce(sum(total), 0) from public._ops_campaign_attributed(p_campaign, p_from, p_to)),
    'attributedCustomers', (select count(distinct customer_id) from public._ops_campaign_attributed(p_campaign, p_from, p_to)),
    'comparison', cmp,
    'daily', daily)
    into result;
  return result;
end;
$$;

-- 0158's report, with campaigns. A campaign-owned banner is reported as its
-- campaign, not twice.
create or replace function public.ops_report_marketing(
  p_zone_ids uuid[], p_zone_names text[], p_start timestamptz, p_end timestamptz, p_restaurant uuid
)
returns jsonb
language sql stable set search_path = public as $$
  with b as (
    select bn.id, bn.name, bn.kind, bn.status, bn.starts_at, bn.ends_at, bn.sponsor_name
      from public.banners bn
     where p_restaurant is null
       and not exists (select 1 from public.campaigns cm where cm.banner_id = bn.id)
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
  ),
  cm as (
    select c.id, c.title, c.kind, c.status, c.starts_at, c.ends_at, c.budget, c.funded_by,
           (select string_agg(r.name, ', ' order by r.name) from public.campaign_vendors cv join public.restaurants r on r.id = cv.restaurant_id
             where cv.campaign_id = c.id) as vendors,
           greatest(c.starts_at, p_start) as s, least(c.ends_at, p_end) as e
      from public.campaigns c
     where c.starts_at < p_end and c.ends_at >= p_start
       and (p_zone_ids is null or c.zone_id = any (p_zone_ids))
       and (p_restaurant is null or exists (select 1 from public.campaign_vendors cv where cv.campaign_id = c.id and cv.restaurant_id = p_restaurant))
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
                from cp left join red on red.code = cp.code left join public.restaurants s on s.id = cp.restaurant_id),
    'campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', cm.id, 'campaign', cm.title, 'type', cm.kind, 'vendor', cm.vendors, 'start', cm.starts_at, 'end', cm.ends_at,
                    'status', cm.status, 'budget', cm.budget, 'fundedBy', cm.funded_by,
                    'impressions', (select count(*) from public._ops_campaign_events(cm.id, cm.s, cm.e) ev where ev.kind = 'impression'),
                    'clicks', (select count(*) from public._ops_campaign_events(cm.id, cm.s, cm.e) ev where ev.kind = 'click'),
                    'attributedOrders', (select count(*) from public._ops_campaign_attributed(cm.id, cm.s, cm.e)),
                    'attributedSales', (select coalesce(sum(a.total), 0) from public._ops_campaign_attributed(cm.id, cm.s, cm.e) a))
                    order by cm.starts_at, cm.id), '[]'::jsonb)
                    from cm));
$$;

revoke execute on function public.ops_campaign_headlines(uuid[]), public.ops_campaign_performance(uuid, timestamptz, timestamptz),
  public.ops_report_marketing(uuid[], text[], timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.ops_campaign_headlines(uuid[]), public.ops_campaign_performance(uuid, timestamptz, timestamptz),
  public.ops_report_marketing(uuid[], text[], timestamptz, timestamptz, uuid) to service_role;

commit;
