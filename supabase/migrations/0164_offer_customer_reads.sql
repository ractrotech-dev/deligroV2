-- ============================================================
-- 0164 — Offer and customer reads for managers, in SQL
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database. Runs after 0161/0162.
-- Read-only helpers the manager routes call as service role, so no route
-- sums redemptions or orders in Node:
--
--   * ops_offer_rows(zones[], codes[]): every code a scope may see (platform-
--     wide, or one of its shops' / its zones — manager_can_see_offer's rule)
--     with its lists and all-time use (redemptions on orders not cancelled).
--   * ops_offer_redemption_rows(code, from, to): one code's redemptions in a
--     range, with the order's state, total, funding and whether it was the
--     customer's first counted order.
--   * ops_customer_facts(customer, zones[]): one customer's figures in scope
--     (address lines go to the server only, which keeps the locality part).
--
-- Rollback:
--   drop function if exists public.ops_customer_facts(uuid, uuid[]), public.ops_offer_redemption_rows(text, timestamptz, timestamptz),
--     public.ops_offer_rows(uuid[], text[]);
-- ============================================================

begin;

create or replace function public.ops_offer_rows(p_zones uuid[], p_codes text[] default null)
returns table (code text, label text, kind text, value numeric, min_order numeric, max_discount numeric, active boolean,
               starts_at timestamptz, expires_at timestamptz, max_per_customer integer, max_redemptions integer, funded_by text,
               created_by uuid, created_at timestamptz, updated_at timestamptz, vendor_ids uuid[], zone_ids uuid[], item_ids uuid[],
               platform_wide boolean, in_scope boolean, redemptions integer, discount_given integer)
language sql stable security definer set search_path = public as $$
  with lists as (
    select c.*,
           coalesce((select array_agg(cr.restaurant_id order by cr.restaurant_id) from public.coupon_restaurants cr where cr.code = c.code), '{}') as v_ids,
           coalesce((select array_agg(cz.zone_id order by cz.zone_id) from public.coupon_zones cz where cz.code = c.code), '{}') as z_ids,
           coalesce((select array_agg(ci.menu_item_id order by ci.menu_item_id) from public.coupon_items ci where ci.code = c.code), '{}') as i_ids
      from public.coupons c
     where p_codes is null or c.code = any (p_codes)
  ),
  scoped as (
    select l.*,
           (cardinality(l.v_ids) = 0 and cardinality(l.z_ids) = 0) as pw,
           (p_zones is null
            or (exists (select 1 from unnest(l.v_ids) v join public.restaurants r on r.id = v where r.zone_id = any (p_zones))
                or exists (select 1 from unnest(l.z_ids) z where z = any (p_zones)))) as touches,
           (p_zones is null
            or ((cardinality(l.v_ids) + cardinality(l.z_ids)) > 0
                and not exists (select 1 from unnest(l.v_ids) v join public.restaurants r on r.id = v where r.zone_id is null or not r.zone_id = any (p_zones))
                and not exists (select 1 from unnest(l.z_ids) z where not z = any (p_zones)))) as mine
      from lists l
  )
  select s.code, s.label, s.kind, s.value, s.min_order, s.max_discount, s.active, s.starts_at, s.expires_at,
         s.max_per_customer, s.max_redemptions, s.funded_by, s.created_by, s.created_at, s.updated_at,
         s.v_ids, s.z_ids, s.i_ids, s.pw, s.mine,
         (select count(*) from public.coupon_redemptions r join public.orders o on o.id = r.order_id
           where r.code = s.code and o.status <> 'cancelled')::integer,
         (select coalesce(sum(r.discount), 0) from public.coupon_redemptions r join public.orders o on o.id = r.order_id
           where r.code = s.code and o.status <> 'cancelled')::integer
    from scoped s
   where s.pw or s.touches;
$$;

create or replace function public.ops_offer_redemption_rows(p_code text, p_from timestamptz, p_to timestamptz)
returns table (order_id uuid, customer_id uuid, discount integer, created_at timestamptz, restaurant_id uuid, cancelled boolean,
               order_total integer, funded_by text, first_order boolean)
language sql stable security definer set search_path = public as $$
  select r.order_id, r.customer_id, r.discount, r.created_at, o.restaurant_id, o.status = 'cancelled', o.total,
         coalesce(o.discount_funded_by, c.funded_by),
         not exists (select 1 from public.orders p
                      where p.customer_id = o.customer_id and p.status <> 'cancelled'
                        and public.ops_counts_as_order(p.payment_method::text, p.payment_status::text)
                        and (p.created_at, p.id) < (o.created_at, o.id))
    from public.coupon_redemptions r
    join public.orders o on o.id = r.order_id
    join public.coupons c on c.code = r.code
   where r.code = p_code and r.created_at >= p_from and r.created_at < p_to
   order by r.created_at;
$$;

-- One customer's figures within the zones (null = all): counted orders and
-- spend, cancellations, first and last order, and the ratings they left.
create or replace function public.ops_customer_facts(p_customer uuid, p_zones uuid[])
returns jsonb
language sql stable security definer set search_path = public as $$
  with o as (
    select * from public.orders o
     where o.customer_id = p_customer and (p_zones is null or o.zone_id = any (p_zones))
  )
  select jsonb_build_object(
    'orders', (select count(*) from o where o.status <> 'cancelled' and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)),
    'spent', (select coalesce(sum(o.total), 0) from o where o.status <> 'cancelled' and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)),
    'cancelled', (select count(*) from o where o.status = 'cancelled'),
    'firstOrderAt', (select min(o.created_at) from o where o.status <> 'cancelled' and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)),
    'lastOrderAt', (select max(o.created_at) from o),
    'zoneIds', (select coalesce(jsonb_agg(distinct o.zone_id), '[]') from o where o.zone_id is not null),
    -- Address lines for the server to reduce to a locality (never sent whole).
    'addressLines', (select coalesce(jsonb_agg(x.line), '[]') from (
                       select distinct nullif(trim(o.address ->> 'line'), '') as line from o
                        where nullif(trim(o.address ->> 'line'), '') is not null limit 10) x));
$$;

revoke execute on function public.ops_offer_rows(uuid[], text[]), public.ops_offer_redemption_rows(text, timestamptz, timestamptz),
  public.ops_customer_facts(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.ops_offer_rows(uuid[], text[]), public.ops_offer_redemption_rows(text, timestamptz, timestamptz),
  public.ops_customer_facts(uuid, uuid[]) to service_role;

commit;
