-- ============================================================
-- 0194 — Payment methods: a platform cash limit and a cash switch
-- ------------------------------------------------------------
-- STATUS: APPLIED 2026-11-05 to the Supabase project ending akxv, with 0190-0201 as one transaction.
-- Deploy order: … → 0181 → 0190 → 0194.
--
-- docs/RULE-BOOK.md, "Payment methods": the admin panel controls whether online
-- payment is on, and the cash limit. Above the cash limit the order can only be
-- paid online.
--
--   * platform_settings.cash_limit_per_order: rupees, 0 = no limit. A shop's own
--     restaurants.cod_max_order stays and the stricter of the two applies; a shop
--     value of 0 means "use the platform limit".
--   * platform_settings.feature_cash_payment: cash on delivery on or off for the
--     whole platform. Default on, so nothing changes until an admin says so. A
--     CHECK refuses both methods off; the admin form refuses it first, and also
--     when online is on but its keys are missing.
--   * guard_order_cod_ceiling (0181): the guard every cash order passes through
--     when it leaves 'placed'. Now judges the stricter limit, and refuses a cash
--     order while cash is off. Admin and the service role still pass, and a
--     cancellation always passes, so an order caught by a change can be cancelled.
--
-- No new insert check: the limit is judged on the amount after the coupon, and the
-- coupon is applied after the items (see 0181). createOrder() refuses first.
--
-- Both columns are read by checkout, so anon and authenticated can read them. They
-- are not secret: they decide what a customer is shown.
--
-- Rollback:
--   re-run the guard_order_cod_ceiling body from 0181, then
--   alter table public.platform_settings drop constraint if exists platform_settings_a_payment_method;
--   alter table public.platform_settings drop constraint if exists platform_settings_cash_limit_nonneg;
--   alter table public.platform_settings drop column if exists cash_limit_per_order, drop column if exists feature_cash_payment;
-- ============================================================

begin;

alter table public.platform_settings
  add column if not exists cash_limit_per_order integer not null default 0,
  add column if not exists feature_cash_payment boolean not null default true;

do $$ begin
  alter table public.platform_settings
    add constraint platform_settings_cash_limit_nonneg check (cash_limit_per_order >= 0);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.platform_settings
    add constraint platform_settings_a_payment_method
    check (feature_cash_payment or feature_online_payment);
exception when duplicate_object then null;
end $$;

comment on column public.platform_settings.cash_limit_per_order is
  'Highest order total payable in cash, whole rupees, for every shop. 0 = no limit. A shop''s own cod_max_order stays; the stricter applies.';
comment on column public.platform_settings.feature_cash_payment is
  'Cash on delivery on or off for the whole platform. Cannot be off while online payment is off.';

-- Column-granted since 0032.
grant select (cash_limit_per_order, feature_cash_payment)
  on public.platform_settings to anon, authenticated;

comment on column public.restaurants.cod_max_order is
  'Highest order total payable in cash at this shop, whole rupees. 0 = use the platform limit (platform_settings.cash_limit_per_order). The stricter of the two applies.';

create or replace function public.guard_order_cod_ceiling()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  shop_limit integer;
  platform_limit integer := 0;
  cash_on boolean := true;
  cash_limit integer;
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin') then
    return new;
  end if;
  if new.status = 'cancelled' or coalesce(new.payment_method, 'cod') <> 'cod' then
    return new;
  end if;

  select coalesce(r.cod_max_order, 0) into shop_limit
    from public.restaurants r where r.id = new.restaurant_id;

  select coalesce(s.cash_limit_per_order, 0), coalesce(s.feature_cash_payment, true)
    into platform_limit, cash_on
    from public.platform_settings s limit 1;

  if not coalesce(cash_on, true) then
    raise exception 'orders: cash on delivery is switched off';
  end if;

  -- The smaller of the two limits that are set. 0 on either side means "not set".
  cash_limit := case
    when coalesce(shop_limit, 0) > 0 and coalesce(platform_limit, 0) > 0 then least(shop_limit, platform_limit)
    else greatest(coalesce(shop_limit, 0), coalesce(platform_limit, 0))
  end;

  if cash_limit > 0 and new.total > cash_limit then
    raise exception 'orders: over the cash limit for this order';
  end if;
  return new;
end;
$$;

commit;
