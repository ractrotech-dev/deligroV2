-- 0061 — Partner (vendor) app foundation: the Preparing step, per-order prep
-- time, order status history, vendors reading their own settlements and
-- refunds, and a release track for the Partner app.
--
-- STATUS: APPLIED to the live project by the owner on 2026-10-21 (confirmed by
-- probing order_status_events). Validated first in an in-process Postgres
-- (scripts/qa/sql/migration-0061.mjs).
-- Design: docs/superpowers/specs/2026-10-21-vendor-app-design.md.
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * Four new SELECT policies let a shop owner read their own non-draft
--     settlements, the lines of those settlements, their corrections, and the
--     refunds on their own orders. Writes stay admin-only. Vendors now see a
--     settlement's `notes`, so write notes that the vendor may read.
--   * Two new `orders` columns, granted per column as 0058 requires.
--   * `preparing_at` joins the columns a vendor may not write directly; it is
--     stamped only through start_preparing(), which checks ownership and state.
--
-- Rollback:
--   drop trigger if exists log_order_status_event on public.orders;
--   drop function if exists public.log_order_status_event();
--   drop function if exists public.start_preparing(uuid);
--   drop table if exists public.order_status_events;
--   drop trigger if exists guard_order_prep_minutes on public.orders;
--   drop function if exists public.guard_order_prep_minutes();
--   -- re-run guard_order_update() from 0055_order_delivery_integrity.sql
--   alter table public.orders drop constraint if exists orders_prep_minutes_range;
--   alter table public.orders drop column if exists preparing_at, drop column if exists prep_minutes;
--   drop policy if exists "vendor_settlements — vendor read" on public.vendor_settlements;
--   drop policy if exists "vendor_settlement_orders — vendor read" on public.vendor_settlement_orders;
--   drop policy if exists "settlement_corrections — vendor read" on public.settlement_corrections;
--   drop policy if exists "refunds — vendor read" on public.refunds;
--   alter table public.platform_settings drop constraint if exists platform_settings_vendor_apk_versions,
--     drop column if exists vendor_apk_version_code, drop column if exists vendor_apk_min_version_code,
--     drop column if exists vendor_apk_url, drop column if exists vendor_apk_notes;

-- 1. The Preparing step and per-order prep time -----------------------------
-- The database keeps one `kitchen` status for "accepted" and "preparing"; the
-- app tells them apart by `preparing_at`. A new enum value would ripple through
-- the rider, manager, customer and web code for no gain.
alter table public.orders
  add column if not exists preparing_at timestamptz,
  add column if not exists prep_minutes smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.orders'::regclass
       and conname  = 'orders_prep_minutes_range'
  ) then
    alter table public.orders
      add constraint orders_prep_minutes_range
      check (prep_minutes is null or prep_minutes between 1 and 180);
  end if;
end $$;

comment on column public.orders.preparing_at is
  'When the kitchen started preparing (start_preparing). Null while merely accepted.';
comment on column public.orders.prep_minutes is
  'Prep time the kitchen promised when accepting (1-180). Null = the shop default.';

-- 0058: SELECT on orders is granted per column; a new column is invisible
-- until granted here.
grant select (preparing_at, prep_minutes) on public.orders to authenticated;

-- 0055's guard with `preparing_at` added to the locked list.
create or replace function public.guard_order_update()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  locked constant text[] := array[
    'id', 'customer_id', 'restaurant_id',
    'total', 'delivery_fee', 'tax_amount', 'tip',
    'address', 'created_at',
    'payment_method', 'payment_status',
    'accepted_at', 'ready_at', 'cancelled_at',
    'channel', 'placed_by',
    'coupon_code', 'discount',
    'discount_funded_by',
    'cancelled_by',
    -- 0055: the handover proof and the import / dedup keys.
    'pickup_otp', 'delivery_otp',
    'external_id', 'idempotency_key',
    -- 0061: stamped only by start_preparing().
    'preparing_at'
  ];
  col     text;
  old_row jsonb := to_jsonb(old);
  new_row jsonb := to_jsonb(new);
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  foreach col in array locked loop
    if (old_row -> col) is distinct from (new_row -> col) then
      raise exception
        'only order status may be changed by this role (attempted: %)', col;
    end if;
  end loop;

  return new;
end;
$$;

-- A kitchen may set or change its promised prep time while the order is new
-- or being prepared; once it is ready, the promise is history.
create or replace function public.guard_order_prep_minutes()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.prep_minutes is distinct from old.prep_minutes
     and old.status not in ('placed', 'kitchen')
     and not (
       public.is_admin()
       or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
       or current_user in ('postgres', 'supabase_admin')
     ) then
    raise exception 'prep_minutes_locked' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_order_prep_minutes on public.orders;
create trigger guard_order_prep_minutes
  before update of prep_minutes on public.orders
  for each row execute function public.guard_order_prep_minutes();

-- 2. Order status history ---------------------------------------------------
-- One row per status change (kind 'status') plus the Preparing step (kind
-- 'preparing'). Written only by triggers and start_preparing(); nobody, admin
-- included, writes or rewrites it through the API.
create table if not exists public.order_status_events (
  id            bigint generated always as identity primary key,
  order_id      uuid not null references public.orders (id) on delete cascade,
  restaurant_id uuid not null,
  kind          text not null check (kind in ('status', 'preparing')),
  from_status   public.order_status,
  to_status     public.order_status,
  actor_id      uuid,
  reason        text,
  created_at    timestamptz not null default now()
);

create index if not exists order_status_events_order_idx
  on public.order_status_events (order_id, created_at);

alter table public.order_status_events enable row level security;

drop policy if exists "order_status_events — read" on public.order_status_events;
create policy "order_status_events — read" on public.order_status_events
  for select using (
    public.owns_restaurant(restaurant_id)
    or exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid())
    or public.is_admin()
  );

revoke insert, update, delete on public.order_status_events from anon, authenticated;
grant select on public.order_status_events to authenticated;
grant select, insert, update, delete on public.order_status_events to service_role;

create or replace function public.log_order_status_event()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.order_status_events (order_id, restaurant_id, kind, from_status, to_status, actor_id)
    values (new.id, new.restaurant_id, 'status', null, new.status, auth.uid());
  elsif new.status is distinct from old.status then
    insert into public.order_status_events (order_id, restaurant_id, kind, from_status, to_status, actor_id, reason)
    values (
      new.id, new.restaurant_id, 'status', old.status, new.status, auth.uid(),
      case when new.status = 'cancelled' then new.cancellation_reason end
    );
  end if;
  return null;
end;
$$;

revoke all on function public.log_order_status_event() from public;

drop trigger if exists log_order_status_event on public.orders;
create trigger log_order_status_event
  after insert or update of status on public.orders
  for each row execute function public.log_order_status_event();

-- The only way to stamp `preparing_at`: the owner, on an accepted order, once.
create or replace function public.start_preparing(p_order uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  o     record;
  stamp timestamptz := now();
begin
  select id, restaurant_id, status, preparing_at
    into o
    from public.orders
   where id = p_order
   for update;

  if o.id is null
     or not public.owns_restaurant(o.restaurant_id)
     or o.status <> 'kitchen'
     or o.preparing_at is not null then
    raise exception 'invalid_transition';
  end if;

  update public.orders set preparing_at = stamp where id = p_order;

  insert into public.order_status_events (order_id, restaurant_id, kind, from_status, to_status, actor_id)
  values (o.id, o.restaurant_id, 'preparing', 'kitchen', 'kitchen', auth.uid());

  return stamp;
end;
$$;

revoke all on function public.start_preparing(uuid) from public, anon;
grant execute on function public.start_preparing(uuid) to authenticated, service_role;

-- 3. Vendors read their own money ------------------------------------------
-- Until now these were admin-read only, so the vendor app could not show a
-- settlement history, and vendor-earnings.ts read refunds as zero (finding in
-- vendor-app-audit-2026-10-21.html). Drafts stay hidden: a draft is the admin
-- still working out the numbers.
drop policy if exists "vendor_settlements — vendor read" on public.vendor_settlements;
create policy "vendor_settlements — vendor read" on public.vendor_settlements
  for select using (status <> 'draft' and public.owns_restaurant(restaurant_id));

drop policy if exists "vendor_settlement_orders — vendor read" on public.vendor_settlement_orders;
create policy "vendor_settlement_orders — vendor read" on public.vendor_settlement_orders
  for select using (
    exists (
      select 1 from public.vendor_settlements s
       where s.id = settlement_id
         and s.status <> 'draft'
         and public.owns_restaurant(s.restaurant_id)
    )
  );

drop policy if exists "settlement_corrections — vendor read" on public.settlement_corrections;
create policy "settlement_corrections — vendor read" on public.settlement_corrections
  for select using (public.owns_restaurant(restaurant_id));

drop policy if exists "refunds — vendor read" on public.refunds;
create policy "refunds — vendor read" on public.refunds
  for select using (
    exists (select 1 from public.orders o where o.id = order_id and public.owns_restaurant(o.restaurant_id))
  );

-- 4. Partner app release track (same shape as rider/customer in 0045) ------
alter table public.platform_settings
  add column if not exists vendor_apk_version_code     integer not null default 1,
  add column if not exists vendor_apk_min_version_code integer not null default 1,
  add column if not exists vendor_apk_url              text    not null default '',
  add column if not exists vendor_apk_notes            text    not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.platform_settings'::regclass
       and conname  = 'platform_settings_vendor_apk_versions'
  ) then
    alter table public.platform_settings
      add constraint platform_settings_vendor_apk_versions
      check (
        vendor_apk_version_code >= 1
        and vendor_apk_min_version_code >= 1
        and vendor_apk_min_version_code <= vendor_apk_version_code
      );
  end if;
end $$;

comment on column public.platform_settings.vendor_apk_version_code is
  'Latest Partner APK versionCode. An app below this is offered an update.';
comment on column public.platform_settings.vendor_apk_min_version_code is
  'Oldest Partner APK versionCode still allowed to run. Below this, forceUpdate.';
comment on column public.platform_settings.vendor_apk_url is
  'Direct download URL for the latest Partner APK. Empty = no link to offer.';
