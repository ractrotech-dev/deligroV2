-- 0152 — Maker–checker payment requests, and audited cash-deposit,
-- cash-dispute and delivery-exception decisions (§5.13, §5.14, §7 payment
-- protection; the exception decisions Phase 3 deferred).
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0152.mjs); run it on staging first.
-- Depends on 0047 (cod_handovers), 0081 (delivery_events), 0082
-- (delivery_exceptions), 0141 (_ops_log, manager_can_see_zone, cod_handovers.zone_id),
-- 0142 (ops_require_staff, _ops_replayed, _ops_set_actor), 0083 (the rider
-- money ledger, guard_rider_ledger, record_rider_payout), 0150 (cash_deposits,
-- cash_disputes), 0151 (ops_require_staff_for_rider).
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
--   * The payout arithmetic is 0083's, copied into _record_rider_payout (not
--     executable by anyone) with the actor explicit — the same cutoff, award
--     dating and per-rider lock. 0083's record_rider_payout is revoked from
--     signed-in users: admins pay through payment_requests like everyone else
--     (approving another person's request, never their own).
--   * Deposit, dispute and exception decisions are one RPC each with their audit
--     row; zone re-checked in the database. An exception is approved only while
--     the job is where the rider asked (same rider, same assignment, a step
--     where the request means something — go_offline never after pickup) and,
--     for complete_without_code, only with the proof photo the rule wants:
--     `moved_on` / `photo_required` otherwise, the request left pending.
--   * One record per cash handover: a hand-written rider→manager leg on a day
--     the rider declared a deposit is refused (deposit_exists), and a deposit
--     is not confirmed over a hand-written leg for its day
--     (manual_handover_exists) — either would count the cash twice.
--   * Approval pays exactly the approved amount (_record_rider_payout's
--     p_expected), and a replayed id must be this action on this request.
--   * platform_settings.allow_single_admin_payments (default off): an admin —
--     never a manager — may then approve their own request, with a reason,
--     marked self_approved. Changed only through ops_set_single_admin_payments
--     (admin, reason, audited); a plain settings update cannot flip it.
--
-- Rollback:
--   drop function if exists public.ops_set_single_admin_payments(uuid, boolean, text, text);
--   drop trigger if exists guard_single_admin_payments on public.platform_settings;
--   drop function if exists public.guard_single_admin_payments();
--   drop function if exists public._payment_maker_checker(uuid, uuid, text, text);
--   alter table public.platform_settings drop column if exists allow_single_admin_payments;
--   drop trigger if exists guard_manual_rider_handover on public.cod_handovers;
--   drop function if exists public.guard_manual_rider_handover();
--   drop function if exists public.ops_decide_delivery_exception(uuid, uuid, text, text, text);
--   drop function if exists public.ops_resolve_cash_dispute(uuid, uuid, text, text);
--   drop function if exists public.ops_decide_cash_deposit(uuid, uuid, text, text, uuid, text);
--   drop function if exists public.ops_decide_payment_request(uuid, uuid, text, text, date, numeric, text, text);
--   drop function if exists public.ops_request_rider_payout(uuid, uuid, date, text, numeric, text, text);
--   drop function if exists public._payment_request_state(uuid, boolean);
--   drop function if exists public._rider_payout_preview(uuid, date);
--   grant execute on function public.record_rider_payout(uuid, date, text, text, date, text) to authenticated;  -- 0083's grant
--   drop function if exists public._record_rider_payout(uuid, uuid, date, text, text, date, text, numeric);
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
  -- An admin approved their own request while allow_single_admin_payments was
  -- on (section 5). The only way decided_by may equal requested_by.
  self_approved    boolean not null default false,
  constraint payment_requests_maker_checker check (decided_by is null or decided_by <> requested_by or self_approved),
  constraint payment_requests_self_approved check (
    not self_approved or (status = 'approved' and decided_by = requested_by)),
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
-- 2 — One payout arithmetic: Rider 0083's
-- ------------------------------------------------------------
-- 0083's record_rider_payout is the definition of what a payout covers: the
-- unpaid earnings before the first instant after p_period_end in IST, the
-- unpaid awards dated by the earning that reached the target (or, without
-- one, by when they were awarded), and the unpaid adjustments effective on
-- or before p_period_end. The preview and the maker–checker payout below use
-- exactly that selection — the preview is what approval compares against, so
-- a different selection would refuse valid requests as amount_changed.
--
-- record_rider_payout itself is NOT re-declared here (0083 owns it). It is
-- taken from signed-in users below: an admin paying alone is the one path
-- that skipped the second person, so admins pay through payment_requests too
-- (an admin may approve someone else's request, never their own).
-- ============================================================

-- What a payout up to p_period_end would be, without writing anything.
create or replace function public._rider_payout_preview(p_driver uuid, p_period_end date)
returns numeric
language sql stable security definer set search_path = public as $$
  with cutoff as (select ((p_period_end + 1)::timestamp at time zone 'Asia/Kolkata') as at)
  select coalesce((select sum(e.amount) from public.rider_earnings e, cutoff c
                    where e.driver_id = p_driver and e.payout_id is null and e.earned_at < c.at), 0)
       + coalesce((select sum(a.amount)
                     from public.rider_incentive_awards a
                     left join public.rider_earnings t on t.delivery_id = a.trigger_delivery_id
                     cross join cutoff c
                    where a.driver_id = p_driver and a.payout_id is null
                      and coalesce(t.earned_at, a.awarded_at) < c.at), 0)
       + coalesce((select sum(case when j.kind = 'deduction' then -j.amount else j.amount end)
                     from public.rider_adjustments j
                    where j.driver_id = p_driver and j.payout_id is null and j.effective_on <= p_period_end), 0);
$$;
revoke execute on function public._rider_payout_preview(uuid, date) from public, anon, authenticated, service_role;

-- 0083's record_rider_payout body, with the actor explicit (created_by) and
-- the admin check left to the callers (ops_decide_payment_request checks the
-- approver; nothing signed in can reach this function). p_expected is the
-- amount the checker approved: the rows are re-selected under their locks
-- here, and an earning committed after the approver's preview would otherwise
-- be paid on top of the approved figure.
drop function if exists public._record_rider_payout(uuid, uuid, date, text, text, date, text);
create or replace function public._record_rider_payout(
  p_actor uuid, p_driver uuid, p_period_end date, p_method text, p_reference text, p_paid_on date, p_note text,
  p_expected numeric default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  cutoff    timestamptz;
  earn_ids  uuid[];
  award_ids uuid[];
  adj_ids   uuid[];
  earn_sum  numeric;
  award_sum numeric;
  adj_sum   numeric;
  net       numeric;
  payout    uuid;
begin
  if p_actor is null or p_driver is null or p_period_end is null or p_paid_on is null then
    raise exception 'invalid_payout'
      using errcode = '22023', detail = 'actor, driver, period end and paid-on date are required';
  end if;

  -- The first instant AFTER p_period_end, IST.
  cutoff := (p_period_end + 1)::timestamp at time zone 'Asia/Kolkata';

  -- One payout per rider at a time; the row locks below are the floor.
  perform pg_advisory_xact_lock(hashtext('rider_payout'), hashtext(p_driver::text));

  select coalesce(array_agg(x.id), '{}'), coalesce(sum(x.amount), 0)
    into earn_ids, earn_sum
    from (select e.id, e.amount
            from public.rider_earnings e
           where e.driver_id = p_driver
             and e.payout_id is null
             and e.earned_at < cutoff
             for update) x;

  -- An award is dated by the earning that reached the target.
  select coalesce(array_agg(x.id), '{}'), coalesce(sum(x.amount), 0)
    into award_ids, award_sum
    from (select a.id, a.amount
            from public.rider_incentive_awards a
            left join public.rider_earnings t on t.delivery_id = a.trigger_delivery_id
           where a.driver_id = p_driver
             and a.payout_id is null
             and coalesce(t.earned_at, a.awarded_at) < cutoff
             for update of a) x;

  select coalesce(array_agg(x.id), '{}'),
         coalesce(sum(case when x.kind = 'deduction' then -x.amount else x.amount end), 0)
    into adj_ids, adj_sum
    from (select j.id, j.kind, j.amount
            from public.rider_adjustments j
           where j.driver_id = p_driver
             and j.payout_id is null
             and j.effective_on <= p_period_end
             for update) x;

  net := earn_sum + award_sum + adj_sum;
  if net <= 0 then
    raise exception 'nothing_to_pay'
      using errcode = '22023', detail = format('net payable up to %s is %s', p_period_end, net);
  end if;
  if p_expected is not null and net <> round(p_expected, 2) then
    raise exception 'amount_changed' using errcode = '40001', detail = net::text;
  end if;

  insert into public.rider_payouts
    (driver_id, period_end, amount, method, reference, paid_on, note, created_by)
  values
    (p_driver, p_period_end, net, p_method, nullif(btrim(p_reference), ''), p_paid_on,
     nullif(btrim(p_note), ''), p_actor)
  returning id into payout;

  update public.rider_earnings         set payout_id = payout where id = any (earn_ids);
  update public.rider_incentive_awards set payout_id = payout where id = any (award_ids);
  update public.rider_adjustments      set payout_id = payout where id = any (adj_ids);

  return payout;
end;
$$;
revoke execute on function public._record_rider_payout(uuid, uuid, date, text, text, date, text, numeric)
  from public, anon, authenticated, service_role;

-- 0083's admin-alone payout: nobody signed in runs it now.
revoke execute on function public.record_rider_payout(uuid, date, text, text, date, text)
  from public, anon, authenticated, service_role;

create or replace function public._payment_request_state(p_request uuid, p_replayed boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'request_id', r.id, 'kind', r.kind, 'status', r.status, 'amount', r.amount,
    'subject_id', r.subject_id, 'result_id', r.result_id, 'self_approved', r.self_approved,
    'replayed', coalesce(p_replayed, false))
    from public.payment_requests r where r.id = p_request;
$$;
revoke execute on function public._payment_request_state(uuid, boolean) from public, anon, authenticated, service_role;

-- _ops_replay_matches (0151) checks a replayed id was this action on this record.

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
    req := (select id from public.payment_requests
             where client_action_id = p_client_action_id and kind = 'rider_payout' and subject_id = p_rider);
    if req is null then
      raise exception 'client_action_id_conflict' using errcode = '23505';
    end if;
    return public._payment_request_state(req, true);
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
-- The maker–checker rule, in ONE place (0156 calls it too). Returns true when
-- the decision is an admin's self-approval under allow_single_admin_payments
-- (reason required); otherwise refuses the requester with same_person.
create or replace function public._payment_maker_checker(
  p_actor uuid, p_request uuid, p_decision text, p_note text
)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_note constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not exists (select 1 from public.payment_requests r where r.id = p_request and r.requested_by = p_actor) then
    return false;
  end if;
  -- The one exception (section 5): an admin, approving, while an admin has
  -- turned allow_single_admin_payments on — and never without a reason.
  if p_decision = 'approve'
     and coalesce((select s.allow_single_admin_payments from public.platform_settings s limit 1), false)
     and exists (select 1 from public.profiles p where p.id = p_actor and p.role = 'admin') then
    if v_note is null or char_length(v_note) < 3 or char_length(v_note) > 500 then
      raise exception 'reason_required' using errcode = '22023';
    end if;
    return true;
  end if;
  raise exception 'same_person' using errcode = '42501';
end;
$$;
revoke execute on function public._payment_maker_checker(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

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
  self    boolean := false;
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
    perform public._ops_replay_matches(p_client_action_id,
      array['payment.approve', 'payment.reject', 'payment.cancel'], p_request::text);
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
  self := public._payment_maker_checker(p_actor, p_request, p_decision, v_note);

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
  payout := public._record_rider_payout(p_actor, r.subject_id, r.period_end, r.method, v_ref, paid, r.note, fresh);
  update public.rider_payouts set request_id = p_request where id = payout;
  update public.payment_requests
     set status = 'approved', decided_by = p_actor, decided_at = now(), decision_note = v_note,
         reference = v_ref, paid_on = paid, result_id = payout, amount = fresh, self_approved = self
   where id = p_request;
  perform public._ops_log(
    p_actor, 'payment.approve', 'payment_request', p_request::text, r.zone_id, v_note,
    jsonb_build_object('status', r.status, 'amount', r.amount),
    jsonb_build_object('status', 'approved', 'amount', fresh, 'payoutId', payout, 'reference', v_ref, 'paidOn', paid,
                       'self_approved', self),
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
    -- One record per handover: a leg already written by hand for this rider on
    -- the deposit's day would be counted twice (0154's pending_deposit would
    -- understate what the rider still holds). Dispute the deposit instead.
    if exists (select 1 from public.cod_handovers h
                where h.leg = 'rider_to_manager' and h.from_user = dep.driver_id
                  and h.handover_date = (dep.created_at at time zone 'Asia/Kolkata')::date
                  and not exists (select 1 from public.cash_deposits d2 where d2.handover_id = h.id)) then
      raise exception 'manual_handover_exists' using errcode = '23505';
    end if;
    -- The cash went to the manager the rider named (or, unnamed, whoever
    -- confirms); recorded_by is always the confirmer. Dated the day the rider
    -- handed it over, which is the day they declared the deposit.
    perform set_config('deligro.deposit_confirm', 'on', true);
    insert into public.cod_handovers (leg, from_user, to_user, amount, handover_date, note, recorded_by, zone_id)
    values ('rider_to_manager', dep.driver_id, coalesce(dep.manager_id, p_actor), dep.amount,
            (dep.created_at at time zone 'Asia/Kolkata')::date,
            coalesce(v_note, 'Deposit ' || dep.method || coalesce(' ' || dep.reference, '')), p_actor, zone)
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

-- The other half of "one record per handover": a rider→manager leg written by
-- hand (the /manager/cash form) on a day the rider declared a deposit is
-- refused — confirm or dispute the deposit instead. Deposit confirmation sets
-- deligro.deposit_confirm for its own insert.
create or replace function public.guard_manual_rider_handover()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.leg = 'rider_to_manager' and new.from_user is not null
     and coalesce(current_setting('deligro.deposit_confirm', true), '') <> 'on'
     and exists (select 1 from public.cash_deposits d
                  where d.driver_id = new.from_user
                    and d.status in ('submitted', 'confirmed')
                    and (d.created_at at time zone 'Asia/Kolkata')::date = new.handover_date) then
    raise exception 'deposit_exists' using errcode = '23505';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_manual_rider_handover on public.cod_handovers;
create trigger guard_manual_rider_handover
  before insert on public.cod_handovers
  for each row execute function public.guard_manual_rider_handover();

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
  d       public.deliveries%rowtype;
  zone    uuid;
  report  boolean;
  target  text;
  live    boolean;
  rule    text;
  is_cod  boolean;
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

  -- An approval authorises something only for the job as it was when the
  -- rider asked (the Rider branch's rule, 0082 rule 11): the same rider, in the
  -- same assignment, at a step where the request still means something.
  -- Checked here, under the delivery's row lock, so a rider who moved on
  -- between the board's read and this call cannot be approved into a change.
  -- The request stays pending; ops reject it (the server closes it with the
  -- reason) and it leaves the queue.
  if target = 'approved' then
    select * into d from public.deliveries where id = ex.delivery_id for update;
    live := case
      when d.id is null then false
      -- go_offline: before pickup only — the job taken in this stint and not
      -- yet collected, or a bare offer. Never a picked-up delivery.
      when ex.kind = 'go_offline' then
        (d.driver_id = ex.driver_id and d.assigned_at is not null and ex.created_at >= d.assigned_at
          and d.status = 'assigned')
        or (d.driver_id is null and d.status = 'unassigned' and d.offered_driver_id = ex.driver_id)
      when d.driver_id is distinct from ex.driver_id or d.assigned_at is null
        or ex.created_at < d.assigned_at then false
      when ex.kind = 'manual_pickup'         then d.status = 'assigned'
      when ex.kind = 'complete_without_code' then d.status = 'picked_up'
      else d.status in ('assigned', 'picked_up')
    end;
    if not live then
      raise exception 'moved_on' using errcode = '22023',
        detail = format('the delivery is %s', coalesce(d.status::text, 'gone'));
    end if;

    -- The proof-photo rule (platform_settings.pod_photo_rule, 0082), as
    -- podPhotoRequired decides it for a completion through an exception.
    if ex.kind = 'complete_without_code' then
      select coalesce(s.pod_photo_rule, 'never') into rule from public.platform_settings s limit 1;
      select (coalesce(o.payment_status, '') not in ('paid', 'refunded'))
             and (o.payment_method is null or o.payment_method::text = 'cod')
        into is_cod from public.orders o where o.id = ex.order_id;
      if (rule = 'always' or rule = 'exceptions' or (rule = 'cod' and coalesce(is_cod, true)))
         and coalesce(d.pod_photo_path, ex.photo_path) is null then
        raise exception 'photo_required' using errcode = '22023';
      end if;
    end if;
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

-- ============================================================
-- 5 — One admin paying alone (owner switch, default off)
-- ------------------------------------------------------------
-- A business with a single admin and no second approver cannot pay anyone
-- under strict maker–checker. allow_single_admin_payments lets an ADMIN (never
-- a manager) approve their own request, with a mandatory reason; the request
-- and its audit row are marked self_approved. The switch itself changes only
-- through ops_set_single_admin_payments (admin, reason, audited): the settings
-- form's plain update cannot flip it.
-- ============================================================
alter table public.platform_settings
  add column if not exists allow_single_admin_payments boolean not null default false;
comment on column public.platform_settings.allow_single_admin_payments is
  'When true an admin may approve their own payment request (reason required, marked self_approved). Changed only through ops_set_single_admin_payments.';
-- platform_settings is column-allowlisted (0032): the admin form reads it signed in.
grant select (allow_single_admin_payments) on public.platform_settings to authenticated;

create or replace function public.guard_single_admin_payments()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.allow_single_admin_payments is distinct from old.allow_single_admin_payments
     and coalesce(current_setting('deligro.ops_settings', true), '') <> 'on' then
    raise exception 'use ops_set_single_admin_payments' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_single_admin_payments on public.platform_settings;
create trigger guard_single_admin_payments
  before update of allow_single_admin_payments on public.platform_settings
  for each row execute function public.guard_single_admin_payments();

create or replace function public.ops_set_single_admin_payments(
  p_actor uuid, p_enabled boolean, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  was      boolean;
  v_reason constant text := trim(coalesce(p_reason, ''));
begin
  perform public.ops_require_admin(p_actor);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['settings.single_admin_payments'], null);
    return jsonb_build_object('enabled',
      (select s.allow_single_admin_payments from public.platform_settings s limit 1), 'replayed', true);
  end if;
  if p_enabled is null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  select s.allow_single_admin_payments into was from public.platform_settings s limit 1 for update;

  perform public._ops_set_actor(p_actor, v_reason);
  perform set_config('deligro.ops_settings', 'on', true);
  update public.platform_settings set allow_single_admin_payments = p_enabled;
  perform set_config('deligro.ops_settings', '', true);
  perform public._ops_log(
    p_actor, 'settings.single_admin_payments', 'platform_settings', 'allow_single_admin_payments', null, v_reason,
    jsonb_build_object('enabled', coalesce(was, false)), jsonb_build_object('enabled', p_enabled), p_client_action_id);
  return jsonb_build_object('enabled', p_enabled, 'replayed', false);
end;
$$;
revoke execute on function public.ops_set_single_admin_payments(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.ops_set_single_admin_payments(uuid, boolean, text, text) to service_role;

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
