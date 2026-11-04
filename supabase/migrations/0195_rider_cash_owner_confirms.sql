-- ============================================================
-- 0195 — Rider cash: the owner confirms too, and who confirmed is always recorded
-- ------------------------------------------------------------
-- STATUS: APPLIED 2026-11-05 to the Supabase project ending akxv, with 0190-0201 as one transaction.
-- Deploy order: … → 0157 → 0194 → 0195. Apply before shipping the matching apps.
--
-- docs/RULE-BOOK.md, "Rider cash": cash goes rider → manager → owner, or rider →
-- owner. A manager or the owner confirms they received it. One confirmation is
-- enough. The app always records who confirmed.
--
--   * cash_handover_leg gains rider_to_owner. It is added on its own line, before the
--     transaction, because a new enum value can't be used in the transaction that
--     adds it. Everything below compares h.leg::text, so no function body uses the
--     value until it runs.
--   * cod_handovers.confirmed_by / confirmed_at: who confirmed this cash. Stamped on
--     insert by stamp_handover_confirmer. History is filled in from recorded_by,
--     which is who confirmed every rider handover so far. A manager's own "I gave it
--     to the owner" row stays unconfirmed until the owner confirms it; it counts in
--     the balances from the moment it is written, exactly as it always has.
--   * ops_decide_cash_deposit: the person who confirms is the person who received
--     the cash. An admin writes rider_to_owner; a manager writes rider_to_manager, to
--     themselves (0152 wrote to the manager the rider named, even when someone else
--     received it, and put the cash on that person's balance). It locks the deposit
--     and refuses anything no longer 'submitted', so the first decision wins and the
--     second is told already_decided. A rider's deposit cannot be counted twice.
--   * ops_record_cash_received: an admin records cash received directly from a rider
--     or a manager. Admin only.
--   * ops_confirm_manager_handover: an admin confirms a manager's "I gave it to the
--     owner" row. Adds no money; first confirmation wins.
--   * guard_manual_rider_handover: covers rider_to_owner, and refuses a hand-written
--     row a second person writes for the same cash (same person, same day, same
--     amount, same direction): handover_exists.
--   * ops_rider_cash_position (0154) and ops_cash_reconciliation (0157): cash a rider
--     gave the owner comes off what the rider holds. A manager's figures now also
--     count rows the /manager/cash form wrote with from_user or to_user empty (it
--     always did): the row's recorder is that manager.
--
-- History: no amount or leg is changed. An old rider_to_manager row whose to_user is
-- an admin stays what it was: it is still off the rider's balance.
--
-- Rollback:
--   re-run ops_decide_cash_deposit and guard_manual_rider_handover from 0152,
--   ops_rider_cash_position from 0154 and ops_cash_reconciliation from 0157, then
--   drop function if exists public.ops_record_cash_received(uuid, uuid, text, integer, text, text);
--   drop function if exists public.ops_confirm_manager_handover(uuid, uuid, text);
--   drop trigger if exists stamp_handover_confirmer on public.cod_handovers;
--   drop function if exists public.stamp_handover_confirmer();
--   alter table public.cod_handovers drop column if exists confirmed_by, drop column if exists confirmed_at;
--   (Postgres can't drop an enum value. rider_to_owner rows must be kept or re-labelled first.)
-- ============================================================

alter type public.cash_handover_leg add value if not exists 'rider_to_owner';

begin;

alter table public.cod_handovers
  add column if not exists confirmed_by uuid references public.profiles (id),
  add column if not exists confirmed_at timestamptz;

comment on column public.cod_handovers.confirmed_by is
  'Who confirmed they received this cash. Null only on a manager''s own manager_to_owner row the owner has not confirmed yet.';

-- Every rider handover so far was written by the person who received it; an admin
-- who wrote a manager→owner row was the owner receiving it.
update public.cod_handovers h
   set confirmed_by = h.recorded_by, confirmed_at = h.created_at
 where h.confirmed_by is null
   and (h.leg::text <> 'manager_to_owner'
        or exists (select 1 from public.profiles p where p.id = h.recorded_by and p.role::text = 'admin'));

create or replace function public.stamp_handover_confirmer()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.confirmed_by is null
     and (new.leg::text <> 'manager_to_owner'
          or exists (select 1 from public.profiles p where p.id = new.recorded_by and p.role::text = 'admin')) then
    new.confirmed_by := new.recorded_by;
  end if;
  if new.confirmed_by is not null and new.confirmed_at is null then
    new.confirmed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_handover_confirmer on public.cod_handovers;
create trigger stamp_handover_confirmer
  before insert on public.cod_handovers
  for each row execute function public.stamp_handover_confirmer();

-- ------------------------------------------------------------
-- Deposits: first confirmation wins, and the confirmer received the cash
-- ------------------------------------------------------------
create or replace function public.ops_decide_cash_deposit(
  p_actor uuid, p_deposit uuid, p_decision text, p_note text, p_zone uuid, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  dep        public.cash_deposits%rowtype;
  zone       uuid;
  ho         uuid;
  actor_role text;
  v_note constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into dep from public.cash_deposits where id = p_deposit for update;
  if dep.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  zone := public.ops_require_staff_for_rider(p_actor, dep.driver_id);
  if p_zone is not null then
    perform public.ops_require_staff(p_actor, p_zone);
    if not exists (select 1 from public.staff_zones where user_id = dep.driver_id and zone_id = p_zone) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    zone := p_zone;
  end if;
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('deposit_id', dep.id, 'status', dep.status, 'handover_id', dep.handover_id, 'replayed', true);
  end if;
  if dep.status <> 'submitted' then
    raise exception 'already_decided' using errcode = '22023';
  end if;
  if p_decision = 'dispute' and (v_note is null or char_length(v_note) < 3 or char_length(v_note) > 500) then
    raise exception 'note_required' using errcode = '22023';
  end if;
  if p_decision not in ('confirm', 'dispute') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  select p.role::text into actor_role from public.profiles p where p.id = p_actor;

  perform public._ops_set_actor(p_actor, v_note);
  if p_decision = 'confirm' then
    -- One record per handover: a leg already written by hand for this rider on
    -- the deposit's day would be counted twice (0154's pending_deposit would
    -- understate what the rider still holds). Dispute the deposit instead.
    if exists (select 1 from public.cod_handovers h
                where h.leg::text in ('rider_to_manager', 'rider_to_owner') and h.from_user = dep.driver_id
                  and h.handover_date = (dep.created_at at time zone 'Asia/Kolkata')::date
                  and not exists (select 1 from public.cash_deposits d2 where d2.handover_id = h.id)) then
      raise exception 'manual_handover_exists' using errcode = '23505';
    end if;
    -- The person confirming received the cash, so it goes on their balance: an
    -- admin is the owner, a manager is that manager. Dated the day the rider
    -- handed it over, which is the day they declared the deposit.
    perform set_config('deligro.deposit_confirm', 'on', true);
    insert into public.cod_handovers (leg, from_user, to_user, amount, handover_date, note, recorded_by, confirmed_by, confirmed_at, zone_id)
    values ((case when actor_role = 'admin' then 'rider_to_owner' else 'rider_to_manager' end)::public.cash_handover_leg,
            dep.driver_id, p_actor, dep.amount,
            (dep.created_at at time zone 'Asia/Kolkata')::date,
            coalesce(v_note, 'Deposit ' || dep.method || coalesce(' ' || dep.reference, '')), p_actor, p_actor, now(), zone)
    returning id into ho;
    perform set_config('deligro.deposit_confirm', '', true);
    update public.cash_deposits
       set status = 'confirmed', handover_id = ho, decided_by = p_actor, decided_at = now(), decision_note = v_note
     where id = p_deposit;
  else
    update public.cash_deposits
       set status = 'disputed', decided_by = p_actor, decided_at = now(), decision_note = v_note
     where id = p_deposit;
  end if;
  perform public._ops_log(
    p_actor, 'cash.deposit.' || p_decision, 'cash_deposit', p_deposit::text, zone, v_note,
    jsonb_build_object('status', dep.status, 'amount', dep.amount, 'riderId', dep.driver_id),
    jsonb_build_object('status', case when p_decision = 'confirm' then 'confirmed' else 'disputed' end, 'handoverId', ho),
    p_client_action_id);
  return jsonb_build_object('deposit_id', dep.id, 'status', case when p_decision = 'confirm' then 'confirmed' else 'disputed' end,
                            'handover_id', ho, 'replayed', false);
end;
$$;

-- The other half of "one record per handover", for rows written by hand.
create or replace function public.guard_manual_rider_handover()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('deligro.deposit_confirm', true), '') = 'on' then
    return new;
  end if;
  if new.leg::text in ('rider_to_manager', 'rider_to_owner') and new.from_user is not null
     and exists (select 1 from public.cash_deposits d
                  where d.driver_id = new.from_user
                    and d.status in ('submitted', 'confirmed')
                    and (d.created_at at time zone 'Asia/Kolkata')::date = new.handover_date) then
    raise exception 'deposit_exists' using errcode = '23505';
  end if;
  -- A manager and the owner each writing down the same cash: the first one stands.
  -- A manager's own row may leave from_user empty, and then whoever wrote it gave it.
  if exists (select 1 from public.cod_handovers h
              where coalesce(h.from_user, h.recorded_by) = coalesce(new.from_user, new.recorded_by)
                and h.handover_date = new.handover_date
                and h.amount = new.amount
                and h.recorded_by <> new.recorded_by
                and (h.leg::text = 'manager_to_owner') = (new.leg::text = 'manager_to_owner')) then
    raise exception 'handover_exists' using errcode = '23505';
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- The owner records cash received, and confirms a manager's handover
-- ------------------------------------------------------------
create or replace function public.ops_record_cash_received(
  p_actor uuid, p_from uuid, p_kind text, p_amount integer, p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone uuid;
  ho   uuid;
  leg_name text;
  v_note constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin')
     or not exists (select 1 from public.profiles p where p.id = p_actor and p.role::text = 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('replayed', true);
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  if p_kind = 'rider' then
    zone := public.ops_require_staff_for_rider(p_actor, p_from);
    leg_name := 'rider_to_owner';
  elsif p_kind = 'manager' then
    if not exists (select 1 from public.profiles p where p.id = p_from and p.role::text = 'manager') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    select sz.zone_id into zone from public.staff_zones sz where sz.user_id = p_from order by sz.zone_id limit 1;
    leg_name := 'manager_to_owner';
  else
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, v_note);
  insert into public.cod_handovers (leg, from_user, to_user, amount, handover_date, note, recorded_by, confirmed_by, confirmed_at, zone_id)
  values (leg_name::public.cash_handover_leg, p_from, p_actor, p_amount,
          (now() at time zone 'Asia/Kolkata')::date, v_note, p_actor, p_actor, now(), zone)
  returning id into ho;
  perform public._ops_log(
    p_actor, 'cash.received', 'cash_handover', ho::text, zone, v_note, null,
    jsonb_build_object('leg', leg_name, 'amount', p_amount, 'from', p_from), p_client_action_id);
  return jsonb_build_object('handover_id', ho, 'replayed', false);
end;
$$;

create or replace function public.ops_confirm_manager_handover(
  p_actor uuid, p_handover uuid, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ho public.cod_handovers%rowtype;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin')
     or not exists (select 1 from public.profiles p where p.id = p_actor and p.role::text = 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ho from public.cod_handovers where id = p_handover for update;
  if ho.id is null or ho.leg::text <> 'manager_to_owner' then
    raise exception 'not_found' using errcode = '42501';
  end if;
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('handover_id', ho.id, 'replayed', true);
  end if;
  if ho.confirmed_by is not null then
    raise exception 'already_confirmed' using errcode = '22023';
  end if;
  perform public._ops_set_actor(p_actor, null);
  update public.cod_handovers
     set confirmed_by = p_actor, confirmed_at = now(), to_user = coalesce(to_user, p_actor)
   where id = p_handover;
  perform public._ops_log(
    p_actor, 'cash.handover.confirm', 'cash_handover', ho.id::text, ho.zone_id, null,
    jsonb_build_object('confirmed_by', null),
    jsonb_build_object('confirmed_by', p_actor, 'amount', ho.amount), p_client_action_id);
  return jsonb_build_object('handover_id', ho.id, 'replayed', false);
end;
$$;

revoke execute on function public.ops_record_cash_received(uuid, uuid, text, integer, text, text) from public, anon, authenticated;
revoke execute on function public.ops_confirm_manager_handover(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_record_cash_received(uuid, uuid, text, integer, text, text) to service_role;
grant execute on function public.ops_confirm_manager_handover(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- The figures: cash a rider gave the owner is off what the rider holds
-- ------------------------------------------------------------
create or replace function public.ops_rider_cash_position(p_rider uuid, p_today date)
returns jsonb
language sql stable security definer set search_path = public as $$
  with collected as (
    select coalesce(sum(d.cod_collected_amount), 0)::int as total,
           coalesce(sum(d.cod_collected_amount) filter (
             where (d.cod_collected_at at time zone 'Asia/Kolkata')::date = p_today), 0)::int as today
      from public.deliveries d
     where d.driver_id = p_rider and d.cod_collected_amount is not null
  ), deposited as (
    select coalesce(sum(h.amount), 0)::int as total,
           coalesce(sum(h.amount) filter (where h.handover_date = p_today), 0)::int as today
      from public.cod_handovers h
     where h.leg::text in ('rider_to_manager', 'rider_to_owner') and h.from_user = p_rider
  )
  select jsonb_build_object(
    'collected_today', c.today,
    'deposited_today', d.today,
    'collected_total', c.total,
    'deposited_total', d.total,
    'pending_deposit', greatest(c.total - d.total, 0))
    from collected c, deposited d;
$$;

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
     where h.leg::text in ('rider_to_manager', 'rider_to_owner') and h.from_user is not null
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
        select coalesce(h.to_user, h.recorded_by) as manager_id, h.handover_date as day, h.amount as received, 0 as handed_on
          from public.cod_handovers h
         where h.leg::text = 'rider_to_manager'
           and h.handover_date between p_from and p_to and (p_zone_ids is null or h.zone_id = any (p_zone_ids))
        union all
        select coalesce(h.from_user, h.recorded_by), h.handover_date, 0, h.amount
          from public.cod_handovers h
         where h.leg::text = 'manager_to_owner'
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

commit;
