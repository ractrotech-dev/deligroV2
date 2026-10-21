-- 0063 — Partner app: tax invoice numbers for orders (requirements §11).
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0063.mjs); run it on staging first.
-- Design: docs/superpowers/specs/2026-10-21-vendor-app-design.md.
--
-- An order gets its invoice number the moment the kitchen's part is done
-- (status reaches on_the_way or delivered). Numbers run per shop, per Indian
-- financial year (April–March, IST), with no gaps: the counter row is locked
-- and bumped inside the same transaction as the status change, so a rolled
-- back change rolls the number back too. Format: INV/2026-27/00042.
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * orders.invoice_no / invoice_at: readable by authenticated per column
--     (0058 pattern), and added to guard_order_update's locked list so only the
--     trigger (or an admin / service role) ever sets them.
--   * invoice_counters: RLS on with no policies; only the SECURITY DEFINER
--     trigger function touches it. Nothing is granted to anon/authenticated.
--
-- Rollback:
--   drop trigger if exists orders_zz_assign_invoice on public.orders;
--   drop function if exists public.assign_invoice_no(), public.invoice_fy(timestamptz);
--   drop table if exists public.invoice_counters;
--   alter table public.orders drop column if exists invoice_no, drop column if exists invoice_at;
--   -- re-run guard_order_update() from 0061_vendor_app_foundation.sql

-- 1. Columns ------------------------------------------------------------------
alter table public.orders
  add column if not exists invoice_no text,
  add column if not exists invoice_at timestamptz;

create unique index if not exists orders_invoice_no_unique
  on public.orders (restaurant_id, invoice_no) where invoice_no is not null;

grant select (invoice_no, invoice_at) on public.orders to authenticated;

comment on column public.orders.invoice_no is
  'Tax invoice number, per shop per financial year, gapless (INV/2026-27/00042). Set by assign_invoice_no() when the kitchen''s part is done.';

-- 2. Counters -----------------------------------------------------------------
create table if not exists public.invoice_counters (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  fy            text not null check (fy ~ '^\d{4}-\d{2}$'),
  last_no       integer not null default 0 check (last_no >= 0),
  primary key (restaurant_id, fy)
);
alter table public.invoice_counters enable row level security;
revoke all on public.invoice_counters from anon, authenticated;
grant select, insert, update, delete on public.invoice_counters to service_role;

-- 3. Financial year of an instant, in IST: 2026-04-01 → '2026-27'.
create or replace function public.invoice_fy(p_at timestamptz)
returns text
language sql immutable set search_path = public as $$
  select case
    when extract(month from (p_at at time zone 'Asia/Kolkata')) >= 4
      then to_char(p_at at time zone 'Asia/Kolkata', 'YYYY') || '-' ||
           lpad(((extract(year from (p_at at time zone 'Asia/Kolkata'))::int + 1) % 100)::text, 2, '0')
    else (extract(year from (p_at at time zone 'Asia/Kolkata'))::int - 1)::text || '-' ||
           to_char(p_at at time zone 'Asia/Kolkata', 'YY')
  end
$$;

-- 4. The trigger --------------------------------------------------------------
-- Named orders_zz_… so it runs AFTER orders_guard_update (before-triggers
-- fire in name order): the guard sees the row before the number is stamped.
create or replace function public.assign_invoice_no()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_fy text;
  v_no integer;
begin
  if new.invoice_no is null
     and new.status in ('on_the_way', 'delivered')
     and (tg_op = 'INSERT' or old.status not in ('on_the_way', 'delivered')) then
    v_fy := public.invoice_fy(now());
    insert into public.invoice_counters as c (restaurant_id, fy, last_no)
    values (new.restaurant_id, v_fy, 1)
    on conflict (restaurant_id, fy) do update set last_no = c.last_no + 1
    returning last_no into v_no;
    new.invoice_no := 'INV/' || v_fy || '/' || lpad(v_no::text, 5, '0');
    new.invoice_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.assign_invoice_no() from public, anon, authenticated;
revoke all on function public.invoice_fy(timestamptz) from public, anon;
grant execute on function public.invoice_fy(timestamptz) to authenticated, service_role;

drop trigger if exists orders_zz_assign_invoice on public.orders;
create trigger orders_zz_assign_invoice
  before insert or update of status on public.orders
  for each row execute function public.assign_invoice_no();

-- 5. The guard: invoice columns join the locked list (0061 + two names) -------
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
    'preparing_at',
    -- 0063: stamped only by assign_invoice_no().
    'invoice_no', 'invoice_at'
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

-- 6. Backfill: orders already past the kitchen, numbered in the order they
-- were placed, per shop and financial year of placement.
do $$
declare
  r record;
  v_no integer;
begin
  for r in
    select id, restaurant_id, public.invoice_fy(created_at) as fy, created_at
      from public.orders
     where invoice_no is null and status in ('on_the_way', 'delivered')
     order by restaurant_id, created_at, id
  loop
    insert into public.invoice_counters as c (restaurant_id, fy, last_no)
    values (r.restaurant_id, r.fy, 1)
    on conflict (restaurant_id, fy) do update set last_no = c.last_no + 1
    returning last_no into v_no;
    update public.orders
       set invoice_no = 'INV/' || r.fy || '/' || lpad(v_no::text, 5, '0'),
           invoice_at = r.created_at
     where id = r.id;
  end loop;
end $$;
