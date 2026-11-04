-- ============================================================
-- 0191 — The owner's cancelling and refund rules (docs/RULE-BOOK.md)
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database from this branch.
-- Order: after 0186. Depends on 0055 (guard_order_status), 0142 (ops_cancel_order,
-- _ops_queue_refund), 0026 (the customer refund policy), 0015 (platform_settings).
-- Apply BEFORE the app code: /api/orders/:id/cancel calls customer_cancel_order and
-- refuses when it is missing, so the code without this file means no customer can
-- cancel (staff still can). This file without the code is harmless.
--
-- The rules:
--
--   * A customer can cancel only within 20 seconds of placing the order, and only
--     while the shop has not accepted it. customer_cancel_order decides, on the
--     database's clock. The seconds are a platform setting, default 20; a value it
--     cannot read counts as 20.
--   * A shop cannot cancel. It can only reject a NEW order: guard_order_status loses
--     kitchen>cancelled and ready>cancelled, so a vendor token talking straight to
--     PostgREST is refused as well.
--   * Staff cancel at any time with a written reason of at least 3 characters.
--     ops_cancel_order checks the length, as the manager API already does.
--   * No refunds. Nothing creates a refund row any more: _ops_queue_refund does
--     nothing, the customer's insert policy is gone, and a trigger refuses any new
--     row from the API roles. Old rows stay, and stay readable. Deciding an old one
--     is closed in the app (the routes refuse); ops_decide_refund and the gateway
--     RPCs are left in place for when the owner rules on online money.
--
-- Security review (docs/SECURITY_AUDIT.md): customer_cancel_order is SECURITY DEFINER
-- and callable by `authenticated`, because customers cannot update orders under RLS.
-- It only ever acts on auth.uid()'s own order, in `placed`, inside the window. New
-- column: platform_settings.customer_cancel_seconds, a plain number, granted to
-- anon/authenticated like the other settings. Policy removed, none added.
--
-- Online money: payment_status is NOT touched by a cancel. An order paid online and
-- then cancelled stays `paid`, with no refund row. Still to decide in the rule book.
--
-- Rollback:
--   drop trigger if exists refunds_closed on public.refunds;
--   drop function if exists public.refunds_closed();
--   drop function if exists public.customer_cancel_order(uuid);
--   drop function if exists public.customer_cancel_seconds_left(uuid);
--   drop function if exists public._customer_cancel_seconds();
--   alter table public.platform_settings drop column if exists customer_cancel_seconds;
--   -- then re-run _ops_queue_refund and ops_cancel_order from 0142, guard_order_status
--   -- from 0055, and the "refunds — customer request" policy from 0026.
--
-- Idempotent: safe to re-run.
-- ============================================================

begin;

-- 1. The setting ---------------------------------------------------------------
alter table public.platform_settings
  add column if not exists customer_cancel_seconds integer not null default 20;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_customer_cancel_seconds_check') then
    alter table public.platform_settings
      add constraint platform_settings_customer_cancel_seconds_check
      check (customer_cancel_seconds between 0 and 600);
  end if;
end;
$$;

comment on column public.platform_settings.customer_cancel_seconds is
  'How many seconds after placing an order a customer may cancel it. Rule book: 20. 0 turns customer cancelling off.';

grant select (customer_cancel_seconds) on public.platform_settings to anon, authenticated;

-- 20 whenever the setting cannot be read: the rule book's number, never "no limit".
create or replace function public._customer_cancel_seconds()
returns integer
language plpgsql stable security definer set search_path = public as $$
declare
  v integer;
begin
  begin
    select customer_cancel_seconds into v from public.platform_settings where id = true;
  exception when others then
    v := null;
  end;
  return case when v is null or v < 0 then 20 else v end;
end;
$$;
revoke all on function public._customer_cancel_seconds() from public, anon, authenticated;

-- 2. The customer's cancel ------------------------------------------------------
-- Whole seconds still open for the signed-in customer, rounded down so a screen
-- never offers a button the server would refuse. 0 for anything else, including
-- someone else's order: this answers no question about orders you can't see.
create or replace function public.customer_cancel_seconds_left(p_order uuid)
returns integer
language plpgsql stable security definer set search_path = public as $$
declare
  o public.orders%rowtype;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null or o.customer_id is distinct from auth.uid() or o.status <> 'placed' or o.created_at > now() then
    return 0;
  end if;
  return greatest(0, floor(public._customer_cancel_seconds() - extract(epoch from now() - o.created_at)))::integer;
end;
$$;
revoke all on function public.customer_cancel_seconds_left(uuid) from public, anon;
grant execute on function public.customer_cancel_seconds_left(uuid) to authenticated;

-- The one way a customer cancels. Reads the time from the database (now() is when
-- this transaction began, so waiting for the row lock costs the customer nothing).
-- Refusals: forbidden (no session), not_found (not yours, or no such order, the same
-- answer on purpose), too_late (past the window, or the shop already took it).
create or replace function public.customer_cancel_order(p_order uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o   public.orders%rowtype;
  uid constant uuid := auth.uid();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.customer_id is distinct from uid then
    raise exception 'not_found' using errcode = '22023';
  end if;
  -- A second tap, or a retry after a lost answer: already done, nothing to repeat.
  if o.status = 'cancelled' and o.cancelled_by = 'customer' then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if o.status <> 'placed'
     or o.created_at > now()
     or now() - o.created_at > make_interval(secs => public._customer_cancel_seconds()) then
    raise exception 'too_late' using errcode = '22023';
  end if;

  update public.orders
     set status = 'cancelled', cancelled_by = 'customer'
   where id = p_order;
  return jsonb_build_object('ok', true, 'replayed', false);
end;
$$;
revoke all on function public.customer_cancel_order(uuid) from public, anon;
grant execute on function public.customer_cancel_order(uuid) to authenticated;

-- 3. A shop cannot cancel -------------------------------------------------------
-- As 0055, without kitchen>cancelled and ready>cancelled. Rejecting a new order
-- (placed>cancelled) stays; staff then contact the customer.
create or replace function public.guard_order_status()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  pair constant text := old.status::text || '>' || new.status::text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if public.owns_restaurant(old.restaurant_id)
     and pair in ('placed>kitchen', 'placed>cancelled', 'kitchen>ready') then
    return new;
  end if;

  if public.is_manager()
     and pair in (
       'placed>kitchen', 'kitchen>ready',
       'ready>on_the_way', 'on_the_way>delivered'
     ) then
    return new;
  end if;

  raise exception 'illegal order status change % for this role', pair
    using errcode = '42501';
end;
$$;

-- 4. Staff cancelling: a written reason, and no refund ----------------------------
-- As 0142, with the 3-character reason and no refund. `refund_amount` stays in the
-- answer (always 0) because the Manager app's older builds read it.
create or replace function public.ops_cancel_order(
  p_actor uuid, p_order uuid, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o         public.orders%rowtype;
  role_name text;
  why       constant text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  role_name := public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order, true) || jsonb_build_object('refund_amount', 0);
  end if;
  if why is null or char_length(why) < 3 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if o.status in ('delivered', 'cancelled') then
    raise exception 'terminal' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, why);
  update public.orders
     set status = 'cancelled', cancelled_by = role_name, cancellation_reason = left(why, 200)
   where id = p_order;
  update public.deliveries
     set status = 'cancelled'
   where order_id = p_order and status in ('unassigned', 'assigned', 'picked_up');
  perform public._ops_log(p_actor, 'order.cancel', 'order', p_order::text, o.zone_id, why,
                          jsonb_build_object('status', o.status),
                          jsonb_build_object('status', 'cancelled'),
                          p_client_action_id);
  return public._ops_order_state(p_order, false) || jsonb_build_object('refund_amount', 0);
end;
$$;

-- 5. No new refunds -------------------------------------------------------------
-- The one function every SQL path queued a refund through (a staff cancel, an item
-- marked unavailable, queue_order_refund). Same signature and answer, so
-- ops_correct_order still records its correction; it just never adds a row.
create or replace function public._ops_queue_refund(
  p_order uuid, p_amount integer, p_reason text, p_origin text, p_requested_by uuid
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'refund_id', null,
    'amount', 0,
    'paid', exists (select 1 from public.orders o where o.id = p_order and coalesce(o.payment_status::text, '') = 'paid')
  );
end;
$$;
revoke execute on function public._ops_queue_refund(uuid, integer, text, text, uuid) from public, anon, authenticated, service_role;

drop policy if exists "refunds — customer request" on public.refunds;
revoke insert on public.refunds from anon, authenticated;

-- Refuses a new row from every API role, the service role included: a path somebody
-- missed, or adds later, fails loudly instead of quietly opening a refund. A person
-- with database access (postgres) can still repair by hand.
create or replace function public.refunds_closed()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  raise exception 'refunds_closed' using errcode = '42501';
end;
$$;
revoke all on function public.refunds_closed() from public, anon, authenticated;

drop trigger if exists refunds_closed on public.refunds;
create trigger refunds_closed
  before insert on public.refunds
  for each row execute function public.refunds_closed();

commit;
