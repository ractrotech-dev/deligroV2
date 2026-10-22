-- ============================================================
-- 0085 — Rider cash: deposits, disputes, reminders and the two thresholds
-- STATUS: PENDING APPROVAL — not applied to any database. Staging first.
--         Requires 0047 (cod_handovers, deliveries.cod_collected_amount) and
--         0081 (rider app foundation).
-- ------------------------------------------------------------
-- Phase 5 of the rider app (plan: docs/superpowers/plans/
-- 2026-10-21-rider-app-phase-5-cash.md; design: docs/superpowers/specs/
-- 2026-10-21-rider-app-design.md, "Cash (§10)").
--
-- The cash a rider collects for Deligro (COD) is recorded on the delivery
-- (`cod_collected_amount`, 0047) and every handover up the chain on
-- `cod_handovers` (0047, append-only: a correction is a new row). This
-- migration adds the rider's side of the handover and what surrounds it:
--
--   1. `cash_deposits` — the rider DECLARES "I handed ₹X to the manager"
--      (cash or UPI, optionally naming the manager, a UPI reference and a
--      receipt photo). Nothing is deposited until a manager decides:
--        submitted -> confirmed   the manager confirms; the server writes the
--                                 `cod_handovers` row (rider_to_manager) and
--                                 links it here (`handover_id`). The handover
--                                 stays the single record of the money
--                                 moving; this row is the request that led
--                                 to it.
--        submitted -> disputed    the manager disagrees and must say why
--                                 (`decision_note`); the rider reads the note.
--        submitted -> withdrawn   the rider takes it back before a decision.
--      CHECKs tie the statuses to their evidence: a `confirmed` row needs its
--      `handover_id`, a `disputed` row needs its `decision_note`.
--   2. `cash_disputes` — "this day's figure is wrong" (a day, optionally the
--      amount the rider claims, a message). open -> resolved by a manager or
--      admin. Phase 7 links these into support tickets; until then they are
--      listed on the manager cash page and the admin cash ledger.
--   3. `cash_reminders` — one row per rider: when the last "you are holding
--      too much / too long" push went out, so the sweep sends at most one
--      every 6 hours.
--   4. `platform_settings.rider_cash_limit` (rupees, default 5000) and
--      `rider_cash_max_hours` (default 24): the thresholds past which the
--      rider's cash reads "over limit" / "held too long" and the reminder
--      fires. 0 switches that alert off.
--
-- THE DECISION IS ONE FUNCTION (ruling P5-R3, shared with the Manager branch's
-- 0152_payment_requests_cash_exceptions.sql, section 4). `ops_decide_cash_deposit`
-- (service role only) locks the deposit row, refuses a deposit that is not
-- `submitted` (already_decided), and in ONE transaction either disputes it
-- (note of 3-500 characters, note_required) or confirms it: it inserts the
-- `cod_handovers` row (rider_to_manager, from the rider, to the manager the
-- rider named or else the confirmer, recorded_by the confirmer, DATED TO THE
-- DEPOSIT'S IST DAY) and links it - so a half-finished confirmation cannot
-- leave a second handover behind, and a replayed or concurrent confirm finds
-- the row locked, then decided. A confirm over a rider_to_manager handover
-- already written by hand for that rider on the deposit's day (and not linked
-- to another deposit) is refused, manual_handover_exists, because the same
-- cash would count twice. `guard_manual_rider_handover` (BEFORE INSERT on
-- cod_handovers) is the other half: a hand-written rider_to_manager leg on a
-- day the rider has a submitted or confirmed deposit is refused,
-- deposit_exists, unless the transaction-local flag `deligro.deposit_confirm`
-- is 'on' - which only the function sets, for its own insert.
--
-- The function and the trigger are the Manager branch's 0152, with one
-- difference. 0152's function also calls manager-only helpers that live in
-- migrations 0141, 0142 and 0151: ops_require_staff_for_rider and
-- ops_require_staff (zone-scoped staff check), _ops_replayed (client action id
-- replay), _ops_set_actor and _ops_log (the audit row), and it sets
-- cod_handovers.zone_id. None of those exist in the Rider branch, so 0085's
-- copy checks only that p_actor is a manager or admin profile (the server has
-- already required that role), accepts and ignores p_zone and
-- p_client_action_id, writes no audit row and no zone. Everything else -
-- name, signature, locking, status check, note rule, manual_handover_exists,
-- the flag, the dated insert, the link, the result - is 0152's. The function
-- is created ONLY IF no function of that name exists, so when 0152 has landed
-- its full version stays; when 0152 lands after, its `create or replace`
-- supersedes this one. The trigger function has no manager-only dependency
-- and is declared identically to 0152's.
--
-- Receipt photos go in the existing private `delivery-proofs` bucket under
-- `deposits/<riderId>/<uuid>.<jpg|png>` (0082: JPEG/PNG, 5 MB). No new bucket.
--
-- Cash collected for Deligro is NEVER part of the salary ledger (0083):
-- nothing here reads or writes rider_earnings, rider_adjustments or
-- rider_payouts.
--
-- COORDINATION: the three tables below are, statement for statement, the
-- "Rider 0085" section of the Manager branch's 0150_rider_tables_converge.sql
-- (columns, CHECKs, indexes, RLS, grants). Every statement is guarded
-- (`if not exists`, `drop policy if exists`), so whichever migration lands
-- first wins and the other is a no-op for them. The two settings columns are
-- this migration's alone. The read policies are the ones 0150 has (rider
-- reads own, admin reads all); a manager reads through the server (service
-- role, behind requireRole) and, once 0151 lands, through its zone-scoped
-- policy. Do not widen them here: a blanket "managers read all" policy would
-- undo 0151's zone scoping.
--
-- Security (docs/SECURITY_AUDIT.md applies):
--   * All three tables: RLS on. A rider SELECTs their own deposits and
--     disputes (driver_id = auth.uid()); admins read everything; cash_reminders
--     has no policy at all. Writes are service role only — every
--     INSERT/UPDATE/DELETE is revoked from anon and authenticated, and the
--     routes that write sit behind requireRiderApi / requireRole.
--   * The two threshold columns are granted to anon and authenticated by name:
--     the settings facade reads platform_settings with the caller's client and
--     latches a column group as present, so a grant to authenticated alone
--     would break anon reads once latched (as 0083's rate card). A cash limit
--     is shown to riders verbatim by design.
--
-- Idempotent: safe to re-run. A re-run keeps the thresholds' values and every
-- row.
-- Re-run rule (ruling P8-R3): re-apply every migration from 0081 through the
-- newest one applied, all branches, in number order — never this file or the
-- rider files alone (Manager 0141, 0142 and 0152 narrow what they open).
--
-- Rollback (destroys the deposit and dispute history — export it first; if the
-- Manager branch's 0152 has landed, keep its guard and function: skip the
-- first three lines). The proof runs this block:
--   drop trigger if exists guard_manual_rider_handover on public.cod_handovers;
--   drop function if exists public.guard_manual_rider_handover();
--   drop function if exists public.ops_decide_cash_deposit(uuid, uuid, text, text, uuid, text);
--   drop table if exists public.cash_reminders, public.cash_disputes, public.cash_deposits;
--   alter table public.platform_settings drop constraint if exists platform_settings_rider_cash_bounds;
--   alter table public.platform_settings
--     drop column if exists rider_cash_limit, drop column if exists rider_cash_max_hours;
-- ============================================================

begin;

-- ============================================================
-- 1 — platform_settings: the two thresholds
-- ============================================================
alter table public.platform_settings
  add column if not exists rider_cash_limit     integer not null default 5000,
  add column if not exists rider_cash_max_hours integer not null default 24;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_rider_cash_bounds
    check (rider_cash_limit between 0 and 100000
           and rider_cash_max_hours between 0 and 720);
exception
  when duplicate_object then null;
end $$;

comment on column public.platform_settings.rider_cash_limit is
  'Rupees of COD cash a rider may hold undeposited before the Cash screen turns red and a reminder is pushed. 0 = no limit.';
comment on column public.platform_settings.rider_cash_max_hours is
  'Hours the oldest undeposited collection may sit with a rider before the same alert. 0 = no limit.';

-- Column-granted since 0032; see the header for why anon too.
grant select (rider_cash_limit, rider_cash_max_hours)
  on public.platform_settings to anon, authenticated;

-- ============================================================
-- 2 — cash deposits, disputes, reminders
-- (identical to the Manager branch's 0150 "Rider 0085" section)
-- ============================================================
create table if not exists public.cash_deposits (
  id            uuid primary key default gen_random_uuid(),
  driver_id     uuid not null references public.profiles (id) on delete cascade,
  amount        integer not null check (amount > 0),
  method        text not null check (method in ('cash', 'upi')),
  manager_id    uuid references public.profiles (id) on delete set null,
  reference     text,
  photo_path    text,
  note          text,
  status        text not null default 'submitted' check (status in ('submitted', 'confirmed', 'disputed', 'withdrawn')),
  handover_id   uuid references public.cod_handovers (id) on delete set null,
  decided_by    uuid references public.profiles (id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  constraint cash_deposits_confirmed_handover check (status <> 'confirmed' or handover_id is not null),
  constraint cash_deposits_disputed_note check (status <> 'disputed' or decision_note is not null)
);
create index if not exists cash_deposits_driver_idx on public.cash_deposits (driver_id, created_at desc);
create index if not exists cash_deposits_status_idx on public.cash_deposits (status, created_at);

create table if not exists public.cash_disputes (
  id             uuid primary key default gen_random_uuid(),
  driver_id      uuid not null references public.profiles (id) on delete cascade,
  day            date not null,
  claimed_amount integer,
  message        text not null,
  status         text not null default 'open' check (status in ('open', 'resolved')),
  resolution     text,
  resolved_by    uuid references public.profiles (id) on delete set null,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists cash_disputes_driver_idx on public.cash_disputes (driver_id, created_at desc);
-- One open dispute per rider and day. The server checks first and says
-- "already reported"; this makes two reports sent at the same moment unable to
-- both land (the second insert fails 23505 and gets the same answer).
create unique index if not exists cash_disputes_one_open_per_day
  on public.cash_disputes (driver_id, day) where status = 'open';

create table if not exists public.cash_reminders (
  driver_id    uuid primary key references public.profiles (id) on delete cascade,
  last_sent_at timestamptz
);

-- ============================================================
-- 3 — RLS and privileges
-- ============================================================
alter table public.cash_deposits  enable row level security;
alter table public.cash_disputes  enable row level security;
alter table public.cash_reminders enable row level security;

drop policy if exists "cash_deposits — read" on public.cash_deposits;
create policy "cash_deposits — read" on public.cash_deposits for select
  using (driver_id = auth.uid() or public.is_admin());
drop policy if exists "cash_disputes — read" on public.cash_disputes;
create policy "cash_disputes — read" on public.cash_disputes for select
  using (driver_id = auth.uid() or public.is_admin());

-- Writes: service role only.
revoke all on public.cash_deposits, public.cash_disputes, public.cash_reminders
  from anon, authenticated;
grant select on public.cash_deposits, public.cash_disputes
  to authenticated;
grant select, insert, update, delete on
  public.cash_deposits, public.cash_disputes, public.cash_reminders
  to service_role;

-- ============================================================
-- 4 — the deposit decision (one function) and the manual-handover guard
-- ============================================================
do $outer$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'ops_decide_cash_deposit'
  ) then
    execute $fn$
create function public.ops_decide_cash_deposit(
  p_actor uuid, p_deposit uuid, p_decision text, p_note text, p_zone uuid, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $body$
declare
  dep    public.cash_deposits%rowtype;
  ho     uuid;
  v_note constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into dep from public.cash_deposits where id = p_deposit for update;
  if dep.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 0152 calls ops_require_staff_for_rider (zone-scoped); without zones this
  -- is the role check, and the zone and client action id are not used.
  if not exists (select 1 from public.profiles where id = p_actor and role in ('manager', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
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

  if p_decision = 'confirm' then
    -- One record per handover: a leg already written by hand for this rider on
    -- the deposit's day would be counted twice. Dispute the deposit instead.
    if exists (select 1 from public.cod_handovers h
                where h.leg = 'rider_to_manager' and h.from_user = dep.driver_id
                  and h.handover_date = (dep.created_at at time zone 'Asia/Kolkata')::date
                  and not exists (select 1 from public.cash_deposits d2 where d2.handover_id = h.id)) then
      raise exception 'manual_handover_exists' using errcode = '23505';
    end if;
    -- The cash is booked to the person who confirms receiving it (ruling
    -- P8-R11): a rider naming a manager must not move cash onto that
    -- manager's books — the name is only who the rider says they paid. The
    -- Manager branch's 0152 must match (handover). recorded_by is also the
    -- confirmer. Dated the day the rider handed it over, which is the day
    -- they declared the deposit.
    perform set_config('deligro.deposit_confirm', 'on', true);
    insert into public.cod_handovers (leg, from_user, to_user, amount, handover_date, note, recorded_by)
    values ('rider_to_manager', dep.driver_id, p_actor, dep.amount,
            (dep.created_at at time zone 'Asia/Kolkata')::date,
            coalesce(v_note, 'Deposit ' || dep.method || coalesce(' ' || dep.reference, '')), p_actor)
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
  return jsonb_build_object('deposit_id', dep.id, 'status', case when p_decision = 'confirm' then 'confirmed' else 'disputed' end,
                            'handover_id', ho, 'replayed', false);
end;
$body$
    $fn$;
  end if;
end
$outer$;

-- The other half of "one record per handover": a rider→manager leg written by
-- hand (the /manager/cash form) on a day the rider declared a deposit is
-- refused — confirm or dispute the deposit instead. Deposit confirmation sets
-- deligro.deposit_confirm for its own insert. (0152, verbatim.)
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

revoke execute on function public.ops_decide_cash_deposit(uuid, uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_decide_cash_deposit(uuid, uuid, text, text, uuid, text) to service_role;
-- Trigger-only, like every trigger function here (0054): no API role executes it. A later
-- `create or replace` (0152) keeps these privileges.
revoke execute on function public.guard_manual_rider_handover() from public, anon, authenticated;

commit;
