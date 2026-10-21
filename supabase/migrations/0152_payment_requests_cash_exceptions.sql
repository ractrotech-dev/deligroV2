-- 0152 — Maker–checker payment requests, and audited cash-deposit,
-- cash-dispute and delivery-exception decisions (§5.13, §5.14, §7 payment
-- protection; the exception decisions Phase 3 deferred).
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0152.mjs); run it on staging first.
-- Depends on 0047 (cod_handovers), 0081 (delivery_events), 0082
-- (delivery_exceptions), 0141 (_ops_log, manager_can_see_zone, cod_handovers.zone_id),
-- 0142 (ops_require_staff, _ops_replayed, _ops_set_actor), 0150 (rider ledger,
-- record_rider_payout, cash_deposits, cash_disputes), 0151 (ops_require_staff_for_rider).
-- Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-5-riders.md (S5).
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * payment_requests: the person who requests a payment can never decide it
--     (CHECK decided_by <> requested_by, and the RPC answers same_person — for
--     admins too). Approving needs a transaction reference. Readable by admins
--     and the zone's managers; no write policy, writes revoked from
--     anon/authenticated.
--   * Approval re-computes the amount inside the transaction; a changed amount is
--     refused (amount_changed) until the approver confirms the new figure.
--   * record_rider_payout keeps its signature and admin-only rule; the payout
--     arithmetic moves to _record_rider_payout (not executable by anyone) so the
--     maker–checker path and the admin path cannot compute differently.
--   * Deposit, dispute and exception decisions are one RPC each with their audit
--     row; zone re-checked in the database.
--
-- Rollback:
--   drop function if exists public.ops_decide_delivery_exception(uuid, uuid, text, text, text);
--   drop function if exists public.ops_resolve_cash_dispute(uuid, uuid, text, text);
--   drop function if exists public.ops_decide_cash_deposit(uuid, uuid, text, text, uuid, text);
--   drop function if exists public.ops_decide_payment_request(uuid, uuid, text, text, date, numeric, text, text);
--   drop function if exists public.ops_request_rider_payout(uuid, uuid, date, text, numeric, text, text);
--   drop function if exists public._payment_request_state(uuid, boolean);
--   drop function if exists public._rider_payout_preview(uuid, date);
--   then re-run 0150's record_rider_payout; drop function if exists public._record_rider_payout(uuid, uuid, date, text, text, date, text);
--   alter table public.rider_payouts drop column if exists request_id;
--   drop table if exists public.payment_requests;

begin;

-- ============================================================
-- 1 — payment_requests
-- ============================================================
create table if not exists public.payment_requests (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('rider_payout', 'vendor_settlement')),
  subject_id       uuid not null,
  zone_id          uuid references public.delivery_zones (id),
  amount           numeric(12,2) not null check (amount > 0),
  period_end       date,
  salary_amount    numeric(10,2) check (salary_amount is null or salary_amount > 0),
  method           text check (method in ('bank', 'upi', 'cash', 'other')),
  note             text,
  status           text not null default 'pending_approval'
                   check (status in ('pending_approval', 'approved', 'rejected', 'cancelled')),
  requested_by     uuid not null references public.profiles (id),
  requested_at     timestamptz not null default now(),
  decided_by       uuid references public.profiles (id),
  decided_at       timestamptz,
  decision_note    text,
  reference        text,
  paid_on          date,
  result_id        uuid,
  client_action_id text unique,
  constraint payment_requests_maker_checker check (decided_by is null or decided_by <> requested_by),
  constraint payment_requests_approved_ref check (status <> 'approved' or reference is not null)
);

comment on table public.payment_requests is
  'Maker–checker for money leaving Deligro: one person requests, a different person (with manager.finance.approve_payment, or an admin) approves with the transaction reference. Written only by the ops_* RPCs.';

create unique index if not exists payment_requests_one_pending_idx
  on public.payment_requests (kind, subject_id) where status = 'pending_approval';
create index if not exists payment_requests_zone_status_idx
  on public.payment_requests (zone_id, status, requested_at desc);

alter table public.payment_requests enable row level security;
drop policy if exists "payment_requests — staff read" on public.payment_requests;
create policy "payment_requests — staff read" on public.payment_requests for select
  using (public.is_admin() or public.manager_can_see_zone(zone_id));
revoke all on public.payment_requests from anon, authenticated;
grant select on public.payment_requests to authenticated;
grant select, insert, update, delete on public.payment_requests to service_role;

alter table public.rider_payouts
  add column if not exists request_id uuid references public.payment_requests (id) on delete set null;

-- ============================================================
-- 2 — One payout arithmetic for both paths
-- ============================================================

-- What a payout up to p_period_end would be, without writing anything.
create or replace function public._rider_payout_preview(p_driver uuid, p_period_end date)
returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount) from public.rider_earnings
                    where driver_id = p_driver and payout_id is null
                      and (earned_at at time zone 'Asia/Kolkata')::date <= p_period_end), 0)
       + coalesce((select sum(amount) from public.rider_incentive_awards
                    where driver_id = p_driver and payout_id is null
                      and (awarded_at at time zone 'Asia/Kolkata')::date <= p_period_end), 0)
       + coalesce((select sum(case when kind = 'deduction' then -amount else amount end)
                     from public.rider_adjustments
                    where driver_id = p_driver and payout_id is null and effective_on <= p_period_end), 0);
$$;
revoke execute on function public._rider_payout_preview(uuid, date) from public, anon, authenticated, service_role;

-- 0150's record_rider_payout body, with the actor explicit (created_by).
create or replace function public._record_rider_payout(
  p_actor uuid, p_driver uuid, p_period_end date, p_method text, p_reference text, p_paid_on date, p_note text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  net    numeric(12,2);
  payout uuid;
begin
  perform 1 from public.rider_earnings
   where driver_id = p_driver and payout_id is null
     and (earned_at at time zone 'Asia/Kolkata')::date <= p_period_end for update;
  perform 1 from public.rider_incentive_awards
   where driver_id = p_driver and payout_id is null
     and (awarded_at at time zone 'Asia/Kolkata')::date <= p_period_end for update;
  perform 1 from public.rider_adjustments
   where driver_id = p_driver and payout_id is null and effective_on <= p_period_end for update;

  net := public._rider_payout_preview(p_driver, p_period_end);
  if net <= 0 then
    raise exception 'nothing_to_pay' using errcode = '22023';
  end if;

  insert into public.rider_payouts (driver_id, period_end, amount, method, reference, paid_on, note, created_by)
  values (p_driver, p_period_end, net, p_method, nullif(trim(p_reference), ''), p_paid_on, nullif(trim(p_note), ''), p_actor)
  returning id into payout;

  update public.rider_earnings set payout_id = payout
   where driver_id = p_driver and payout_id is null
     and (earned_at at time zone 'Asia/Kolkata')::date <= p_period_end;
  update public.rider_incentive_awards set payout_id = payout
   where driver_id = p_driver and payout_id is null
     and (awarded_at at time zone 'Asia/Kolkata')::date <= p_period_end;
  update public.rider_adjustments set payout_id = payout
   where driver_id = p_driver and payout_id is null and effective_on <= p_period_end;

  return payout;
end;
$$;
revoke execute on function public._record_rider_payout(uuid, uuid, date, text, text, date, text)
  from public, anon, authenticated, service_role;

-- Same signature and behaviour as 0150: the admin console's direct path.
create or replace function public.record_rider_payout(
  p_driver uuid, p_period_end date, p_method text, p_reference text, p_paid_on date, p_note text
)
returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public._record_rider_payout(auth.uid(), p_driver, p_period_end, p_method, p_reference, p_paid_on, p_note);
end;
$$;
revoke execute on function public.record_rider_payout(uuid, date, text, text, date, text) from public, anon;
grant execute on function public.record_rider_payout(uuid, date, text, text, date, text) to authenticated, service_role;

create or replace function public._payment_request_state(p_request uuid, p_replayed boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'request_id', r.id, 'kind', r.kind, 'status', r.status, 'amount', r.amount,
    'subject_id', r.subject_id, 'result_id', r.result_id, 'replayed', coalesce(p_replayed, false))
    from public.payment_requests r where r.id = p_request;
$$;
revoke execute on function public._payment_request_state(uuid, boolean) from public, anon, authenticated, service_role;

-- ============================================================
-- 3 — Request and decide
-- ============================================================
create or replace function public.ops_request_rider_payout(
  p_actor uuid, p_rider uuid, p_period_end date, p_method text, p_salary numeric, p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone    uuid;
  preview numeric(12,2);
  total   numeric(12,2);
  req     uuid;
  v_note  constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  zone := public.ops_require_staff_for_rider(p_actor, p_rider);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._payment_request_state((select id from public.payment_requests where client_action_id = p_client_action_id), true);
  end if;
  if p_period_end is null or p_period_end > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'invalid_period' using errcode = '22023';
  end if;
  if p_method is null or p_method not in ('bank', 'upi', 'cash', 'other') then
    raise exception 'invalid_method' using errcode = '22023';
  end if;
  if p_salary is not null and (p_salary <= 0 or p_salary > 1000000) then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  perform 1 from public.profiles where id = p_rider for update;
  if exists (select 1 from public.payment_requests
              where kind = 'rider_payout' and subject_id = p_rider and status = 'pending_approval') then
    raise exception 'duplicate_pending' using errcode = '23505';
  end if;
  preview := public._rider_payout_preview(p_rider, p_period_end);
  total := preview + coalesce(round(p_salary, 2), 0);
  if total <= 0 then
    raise exception 'nothing_to_pay' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, v_note);
  insert into public.payment_requests
    (kind, subject_id, zone_id, amount, period_end, salary_amount, method, note, requested_by, client_action_id)
  values
    ('rider_payout', p_rider, zone, total, p_period_end, round(p_salary, 2), p_method, v_note, p_actor, p_client_action_id)
  returning id into req;
  perform public._ops_log(
    p_actor, 'payment.request', 'payment_request', req::text, zone, v_note, null,
    jsonb_build_object('kind', 'rider_payout', 'riderId', p_rider, 'amount', total, 'salary', round(p_salary, 2),
                       'periodEnd', p_period_end, 'method', p_method),
    p_client_action_id);
  return public._payment_request_state(req, false);
end;
$$;

-- approve: someone other than the requester, with a reference; re-computes the
--          amount and refuses a changed one until it is confirmed; writes the
--          salary row (as the requester's), records the payout, links it.
-- reject:  someone other than the requester, with a note.
-- cancel:  only the requester, while pending.
create or replace function public.ops_decide_payment_request(
  p_actor uuid, p_request uuid, p_decision text, p_reference text, p_paid_on date, p_confirm_amount numeric,
  p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r       public.payment_requests%rowtype;
  fresh   numeric(12,2);
  payout  uuid;
  v_note  constant text := nullif(trim(coalesce(p_note, '')), '');
  v_ref   constant text := nullif(trim(coalesce(p_reference, '')), '');
  paid    date;
begin
  select * into r from public.payment_requests where id = p_request for update;
  if r.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, r.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._payment_request_state(p_request, true);
  end if;
  if r.status <> 'pending_approval' then
    raise exception 'already_decided' using errcode = '22023';
  end if;

  if p_decision = 'cancel' then
    if p_actor <> r.requested_by then
      raise exception 'not_requester' using errcode = '42501';
    end if;
    perform public._ops_set_actor(p_actor, v_note);
    update public.payment_requests
       set status = 'cancelled', decided_at = now(), decision_note = v_note
     where id = p_request;
    perform public._ops_log(p_actor, 'payment.cancel', 'payment_request', p_request::text, r.zone_id, v_note,
                            jsonb_build_object('status', r.status), jsonb_build_object('status', 'cancelled'),
                            p_client_action_id);
    return public._payment_request_state(p_request, false);
  end if;

  if p_decision not in ('approve', 'reject') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if p_actor = r.requested_by then
    raise exception 'same_person' using errcode = '42501';
  end if;

  if p_decision = 'reject' then
    if v_note is null or char_length(v_note) < 3 or char_length(v_note) > 500 then
      raise exception 'note_required' using errcode = '22023';
    end if;
    perform public._ops_set_actor(p_actor, v_note);
    update public.payment_requests
       set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_note = v_note
     where id = p_request;
    perform public._ops_log(p_actor, 'payment.reject', 'payment_request', p_request::text, r.zone_id, v_note,
                            jsonb_build_object('status', r.status), jsonb_build_object('status', 'rejected'),
                            p_client_action_id);
    return public._payment_request_state(p_request, false);
  end if;

  -- approve
  if r.kind <> 'rider_payout' then
    raise exception 'not_supported' using errcode = '0A000';
  end if;
  if v_ref is null then
    raise exception 'reference_required' using errcode = '22023';
  end if;
  perform 1 from public.profiles where id = r.subject_id for update;
  fresh := public._rider_payout_preview(r.subject_id, r.period_end) + coalesce(r.salary_amount, 0);
  if fresh <= 0 then
    raise exception 'nothing_to_pay' using errcode = '22023';
  end if;
  if fresh <> r.amount and (p_confirm_amount is null or round(p_confirm_amount, 2) <> fresh) then
    raise exception 'amount_changed' using errcode = '40001', detail = fresh::text;
  end if;
  paid := coalesce(p_paid_on, (now() at time zone 'Asia/Kolkata')::date);

  perform public._ops_set_actor(p_actor, v_note);
  if r.salary_amount is not null then
    insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by)
    values (r.subject_id, 'salary', r.salary_amount,
            coalesce(r.note, 'Salary up to ' || to_char(r.period_end, 'DD Mon YYYY')), r.period_end, r.requested_by);
  end if;
  payout := public._record_rider_payout(p_actor, r.subject_id, r.period_end, r.method, v_ref, paid, r.note);
  update public.rider_payouts set request_id = p_request where id = payout;
  update public.payment_requests
     set status = 'approved', decided_by = p_actor, decided_at = now(), decision_note = v_note,
         reference = v_ref, paid_on = paid, result_id = payout, amount = fresh
   where id = p_request;
  perform public._ops_log(
    p_actor, 'payment.approve', 'payment_request', p_request::text, r.zone_id, v_note,
    jsonb_build_object('status', r.status, 'amount', r.amount),
    jsonb_build_object('status', 'approved', 'amount', fresh, 'payoutId', payout, 'reference', v_ref, 'paidOn', paid),
    p_client_action_id);
  return public._payment_request_state(p_request, false);
end;
$$;

-- ============================================================
-- 4 — Cash deposits and disputes
-- ============================================================

-- confirm: writes the rider→manager cod_handovers leg (the one cash ledger,
--          0047) in a zone of the rider's that the actor holds, and links it.
-- dispute: needs a note the rider will read.
create or replace function public.ops_decide_cash_deposit(
  p_actor uuid, p_deposit uuid, p_decision text, p_note text, p_zone uuid, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  dep    public.cash_deposits%rowtype;
  zone   uuid;
  ho     uuid;
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

  perform public._ops_set_actor(p_actor, v_note);
  if p_decision = 'confirm' then
    insert into public.cod_handovers (leg, from_user, to_user, amount, handover_date, note, recorded_by, zone_id)
    values ('rider_to_manager', dep.driver_id, p_actor, dep.amount, (now() at time zone 'Asia/Kolkata')::date,
            coalesce(v_note, 'Deposit ' || dep.method || coalesce(' ' || dep.reference, '')), p_actor, zone)
    returning id into ho;
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

create or replace function public.ops_resolve_cash_dispute(
  p_actor uuid, p_dispute uuid, p_resolution text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  dis   public.cash_disputes%rowtype;
  zone  uuid;
  v_res constant text := trim(coalesce(p_resolution, ''));
begin
  select * into dis from public.cash_disputes where id = p_dispute for update;
  if dis.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  zone := public.ops_require_staff_for_rider(p_actor, dis.driver_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('dispute_id', dis.id, 'status', dis.status, 'replayed', true);
  end if;
  if char_length(v_res) < 3 or char_length(v_res) > 500 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if dis.status <> 'open' then
    raise exception 'already_resolved' using errcode = '22023';
  end if;
  perform public._ops_set_actor(p_actor, v_res);
  update public.cash_disputes
     set status = 'resolved', resolution = v_res, resolved_by = p_actor, resolved_at = now()
   where id = p_dispute;
  perform public._ops_log(
    p_actor, 'cash.dispute.resolve', 'cash_dispute', p_dispute::text, zone, v_res,
    jsonb_build_object('status', dis.status), jsonb_build_object('status', 'resolved'), p_client_action_id);
  return jsonb_build_object('dispute_id', dis.id, 'status', 'resolved', 'replayed', false);
end;
$$;

-- ============================================================
-- 5 — Delivery exceptions (0082's table)
-- Requests are approved or rejected, reports acknowledged (0082's
-- status-for-kind CHECK). The decision and its event and audit rows are one
-- transaction; what an approval MEANS (fail the delivery, cancel the order,
-- re-dispatch) runs in the server after commit, idempotently
-- (src/lib/data-access/delivery-exceptions.ts decideException).
-- ============================================================
create or replace function public.ops_decide_delivery_exception(
  p_actor uuid, p_exception uuid, p_decision text, p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ex      public.delivery_exceptions%rowtype;
  zone    uuid;
  report  boolean;
  target  text;
  v_note  constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into ex from public.delivery_exceptions where id = p_exception for update;
  if ex.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select o.zone_id into zone from public.orders o where o.id = ex.order_id;
  perform public.ops_require_staff(p_actor, zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('exception_id', ex.id, 'kind', ex.kind, 'delivery_id', ex.delivery_id,
                              'order_id', ex.order_id, 'driver_id', ex.driver_id, 'status', ex.status, 'replayed', true);
  end if;
  report := ex.kind in ('return_to_shop', 'missing_items', 'wrong_package', 'vendor_delay', 'other_issue');
  target := case
    when report     and p_decision = 'acknowledge' then 'acknowledged'
    when not report and p_decision = 'approve'     then 'approved'
    when not report and p_decision = 'reject'      then 'rejected'
  end;
  if target is null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if target = 'rejected' and (v_note is null or char_length(v_note) < 3) then
    raise exception 'note_required' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note_required' using errcode = '22023';
  end if;
  if ex.status <> 'pending' then
    raise exception 'already_resolved' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, v_note);
  update public.delivery_exceptions
     set status = target, decided_by = p_actor, decided_at = now(), decision_note = v_note
   where id = p_exception;
  insert into public.delivery_events (delivery_id, order_id, driver_id, kind, method, reason, actor_id)
  values (ex.delivery_id, ex.order_id, ex.driver_id, 'exception_decided', p_decision,
          ex.kind || coalesce(': ' || v_note, ''), p_actor);
  perform public._ops_log(
    p_actor, 'delivery.exception.' || p_decision, 'delivery_exception', p_exception::text, zone, v_note,
    jsonb_build_object('status', ex.status, 'kind', ex.kind, 'orderId', ex.order_id),
    jsonb_build_object('status', target, 'kind', ex.kind, 'orderId', ex.order_id),
    p_client_action_id);
  return jsonb_build_object('exception_id', ex.id, 'kind', ex.kind, 'delivery_id', ex.delivery_id,
                            'order_id', ex.order_id, 'driver_id', ex.driver_id, 'status', target, 'replayed', false);
end;
$$;

revoke execute on function public.ops_request_rider_payout(uuid, uuid, date, text, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.ops_decide_payment_request(uuid, uuid, text, text, date, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.ops_decide_cash_deposit(uuid, uuid, text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.ops_resolve_cash_dispute(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_decide_delivery_exception(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ops_request_rider_payout(uuid, uuid, date, text, numeric, text, text) to service_role;
grant execute on function public.ops_decide_payment_request(uuid, uuid, text, text, date, numeric, text, text) to service_role;
grant execute on function public.ops_decide_cash_deposit(uuid, uuid, text, text, uuid, text) to service_role;
grant execute on function public.ops_resolve_cash_dispute(uuid, uuid, text, text) to service_role;
grant execute on function public.ops_decide_delivery_exception(uuid, uuid, text, text, text) to service_role;

commit;
