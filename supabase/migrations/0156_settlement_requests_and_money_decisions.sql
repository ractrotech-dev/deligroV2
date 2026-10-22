-- ============================================================
-- 0156 — Vendor settlements through maker–checker; audited settlement voids
--        and refund decisions
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database from this branch.
-- Order: after 0155.
--
-- Phase 6 (§7 "Managers should only initiate or approve payments if their
-- permissions allow it. Payment execution and financial adjustments must be
-- protected by role-based authorization.").
--
-- 1. **No one-person vendor payment.** A vendor settlement is paid only
--    through 0152's payment_requests: one person (the maker — a manager with
--    manager.finance.initiate_payment, or an admin) puts a DRAFT settlement up
--    for approval; a different person (a manager with
--    manager.finance.approve_payment, or an admin) approves it with the
--    transaction reference, which marks the settlement paid. There is no
--    admin "mark paid" RPC: admins pay vendors the same way they pay riders
--    (0152 took record_rider_payout away from everyone). An admin may approve
--    someone else's request, never their own.
--
--    The same-person rule lives in ONE helper, _payment_maker_checker(), which
--    every decision path calls, so any later change to who may self-approve
--    (if one is ever made) is made in one place.
--
-- 2. ops_decide_payment_request is re-declared with the vendor_settlement
--    branch filled in. The rider branch is 0152's body unchanged.
--      approve → the draft's net_payable is compared with the request amount;
--                a changed draft answers amount_changed (detail = the new
--                figure) until the approver confirms it; negative or zero net
--                is refused; the settlement becomes paid (paid_by = the
--                approver, payment_ref = the reference) in the same
--                transaction as the request and the audit row.
--      reject / cancel → the draft is voided (its lines deleted so its orders
--                can be settled again; any correction it had absorbed goes
--                back to outstanding — voidSettlement's rules).
--
-- 3. A draft that a refund made stale (the server's refund comparison) is
--    rebuilt without losing the request or its maker: ops_detach_stale_settlement
--    voids the old draft and leaves the request pending with no settlement;
--    the server rebuilds a draft for the same period; ops_repoint_settlement_request
--    attaches it with its new amount (or cancels the request when nothing is
--    left to pay). Approval is refused (`rebuilding`) in between.
--
-- 4. ops_void_settlement — the audited void: admins void a draft or reverse a
--    paid INSTANT payout (never a paid batch: the money has left, record a
--    correction instead); a manager may void only a draft they built that is
--    not up for approval. A reason is required.
--
-- 5. ops_decide_refund — the decision, decided_by, decided_at, the gateway's
--    refund id when there is one, and the audit row, in one transaction,
--    zone-checked on the order. The gateway call itself happens in the server
--    BEFORE this, exactly as decideRefund always worked: money moves only if
--    the decision can then be recorded, and a failed gateway call leaves the
--    refund pending. The admin's direct UPDATE policy on refunds (0001) is
--    dropped: every decision now goes through this function.
--
-- Rollback:
--   drop function if exists public.ops_request_vendor_settlement(uuid, uuid, text, text, text);
--   drop function if exists public.ops_detach_stale_settlement(uuid, uuid, text);
--   drop function if exists public.ops_repoint_settlement_request(uuid, uuid, uuid, text);
--   drop function if exists public.ops_void_settlement(uuid, uuid, text, text);
--   drop function if exists public.ops_decide_refund(uuid, uuid, text, text, text, timestamptz, text);
--   drop function if exists public._void_settlement_draft(uuid, uuid);
--   -- then re-run 0152's ops_decide_payment_request and _payment_request_state
--   alter table public.payment_requests drop constraint if exists payment_requests_settlement_shape;
--   alter table public.payment_requests drop column if exists settlement_id;
--   alter table public.refunds drop column if exists decided_at;
--   create policy "refunds — admin decide" on public.refunds for update using (public.is_admin()) with check (public.is_admin());
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1 — Columns
-- ------------------------------------------------------------
alter table public.payment_requests
  add column if not exists settlement_id uuid references public.vendor_settlements (id) on delete restrict;

-- A rider payout never names a settlement. A vendor request names one, except
-- while it is pending and its stale draft is being rebuilt (detach → repoint),
-- or once it was cancelled during that rebuild.
alter table public.payment_requests drop constraint if exists payment_requests_settlement_shape;
alter table public.payment_requests add constraint payment_requests_settlement_shape check (
  (kind = 'vendor_settlement' or settlement_id is null)
  and (kind <> 'vendor_settlement' or settlement_id is not null or status in ('pending_approval', 'cancelled'))
);
create index if not exists payment_requests_settlement_idx on public.payment_requests (settlement_id);

alter table public.refunds add column if not exists decided_at timestamptz;

-- Every refund decision goes through ops_decide_refund (audited).
drop policy if exists "refunds — admin decide" on public.refunds;

-- ------------------------------------------------------------
-- 2 — Helpers (nobody signed in, not even the service role, calls these)
-- ------------------------------------------------------------

-- The maker–checker rule is 0152's _payment_maker_checker() (incl. the
-- one-admin switch); every decision path below calls it — no second copy.

-- voidSettlement()'s effect, in SQL: lines deleted (orders free to settle
-- again), header void, absorbed corrections back to outstanding.
create or replace function public._void_settlement_draft(p_settlement uuid, p_actor uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.vendor_settlement_orders where settlement_id = p_settlement;
  update public.vendor_settlements
     set status = 'void', voided_at = now(), voided_by = p_actor
   where id = p_settlement and status <> 'void';
  update public.settlement_corrections
     set status = 'outstanding', applied_settlement_id = null, applied_at = null
   where applied_settlement_id = p_settlement;
end;
$$;
revoke execute on function public._void_settlement_draft(uuid, uuid) from public, anon, authenticated, service_role;

-- 0152's state, plus the settlement a vendor request is for.
create or replace function public._payment_request_state(p_request uuid, p_replayed boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'request_id', r.id, 'kind', r.kind, 'status', r.status, 'amount', r.amount,
    'subject_id', r.subject_id, 'result_id', r.result_id, 'self_approved', r.self_approved,
    'settlement_id', r.settlement_id,
    'replayed', coalesce(p_replayed, false))
    from public.payment_requests r where r.id = p_request;
$$;
revoke execute on function public._payment_request_state(uuid, boolean) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3 — Request a vendor settlement
-- ------------------------------------------------------------
create or replace function public.ops_request_vendor_settlement(
  p_actor uuid, p_settlement uuid, p_method text, p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s       public.vendor_settlements%rowtype;
  zone    uuid;
  role_n  text;
  req     uuid;
  v_note  constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into s from public.vendor_settlements where id = p_settlement for update;
  if s.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select r.zone_id into zone from public.restaurants r where r.id = s.restaurant_id;
  role_n := public.ops_require_staff(p_actor, zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['payment.request'], null);
    return public._payment_request_state((select id from public.payment_requests where client_action_id = p_client_action_id), true);
  end if;
  -- A manager puts up only a draft they built; an admin, any draft.
  if role_n <> 'admin' and s.created_by is distinct from p_actor then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if s.status::text <> 'draft' then
    raise exception 'not_draft' using errcode = '22023';
  end if;
  if p_method is null or p_method not in ('bank', 'upi', 'cash', 'other') then
    raise exception 'invalid_method' using errcode = '22023';
  end if;
  if s.net_payable < 0 then
    raise exception 'negative_net' using errcode = '22023', detail = s.net_payable::text;
  end if;
  if s.net_payable = 0 then
    raise exception 'nothing_to_pay' using errcode = '22023';
  end if;
  if exists (select 1 from public.payment_requests
              where kind = 'vendor_settlement' and subject_id = s.restaurant_id and status = 'pending_approval') then
    raise exception 'duplicate_pending' using errcode = '23505';
  end if;

  perform public._ops_set_actor(p_actor, v_note);
  insert into public.payment_requests
    (kind, subject_id, zone_id, amount, period_end, method, note, requested_by, client_action_id, settlement_id)
  values
    ('vendor_settlement', s.restaurant_id, zone, s.net_payable,
     ((s.period_end at time zone 'Asia/Kolkata')::date - 1), p_method, v_note, p_actor, p_client_action_id, s.id)
  returning id into req;
  perform public._ops_log(
    p_actor, 'payment.request', 'payment_request', req::text, zone, v_note, null,
    jsonb_build_object('kind', 'vendor_settlement', 'restaurantId', s.restaurant_id, 'settlementId', s.id,
                       'amount', s.net_payable, 'method', p_method),
    p_client_action_id);
  return public._payment_request_state(req, false);
end;
$$;

-- ------------------------------------------------------------
-- 4 — Decide (0152's current body incl. replay match, single-admin rule and
--     the approved-amount payout; vendor branch added)
-- ------------------------------------------------------------
create or replace function public.ops_decide_payment_request(
  p_actor uuid, p_request uuid, p_decision text, p_reference text, p_paid_on date, p_confirm_amount numeric,
  p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r       public.payment_requests%rowtype;
  s       public.vendor_settlements%rowtype;
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
    if r.kind = 'vendor_settlement' and r.settlement_id is not null then
      perform public._void_settlement_draft(r.settlement_id, p_actor);
    end if;
    update public.payment_requests
       set status = 'cancelled', decided_at = now(), decision_note = v_note
     where id = p_request;
    perform public._ops_log(p_actor, 'payment.cancel', 'payment_request', p_request::text, r.zone_id, v_note,
                            jsonb_build_object('status', r.status, 'settlementId', r.settlement_id),
                            jsonb_build_object('status', 'cancelled'),
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
    if r.kind = 'vendor_settlement' and r.settlement_id is not null then
      perform public._void_settlement_draft(r.settlement_id, p_actor);
    end if;
    update public.payment_requests
       set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_note = v_note
     where id = p_request;
    perform public._ops_log(p_actor, 'payment.reject', 'payment_request', p_request::text, r.zone_id, v_note,
                            jsonb_build_object('status', r.status, 'settlementId', r.settlement_id),
                            jsonb_build_object('status', 'rejected'),
                            p_client_action_id);
    return public._payment_request_state(p_request, false);
  end if;

  -- approve
  if v_ref is null then
    raise exception 'reference_required' using errcode = '22023';
  end if;
  paid := coalesce(p_paid_on, (now() at time zone 'Asia/Kolkata')::date);

  if r.kind = 'vendor_settlement' then
    if r.settlement_id is null then
      raise exception 'rebuilding' using errcode = '40001';
    end if;
    select * into s from public.vendor_settlements where id = r.settlement_id for update;
    if s.id is null or s.status::text <> 'draft' then
      raise exception 'not_draft' using errcode = '22023';
    end if;
    fresh := s.net_payable;
    if fresh < 0 then
      raise exception 'negative_net' using errcode = '22023', detail = fresh::text;
    end if;
    if fresh = 0 then
      raise exception 'nothing_to_pay' using errcode = '22023';
    end if;
    if fresh <> r.amount and (p_confirm_amount is null or round(p_confirm_amount, 2) <> fresh) then
      -- Settlement money is whole rupees.
      raise exception 'amount_changed' using errcode = '40001', detail = s.net_payable::text;
    end if;

    perform public._ops_set_actor(p_actor, v_note);
    update public.vendor_settlements
       set status = 'paid', paid_at = now(), paid_by = p_actor, payment_ref = v_ref
     where id = s.id and status = 'draft';
    update public.payment_requests
       set status = 'approved', decided_by = p_actor, decided_at = now(), decision_note = v_note,
           reference = v_ref, paid_on = paid, result_id = s.id, amount = fresh, self_approved = self
     where id = p_request;
    perform public._ops_log(
      p_actor, 'payment.approve', 'payment_request', p_request::text, r.zone_id, v_note,
      jsonb_build_object('status', r.status, 'amount', r.amount, 'settlementStatus', 'draft'),
      jsonb_build_object('status', 'approved', 'amount', fresh, 'settlementId', s.id, 'reference', v_ref, 'paidOn', paid,
                         'self_approved', self),
      p_client_action_id);
    return public._payment_request_state(p_request, false);
  end if;

  -- rider_payout: 0152 unchanged
  perform 1 from public.profiles where id = r.subject_id for update;
  fresh := public._rider_payout_preview(r.subject_id, r.period_end) + coalesce(r.salary_amount, 0);
  if fresh <= 0 then
    raise exception 'nothing_to_pay' using errcode = '22023';
  end if;
  if fresh <> r.amount and (p_confirm_amount is null or round(p_confirm_amount, 2) <> fresh) then
    raise exception 'amount_changed' using errcode = '40001', detail = fresh::text;
  end if;

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

-- ------------------------------------------------------------
-- 5 — Rebuilding a stale draft under a pending request
-- ------------------------------------------------------------
create or replace function public.ops_detach_stale_settlement(p_actor uuid, p_request uuid, p_client_action_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r        public.payment_requests%rowtype;
  s        public.vendor_settlements%rowtype;
  v_orders jsonb;
begin
  select * into r from public.payment_requests where id = p_request for update;
  if r.id is null or r.kind <> 'vendor_settlement' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, r.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['payment.detach'], p_request::text);
    select * into s from public.vendor_settlements
     where id = (select (after ->> 'settlementId')::uuid from public.ops_audit_log where client_action_id = p_client_action_id);
    return jsonb_build_object('request_id', r.id, 'restaurant_id', r.subject_id, 'settlement_id', s.id,
      'kind', s.kind, 'period_start', s.period_start, 'period_end', s.period_end, 'replayed', true);
  end if;
  if r.status <> 'pending_approval' then
    raise exception 'already_decided' using errcode = '22023';
  end if;
  if r.settlement_id is null then
    raise exception 'rebuilding' using errcode = '40001';
  end if;
  select * into s from public.vendor_settlements where id = r.settlement_id for update;
  if s.status::text <> 'draft' then
    raise exception 'not_draft' using errcode = '22023';
  end if;

  -- The orders the draft covered, kept on the audit row: a rebuild that stops
  -- half-way can be finished from it (a one-order draft's line is gone once void).
  select coalesce(jsonb_agg(order_id), '[]'::jsonb) into v_orders
    from public.vendor_settlement_orders where settlement_id = s.id;
  perform public._ops_set_actor(p_actor, 'A refund made the draft out of date');
  perform public._void_settlement_draft(s.id, p_actor);
  update public.payment_requests set settlement_id = null where id = p_request;
  perform public._ops_log(
    p_actor, 'payment.detach', 'payment_request', p_request::text, r.zone_id, 'A refund made the draft out of date',
    jsonb_build_object('settlementId', s.id, 'amount', r.amount),
    jsonb_build_object('settlementId', s.id, 'settlementStatus', 'void', 'kind', s.kind, 'orderIds', v_orders),
    p_client_action_id);
  return jsonb_build_object('request_id', r.id, 'restaurant_id', r.subject_id, 'settlement_id', s.id,
    'kind', s.kind, 'period_start', s.period_start, 'period_end', s.period_end, 'replayed', false);
end;
$$;

create or replace function public.ops_repoint_settlement_request(
  p_actor uuid, p_request uuid, p_new_settlement uuid, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.payment_requests%rowtype;
  s public.vendor_settlements%rowtype;
begin
  select * into r from public.payment_requests where id = p_request for update;
  if r.id is null or r.kind <> 'vendor_settlement' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, r.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['payment.repoint'], p_request::text);
    return public._payment_request_state(p_request, true);
  end if;
  if r.status <> 'pending_approval' then
    raise exception 'already_decided' using errcode = '22023';
  end if;
  if r.settlement_id is not null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  select * into s from public.vendor_settlements where id = p_new_settlement for update;
  if s.id is null or s.restaurant_id <> r.subject_id or s.status::text <> 'draft' then
    raise exception 'invalid_settlement' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, 'Rebuilt after a refund');
  if s.net_payable <= 0 then
    -- Nothing left to pay once the refund is counted: no request stands.
    perform public._void_settlement_draft(s.id, p_actor);
    update public.payment_requests
       set status = 'cancelled', decided_at = now(), decision_note = 'Nothing left to pay after a refund'
     where id = p_request;
    perform public._ops_log(
      p_actor, 'payment.repoint', 'payment_request', p_request::text, r.zone_id, 'Nothing left to pay after a refund',
      jsonb_build_object('amount', r.amount), jsonb_build_object('status', 'cancelled', 'net', s.net_payable),
      p_client_action_id);
    return public._payment_request_state(p_request, false);
  end if;
  update public.payment_requests set settlement_id = s.id, amount = s.net_payable where id = p_request;
  perform public._ops_log(
    p_actor, 'payment.repoint', 'payment_request', p_request::text, r.zone_id, 'Rebuilt after a refund',
    jsonb_build_object('amount', r.amount),
    jsonb_build_object('amount', s.net_payable, 'settlementId', s.id),
    p_client_action_id);
  return public._payment_request_state(p_request, false);
end;
$$;

-- ------------------------------------------------------------
-- 6 — Void a settlement (audited)
-- ------------------------------------------------------------
create or replace function public.ops_void_settlement(p_actor uuid, p_settlement uuid, p_reason text, p_client_action_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s       public.vendor_settlements%rowtype;
  zone    uuid;
  role_n  text;
  pending uuid;
  v_reason constant text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into s from public.vendor_settlements where id = p_settlement for update;
  if s.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select r.zone_id into zone from public.restaurants r where r.id = s.restaurant_id;
  role_n := public.ops_require_staff(p_actor, zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['settlement.void'], s.id::text);
    return jsonb_build_object('settlement_id', s.id, 'status', s.status, 'was_paid', false, 'replayed', true);
  end if;
  if s.status::text = 'void' then
    raise exception 'already_void' using errcode = '22023';
  end if;
  if s.status::text = 'paid' and s.kind::text = 'batch' then
    raise exception 'paid_batch' using errcode = '22023';
  end if;
  select id into pending from public.payment_requests
   where settlement_id = s.id and status = 'pending_approval';
  if role_n <> 'admin' and (s.status::text <> 'draft' or s.created_by is distinct from p_actor or pending is not null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, v_reason);
  if pending is not null then
    update public.payment_requests
       set status = 'cancelled', decided_at = now(), decision_note = 'Settlement voided: ' || v_reason
     where id = pending;
  end if;
  perform public._void_settlement_draft(s.id, p_actor);
  perform public._ops_log(
    p_actor, 'settlement.void', 'vendor_settlement', s.id::text, zone, v_reason,
    jsonb_build_object('status', s.status, 'kind', s.kind, 'netPayable', s.net_payable, 'requestId', pending),
    jsonb_build_object('status', 'void'),
    p_client_action_id);
  return jsonb_build_object('settlement_id', s.id, 'status', 'void', 'was_paid', s.status::text = 'paid',
    'restaurant_id', s.restaurant_id, 'net_payable', s.net_payable, 'replayed', false);
end;
$$;

-- ------------------------------------------------------------
-- 7 — Refund decisions (audited)
-- ------------------------------------------------------------
create or replace function public.ops_decide_refund(
  p_actor uuid, p_refund uuid, p_decision text, p_reason text,
  p_provider_refund_id text, p_settled_at timestamptz, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  f        public.refunds%rowtype;
  zone     uuid;
  target   public.refund_status;
  v_reason constant text := nullif(trim(coalesce(p_reason, '')), '');
  v_gw     constant text := nullif(trim(coalesce(p_provider_refund_id, '')), '');
begin
  select * into f from public.refunds where id = p_refund for update;
  if f.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select o.zone_id into zone from public.orders o where o.id = f.order_id;
  perform public.ops_require_staff(p_actor, zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['refund.approve', 'refund.deny', 'refund.approved', 'refund.denied'], f.id::text);
    return jsonb_build_object('refund_id', f.id, 'order_id', f.order_id, 'status', f.status, 'replayed', true);
  end if;
  if f.status::text <> 'pending' then
    raise exception 'already_decided' using errcode = '22023';
  end if;
  if p_decision not in ('approve', 'deny') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  target := case when p_decision = 'approve' then 'approved' else 'denied' end;

  perform public._ops_set_actor(p_actor, v_reason);
  update public.refunds
     set status = target, decided_by = p_actor, decided_at = now(),
         provider_refund_id = case when target = 'approved' and v_gw is not null then v_gw else provider_refund_id end,
         settled_at = case when target = 'approved' and v_gw is not null then p_settled_at else settled_at end
   where id = f.id and status = 'pending';
  perform public._ops_log(
    p_actor, 'refund.' || p_decision, 'refund', f.id::text, zone, v_reason,
    jsonb_build_object('status', f.status, 'amount', f.amount),
    jsonb_build_object('status', target, 'amount', f.amount, 'providerRefundId', v_gw),
    p_client_action_id);
  return jsonb_build_object('refund_id', f.id, 'order_id', f.order_id, 'status', target, 'replayed', false);
end;
$$;

revoke execute on function public.ops_request_vendor_settlement(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_decide_payment_request(uuid, uuid, text, text, date, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.ops_detach_stale_settlement(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.ops_repoint_settlement_request(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.ops_void_settlement(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_decide_refund(uuid, uuid, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ops_request_vendor_settlement(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_decide_payment_request(uuid, uuid, text, text, date, numeric, text, text) to service_role;
grant execute on function public.ops_detach_stale_settlement(uuid, uuid, text) to service_role;
grant execute on function public.ops_repoint_settlement_request(uuid, uuid, uuid, text) to service_role;
grant execute on function public.ops_void_settlement(uuid, uuid, text, text) to service_role;
grant execute on function public.ops_decide_refund(uuid, uuid, text, text, text, timestamptz, text) to service_role;

commit;
