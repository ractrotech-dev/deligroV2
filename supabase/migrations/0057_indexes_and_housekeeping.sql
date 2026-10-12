-- ============================================================
-- 0057 — Indexes for the polled queries, and a retention function
--        (2026-10-12 readiness audit, P2-7)
-- ------------------------------------------------------------
-- Additive and idempotent. Nothing is dropped and no existing row is touched.
--
-- 1. Indexes. Each one is named after the query that needs it. The boards below
--    poll every 3 to 10 seconds, and until now they filtered and sorted `orders`
--    with only single-column indexes on customer_id and restaurant_id:
--      orders_active_created_idx
--        driver board `status = 'ready' order by created_at`
--        (driver-orders.ts), admin and manager live lists `status in (active)
--        order by created_at` (admin-orders.ts, manager-orders.ts).
--        Partial: finished orders, the bulk of the table, are not in it.
--      orders_restaurant_status_created_idx
--        vendor kitchen board and history (vendor-orders.ts).
--      orders_created_at_idx
--        admin lists `order by created_at desc limit N` and the created_at range
--        scans in the dashboards and reports.
--      orders_customer_created_idx
--        "my orders" (orders.ts listMyOrders), notification feed, customer
--        detail in admin.
--      deliveries_driver_delivered_idx / deliveries_driver_active_idx
--        rider history and the "today" count; manager and admin "who is out".
--      profiles_customer_created_idx
--        admin customers list (sorted by newest across the whole table).
--    The tables are small before launch, so plain CREATE INDEX (a brief write
--    lock) inside this transaction is fine. Once there is real traffic, create
--    new indexes one at a time with CREATE INDEX CONCURRENTLY outside a
--    transaction instead.
--    Not dropped here, though now redundant on paper: orders_restaurant_id_idx
--    and orders_customer_id_idx. Check pg_stat_user_indexes on the live project
--    for a week before removing anything; an unused index costs writes, a
--    removed-but-needed one costs a table scan.
--
-- 2. public.housekeeping(): deletes rows nothing will read again.
--      rate_limits   keys whose window ended over a day ago (one row per key,
--                    never removed before)
--      otp_codes     codes older than 7 days (expired after 5 minutes)
--      banner_events events older than 180 days (the running counters live on
--                    the banner row)
--    It is NOT scheduled here. Run it by hand once, then schedule it with
--    pg_cron or an external cron, e.g.
--      select cron.schedule('deligro-housekeeping', '17 3 * * *',
--                           'select public.housekeeping()');
--    Service role only.
--
-- 3. banner_events: the app inserts through the service role
--    (banners.ts recordBannerEvent), so the direct anon/authenticated INSERT
--    right is removed. Left as it was, anyone could append rows to the table
--    from the browser with the public key.
--
-- Rollback: drop index if exists <name>; drop function public.housekeeping();
--   grant insert on public.banner_events to anon, authenticated;
-- ============================================================

begin;

-- 1 ----------------------------------------------------------
create index if not exists orders_active_created_idx
  on public.orders (created_at)
  where status in ('placed', 'kitchen', 'ready', 'on_the_way');

create index if not exists orders_restaurant_status_created_idx
  on public.orders (restaurant_id, status, created_at desc);

create index if not exists orders_created_at_idx
  on public.orders (created_at desc);

create index if not exists orders_customer_created_idx
  on public.orders (customer_id, created_at desc);

create index if not exists deliveries_driver_delivered_idx
  on public.deliveries (driver_id, delivered_at desc)
  where status = 'delivered';

create index if not exists deliveries_driver_active_idx
  on public.deliveries (driver_id)
  where status in ('assigned', 'picked_up');

create index if not exists profiles_customer_created_idx
  on public.profiles (created_at desc)
  where role = 'customer';

create index if not exists rate_limits_reset_idx
  on public.rate_limits (reset_at);

create index if not exists otp_codes_created_idx
  on public.otp_codes (created_at);

create index if not exists banner_events_created_idx
  on public.banner_events (created_at);

-- 2 ----------------------------------------------------------
create or replace function public.housekeeping()
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  n_rate   bigint;
  n_otp    bigint;
  n_banner bigint;
begin
  delete from public.rate_limits
   where reset_at < now() - interval '1 day';
  get diagnostics n_rate = row_count;

  delete from public.otp_codes
   where created_at < now() - interval '7 days';
  get diagnostics n_otp = row_count;

  delete from public.banner_events
   where created_at < now() - interval '180 days';
  get diagnostics n_banner = row_count;

  return jsonb_build_object(
    'rate_limits', n_rate,
    'otp_codes', n_otp,
    'banner_events', n_banner
  );
end;
$$;

revoke all on function public.housekeeping() from public, anon, authenticated;
grant execute on function public.housekeeping() to service_role;

-- 3 ----------------------------------------------------------
revoke insert on public.banner_events from anon, authenticated;

commit;
