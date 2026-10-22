-- ============================================================
-- 0083 — Rider money: rate card, earnings ledger, incentives, adjustments,
--        payouts
-- STATUS: PENDING APPROVAL — not applied to any database. Staging first.
--         Requires 0081 (rider app foundation) and 0082 (rider jobs).
-- ------------------------------------------------------------
-- Phase 3 of the rider app (plan: docs/superpowers/plans/
-- 2026-10-21-rider-app-phase-3-money.md; design: docs/superpowers/specs/
-- 2026-10-21-rider-app-design.md, "Money — earnings, incentives, payouts").
-- The pay model is data, not code: per-delivery pay, salary plus incentives,
-- or pure salary (rates at ₹0, salary as an adjustment) without a rebuild.
--
--   1. `platform_settings` rate card: rider_base_fee, rider_km_included,
--      rider_per_km, rider_min_per_delivery. All default 0 — nothing is paid
--      until an admin sets a rate. The old rider_commission /
--      rider_min_payout columns stay, unread.
--   2. `rider_earnings` — the ledger. One live row per delivered delivery,
--      written by `record_rider_earning` (AFTER UPDATE on
--      `deliveries`, when status becomes delivered) from the rate card in
--      force at that moment. Every component is stored, never recomputed, so
--      a later rate change alters no row:
--        billable_km  = greatest(distance_km - km_included, 0)
--        distance_fee = round(billable_km x per_km, 2)
--        min_topup    = what the minimum adds: greatest(min - (base + distance_fee), 0)
--        amount       = base + distance_fee + min_topup
--                       + tip_amount unless tip_in_cash
--      distance_km / distance_source are copied from the delivery (0081/0082:
--      stored at acceptance, the road value replacing the estimate). No
--      distance -> 0 km and source null ("distance not recorded"). The tip is
--      orders.tip; tip_in_cash = the order is COD (the tip is already in the
--      rider's hand: shown, never paid again). Failed and cancelled
--      deliveries never reach this trigger.
--      Once per delivery and rider: the trigger writes nothing while that
--      rider holds a live (not reversed) earning for the delivery, and the key
--      UNIQUE (delivery_id, driver_id, attempt) backs it — attempt is 1, or one
--      more than the rider's earlier, all-reversed earnings for it.
--   2a. Ruling P3-R4 — earnings never survive a delivery leaving delivered.
--      `reverse_rider_earning` (AFTER UPDATE on `deliveries`, when status
--      leaves delivered — only a staff correction can) writes, for each live
--      earning of the delivery, a reversing `rider_adjustments` row: kind
--      adjustment, amount = -(the earning's amount), reason "Delivery
--      <ORDER CODE> corrected after delivery", effective_on = the IST date of
--      the correction, created_by = auth.uid() (null for the service role),
--      reverses_earning_id = the earning (UNIQUE: a replayed correction writes
--      one reversal). Unpaid, the pair nets to zero; paid, the reversal comes
--      off the next payout. Whoever completes the delivery afterwards earns
--      afresh: another rider (attempt 1), or the same rider (attempt 2).
--      Reversed earnings no longer count towards incentive targets, but an
--      award already made partly from one stays (the bonus was announced; ops
--      may deduct it).
--   2b. Ruling P3-R7: the rider of a delivered delivery cannot change
--      (`guard_delivered_rider`, BEFORE UPDATE, every role, corrections
--      included). To move the pay, correct the status out of delivered first
--      (which reverses) and complete it with the other rider.
--   2c. Ruling P3-R8: a delivery with an earning (live or reversed) cannot be
--      deleted (`guard_delivery_delete`, BEFORE DELETE, SECURITY DEFINER so a
--      manager's own-JWT delete cannot slip past an RLS-hidden ledger) — nor,
--      through the cascade, its order. The app deletes deliveries only to roll
--      back never-delivered phone orders, which have no earning.
--   3. `rider_incentive_rules` (admin) — daily or weekly target of N
--      deliveries -> bonus, optional IST time window, active dates. English
--      only (owner decision): no Hindi name column. `period` and `starts_on`
--      are fixed once created — no UPDATE grant, and
--      `touch_rider_incentive_rule` refuses the change for every role
--      (service role included): changing either would re-key past periods and
--      the unique award key would silently swallow awards. A different period
--      is a new rule; the old one is deactivated.
--      `rider_incentive_awards` — written by `award_rider_incentives` (AFTER
--      INSERT on rider_earnings): for each active rule in force on the IST
--      date of earned_at (and inside its window), count this rider's earnings
--      in the rule's period — IST day, or IST week starting Monday — on the
--      rule's own dates and inside its window; at >= target, insert the award
--      `on conflict (rule_id, driver_id, period_start) do nothing`.
--   4. `rider_adjustments` (admin) — bonus, salary, deduction (amount > 0,
--      subtracted) and adjustment (any non-zero amount), each with a reason the
--      rider reads; plus the system's reversals (2a: kind adjustment, amount
--      <= 0, reverses_earning_id set, created_by may be null).
--   5. `rider_payouts` + `record_rider_payout(...)` — the admin settles a rider
--      up to an IST date: every unattached earning, award and adjustment dated
--      on or before it is locked, summed, and attached to one new payout row,
--      all in one transaction. Net <= 0 raises nothing_to_pay (also the second
--      call of a double-click: by then nothing is unattached). Ruling P3-R6:
--      attaching an earning also attaches any unattached reversal of it,
--      whatever its effective_on, so a payout never pays a delivery the ledger
--      already knows was reversed; a reversal of an earning paid EARLIER stays
--      pending (an honest debt) until its effective_on is settled. An award
--      is dated by the earning row that reached the target
--      (trigger_earning_id). period_end may
--      not be after today (IST) and paid_on may not be before period_end
--      (invalid_payout; CHECK paid_on >= period_end on the table), so a
--      statement's "paid" always follows what it settled.
--   6. `guard_rider_ledger` — earnings, awards and adjustments are append-only:
--      only payout_id may change (null -> a payout, once), plus an award's
--      notified_at; a row attached to a payout, and a reversal, cannot be
--      deleted. A correction is a new row (an adjustment), as everywhere else
--      in this schema (0047).
--
-- Dates. "Earned on" is the IST date of earned_at (= deliveries.delivered_at);
-- an award is dated by the earning row that reached its target
-- (trigger_earning_id); an adjustment by effective_on. Days and weeks are cut with `at time zone 'Asia/Kolkata'`;
-- weeks start Monday (date_trunc('week')).
--
-- Concurrency.
--   * Earnings: UNIQUE (delivery_id, driver_id, attempt), and the trigger
--     takes a per-delivery advisory lock before looking for a live earning
--     (the deliveries row lock already serialises its own transitions).
--   * Reversals: UNIQUE reverses_earning_id.
--   * Awards: UNIQUE (rule_id, driver_id, period_start), and the award trigger
--     takes a per-rider transaction advisory lock before counting, so two of
--     one rider's deliveries completing at once are counted one after the
--     other (under READ COMMITTED each count statement sees the other's
--     committed row) — a target crossed by the pair is not missed, and
--     awarded once.
--   * Payouts: a per-rider advisory lock, then `for update` on the unattached
--     rows; the payout sums exactly the rows it locked and attaches exactly
--     those (by id). A second, concurrent call waits, then finds nothing
--     unattached -> nothing_to_pay.
--
-- Security:
--   * All five tables: RLS on. A rider SELECTs their own earnings, awards,
--     adjustments and payouts (driver_id = auth.uid()), the ACTIVE rules, and
--     any rule they hold an award under (so a past award keeps its rule's
--     name after the rule is switched off); admins read everything. Managers read none of it (pay is admin
--     business). The Supabase default grants are revoked explicitly (RLS
--     filters rows, not privileges).
--   * Writes: rules (insert/update) and adjustments (insert) by admins with
--     their own JWT — admin-only policies on is_admin(), and column grants that
--     leave out id, payout_id and the timestamps, so no client can pre-attach a
--     row to a payout (or mark it a reversal). A rule's or adjustment's
--     created_by must be the caller. Nobody
--     but the service role deletes; rules are never deleted (awards reference
--     them, ON DELETE RESTRICT). Earnings, awards and payouts are written only
--     by the triggers, record_rider_payout and the service role. A rider never
--     writes any of it.
--   * record_rider_earning, reverse_rider_earning and award_rider_incentives
--     are SECURITY DEFINER: the rider app (service role), managers and admins
--     (own JWT) complete and correct deliveries, and the earning or reversal
--     must be written whoever did. They read
--     orders and platform_settings as the owner, so RLS cannot hide the tip.
--   * guard_delivery_delete is SECURITY DEFINER too (P3-R8): a manager's
--     own-JWT delete reads no earnings under RLS, so an invoker check would
--     let a delivery with an earning be deleted. It only reads rider_earnings
--     and raises; trigger-only, EXECUTE revoked like the others.
--   * record_rider_payout is SECURITY DEFINER and checks is_admin() itself
--     (raise forbidden, 42501). EXECUTE: authenticated only (the admin's
--     cookie client); revoked from PUBLIC, anon and service_role — the
--     service role has no admin identity and would only be refused.
--   * Every function pins search_path; trigger functions have EXECUTE revoked
--     from PUBLIC, anon and authenticated (0054).
--   * The four rate-card columns are granted to anon and authenticated by name
--     (the row is column-granted since 0032). The settings facade
--     (src/lib/data-access/settings.ts) reads with the caller's own client and
--     latches a column group as present for the process, so a grant to
--     authenticated alone would break anon reads once latched. The rate card
--     is shown to riders verbatim by design; it is not a vendor term like
--     vendor_commission_pct, which stays private.
--
-- Not done here, on purpose:
--   * No backfill: deliveries delivered before this migration get no earning
--     row (the card is ₹0 until set; earlier pay was settled off-system).
--   * A delivery INSERTED already delivered (a correction import, 0082's
--     guard_delivery_insert) earns nothing: the trigger watches the
--     transition, not the row.
--
-- ORDER OF DEPLOY: no app change is required first. The triggers only add
-- rows; no current writer reads these tables.
--
-- Idempotent: safe to re-run. A re-run keeps the rate card's values and every
-- ledger row.
-- Re-run rule (ruling P8-R3): re-apply every migration from 0081 through the
-- newest one applied, all branches, in number order — never this file or the
-- rider files alone (Manager 0141, 0142 and 0152 narrow what they open).
--
-- Rollback (destroys the ledger — export it first). Tables before the
-- functions their triggers use (award_rider_incentives, guard_rider_ledger,
-- touch_rider_incentive_rule); the proof runs this block:
--   drop trigger if exists record_rider_earning  on public.deliveries;
--   drop trigger if exists reverse_rider_earning on public.deliveries;
--   drop trigger if exists guard_delivered_rider on public.deliveries;
--   drop trigger if exists guard_delivery_delete on public.deliveries;
--   drop function if exists public.record_rider_payout(uuid, date, text, text, date, text),
--                           public.record_rider_earning(),
--                           public.reverse_rider_earning(),
--                           public.guard_delivered_rider(),
--                           public.guard_delivery_delete();
--   drop table if exists public.rider_adjustments, public.rider_incentive_awards,
--                        public.rider_earnings, public.rider_payouts,
--                        public.rider_incentive_rules;
--   drop function if exists public.award_rider_incentives(), public.guard_rider_ledger(),
--                           public.touch_rider_incentive_rule();
--   alter table public.platform_settings drop constraint if exists platform_settings_rider_rate_card_nonneg;
--   alter table public.platform_settings
--     drop column if exists rider_base_fee,  drop column if exists rider_km_included,
--     drop column if exists rider_per_km,    drop column if exists rider_min_per_delivery;
-- ============================================================

begin;

-- ============================================================
-- 1 — platform_settings: the rate card
-- ============================================================
alter table public.platform_settings
  add column if not exists rider_base_fee         numeric(10,2) not null default 0,
  add column if not exists rider_km_included      numeric(6,2)  not null default 0,
  add column if not exists rider_per_km           numeric(10,2) not null default 0,
  add column if not exists rider_min_per_delivery numeric(10,2) not null default 0;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_rider_rate_card_nonneg
    check (rider_base_fee >= 0 and rider_km_included >= 0
           and rider_per_km >= 0 and rider_min_per_delivery >= 0);
exception
  when duplicate_object then null;
end $$;

comment on column public.platform_settings.rider_base_fee is
  'Rider rate card: rupees paid per delivered delivery before distance. 0 = not paid.';
comment on column public.platform_settings.rider_km_included is
  'Rider rate card: km covered by the base fee; only the distance beyond it earns rider_per_km.';
comment on column public.platform_settings.rider_per_km is
  'Rider rate card: rupees per km beyond rider_km_included (deliveries.distance_km at delivery).';
comment on column public.platform_settings.rider_min_per_delivery is
  'Rider rate card: the least a delivery earns before tips; the difference is stored as rider_earnings.min_topup.';

-- Column-granted since 0032; see the header for why anon too.
grant select (rider_base_fee, rider_km_included, rider_per_km, rider_min_per_delivery)
  on public.platform_settings to anon, authenticated;

-- ============================================================
-- 2 — rider_payouts (first: the ledger tables reference it)
-- ------------------------------------------------------------
-- No foreign key on driver_id / created_by, here or in the ledger tables: a
-- financial record must outlive the profile and must not block deleting one
-- (as delivery_exceptions, 0082). payout_id and rule_id ARE foreign keys,
-- ON DELETE RESTRICT: a payout or rule with rows attached cannot vanish.
-- ============================================================
create table if not exists public.rider_payouts (
  id         uuid primary key default gen_random_uuid(),
  driver_id  uuid not null,
  period_end date not null,
  amount     numeric(10,2) not null check (amount > 0),
  method     text not null check (method in ('bank', 'upi', 'cash', 'other')),
  reference  text,
  paid_on    date not null,
  note       text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  -- Paid on or after the last day it settles: a statement's "paid" never
  -- precedes the earnings it covers.
  constraint rider_payouts_paid_after_period check (paid_on >= period_end)
);

comment on table public.rider_payouts is
  'One row per payout to a rider, written only by record_rider_payout (admin). amount = the net of the earnings, awards and adjustments attached to it (payout_id). Paid = sum of payouts; pending = everything unattached.';
comment on column public.rider_payouts.period_end is
  'Settles everything dated on or before this IST date that was not yet attached.';

create index if not exists rider_payouts_driver_idx
  on public.rider_payouts (driver_id, paid_on desc);

-- ============================================================
-- 3 — rider_earnings: the ledger
-- ============================================================
create table if not exists public.rider_earnings (
  id              uuid primary key default gen_random_uuid(),
  delivery_id     uuid not null,
  attempt         smallint not null default 1 check (attempt > 0),
  order_id        uuid not null,
  driver_id       uuid not null,
  earned_at       timestamptz not null,
  base_fee        numeric(10,2) not null check (base_fee >= 0),
  distance_km     numeric(6,2)  not null check (distance_km >= 0),
  distance_source text check (distance_source in ('road', 'estimate')),
  billable_km     numeric(6,2)  not null check (billable_km >= 0),
  distance_fee    numeric(10,2) not null check (distance_fee >= 0),
  min_topup       numeric(10,2) not null check (min_topup >= 0),
  tip_amount      numeric(10,2) not null check (tip_amount >= 0),
  tip_in_cash     boolean not null,
  amount          numeric(10,2) not null,
  payout_id       uuid references public.rider_payouts (id) on delete restrict,
  created_at      timestamptz not null default now(),
  -- One per (delivery, rider, attempt). attempt > 1 only after every earlier
  -- earning of this rider for the delivery was reversed (record_rider_earning).
  constraint rider_earnings_once unique (delivery_id, driver_id, attempt),
  constraint rider_earnings_amount_adds_up check (
    amount = base_fee + distance_fee + min_topup
             + case when tip_in_cash then 0 else tip_amount end)
);

comment on table public.rider_earnings is
  'One row per (delivery, rider, attempt) — at most one live (not reversed) row per delivery and rider — written by the record_rider_earning trigger from the rate card in force at that moment. Components are stored, never recomputed. Append-only (guard_rider_ledger): only payout_id changes, once. Reversed (rider_adjustments.reverses_earning_id) when the delivery leaves delivered; the same rider completing it again earns as the next attempt.';
comment on column public.rider_earnings.attempt is
  '1 for a rider''s first earning on the delivery; n+1 when the delivery was corrected away (earning n reversed) and the same rider completed it again.';
comment on column public.rider_earnings.earned_at is
  'deliveries.delivered_at. Its IST date dates the earning for incentives and payouts.';
comment on column public.rider_earnings.distance_km is
  'deliveries.distance_km at delivery; 0 when no distance was recorded.';
comment on column public.rider_earnings.distance_source is
  'deliveries.distance_source at delivery: road (routed) or estimate (straight line x 1.3). Null = distance not recorded (distance_km 0).';
comment on column public.rider_earnings.min_topup is
  'What rider_min_per_delivery added on top of base_fee + distance_fee.';
comment on column public.rider_earnings.tip_in_cash is
  'The order was COD: the tip was collected in cash by the rider, so it is shown but not included in amount.';
comment on column public.rider_earnings.amount is
  'Payable: base_fee + distance_fee + min_topup + tip_amount (unless tip_in_cash).';
comment on column public.rider_earnings.payout_id is
  'The payout that paid this row; null = pending.';

create index if not exists rider_earnings_driver_idx
  on public.rider_earnings (driver_id, earned_at desc);
create index if not exists rider_earnings_payout_idx
  on public.rider_earnings (payout_id) where payout_id is not null;

-- ============================================================
-- 4 — rider_incentive_rules
-- ============================================================
create table if not exists public.rider_incentive_rules (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (btrim(name) <> ''),
  period            text not null check (period in ('daily', 'weekly')),
  target_deliveries integer not null check (target_deliveries > 0),
  bonus_amount      numeric(10,2) not null check (bonus_amount > 0),
  window_start      time,
  window_end        time,
  starts_on         date not null,
  ends_on           date,
  active            boolean not null default true,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint rider_incentive_rules_window_pair check ((window_start is null) = (window_end is null)),
  constraint rider_incentive_rules_window_order check (window_start is null or window_end > window_start),
  constraint rider_incentive_rules_dates check (ends_on is null or ends_on >= starts_on)
);

comment on table public.rider_incentive_rules is
  'Admin incentive targets: N deliveries in an IST day or week (Monday start) -> bonus_amount. Riders read the active ones verbatim. Never deleted once awarded (rider_incentive_awards.rule_id RESTRICT); deactivate instead.';
comment on column public.rider_incentive_rules.window_start is
  'Optional IST time window [window_start, window_end): only deliveries earned inside it count, and only they can trigger the award. Both or neither.';
comment on column public.rider_incentive_rules.starts_on is
  'First IST date the rule is in force. Deliveries before it (or after ends_on) do not count, even inside the same week.';

-- Stamps updated_at, and keeps period and starts_on fixed for EVERY role
-- (the UPDATE grant already leaves them out for clients; this covers the
-- service role and the owner). See the header, item 3.
create or replace function public.touch_rider_incentive_rule()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.period is distinct from old.period or new.starts_on is distinct from old.starts_on then
    raise exception 'rider_rule_fixed'
      using errcode = 'check_violation',
            detail  = 'a rule''s period and starts_on cannot change; deactivate it and create a new rule';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_rider_incentive_rule on public.rider_incentive_rules;
create trigger touch_rider_incentive_rule
  before update on public.rider_incentive_rules
  for each row execute function public.touch_rider_incentive_rule();

-- ============================================================
-- 5 — rider_incentive_awards
-- ============================================================
create table if not exists public.rider_incentive_awards (
  id                  uuid primary key default gen_random_uuid(),
  rule_id             uuid not null references public.rider_incentive_rules (id) on delete restrict,
  driver_id           uuid not null,
  period_start        date not null,
  deliveries_count    integer not null check (deliveries_count > 0),
  amount              numeric(10,2) not null check (amount > 0),
  trigger_delivery_id uuid,
  trigger_earning_id  uuid references public.rider_earnings (id) on delete restrict,
  awarded_at          timestamptz not null default now(),
  notified_at         timestamptz,
  payout_id           uuid references public.rider_payouts (id) on delete restrict,
  constraint rider_incentive_awards_once unique (rule_id, driver_id, period_start)
);

comment on table public.rider_incentive_awards is
  'One bonus per (rule, rider, period), written by the award_rider_incentives trigger when a rider''s count reaches the target. amount is the rule''s bonus at that moment. Append-only except payout_id and notified_at.';
comment on column public.rider_incentive_awards.period_start is
  'IST date the period starts: the day (daily) or the Monday (weekly).';
comment on column public.rider_incentive_awards.trigger_delivery_id is
  'The delivery whose earning reached the target (for display).';
comment on column public.rider_incentive_awards.trigger_earning_id is
  'The earning row that reached the target; its earned_at dates the award for payouts. Joined by id: a delivery can carry several earnings (attempts, riders).';
comment on column public.rider_incentive_awards.notified_at is
  'When the rider was pushed about it; null = not yet (notifyNewIncentiveAwards).';

create index if not exists rider_incentive_awards_driver_idx
  on public.rider_incentive_awards (driver_id, awarded_at desc);
create index if not exists rider_incentive_awards_unnotified_idx
  on public.rider_incentive_awards (driver_id) where notified_at is null;
create index if not exists rider_incentive_awards_payout_idx
  on public.rider_incentive_awards (payout_id) where payout_id is not null;

-- ============================================================
-- 6 — rider_adjustments
-- ============================================================
create table if not exists public.rider_adjustments (
  id           uuid primary key default gen_random_uuid(),
  driver_id    uuid not null,
  kind         text not null check (kind in ('bonus', 'adjustment', 'deduction', 'salary')),
  amount       numeric(10,2) not null,
  reason       text not null check (btrim(reason) <> ''),
  order_id     uuid,
  effective_on date not null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  payout_id    uuid references public.rider_payouts (id) on delete restrict,
  reverses_earning_id uuid unique references public.rider_earnings (id) on delete restrict,
  -- A reversal is an adjustment of minus the earning (0 for a ₹0 earning);
  -- otherwise bonus / salary / deduction are positive, an adjustment non-zero.
  constraint rider_adjustments_amount_sign check (
    case
      when reverses_earning_id is not null then kind = 'adjustment' and amount <= 0
      when kind = 'adjustment' then amount <> 0
      else amount > 0
    end),
  -- Only the system's reversals may lack an author.
  constraint rider_adjustments_author check (created_by is not null or reverses_earning_id is not null)
);

comment on table public.rider_adjustments is
  'Admin money entries for a rider: bonus, salary and deduction (amount > 0; a deduction is subtracted) and adjustment (+/-, non-zero). The rider reads the reason. Append-only: a correction is a new row.';
comment on column public.rider_adjustments.reverses_earning_id is
  'Set on the reversal reverse_rider_earning writes when a delivery leaves delivered (ruling P3-R4); its earning no longer counts. created_by is then the correcting user, or null for the service role.';
comment on column public.rider_adjustments.effective_on is
  'The IST date it belongs to; record_rider_payout settles it once period_end reaches this date.';

create index if not exists rider_adjustments_driver_idx
  on public.rider_adjustments (driver_id, effective_on desc);
create index if not exists rider_adjustments_payout_idx
  on public.rider_adjustments (payout_id) where payout_id is not null;

-- ============================================================
-- 7 — guard_rider_ledger: append-only, paid rows stay paid
-- ------------------------------------------------------------
-- No role is exempt: the service role is a writer of these tables too.
-- ============================================================
create or replace function public.guard_rider_ledger()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  free text[] := array['payout_id'];
begin
  if tg_op = 'DELETE' then
    if old.payout_id is not null then
      raise exception 'rider_ledger_paid'
        using errcode = 'check_violation',
              detail  = format('this %s row belongs to payout %s', tg_table_name, old.payout_id);
    end if;
    -- Deleting a reversal would bring its earning back to life.
    if tg_table_name = 'rider_adjustments' and to_jsonb(old) ->> 'reverses_earning_id' is not null then
      raise exception 'rider_ledger_immutable'
        using errcode = 'check_violation',
              detail  = 'a reversal cannot be deleted';
    end if;
    return old;
  end if;

  if tg_table_name = 'rider_incentive_awards' then
    free := free || 'notified_at'::text;
  end if;

  if (to_jsonb(new) - free) is distinct from (to_jsonb(old) - free) then
    raise exception 'rider_ledger_immutable'
      using errcode = 'check_violation',
            detail  = format('only %s may change on %s; a correction is a new adjustment',
                             array_to_string(free, ', '), tg_table_name);
  end if;

  if old.payout_id is not null and new.payout_id is distinct from old.payout_id then
    raise exception 'rider_ledger_paid'
      using errcode = 'check_violation',
            detail  = format('this %s row already belongs to payout %s', tg_table_name, old.payout_id);
  end if;

  return new;
end;
$$;

drop trigger if exists guard_rider_ledger on public.rider_earnings;
create trigger guard_rider_ledger
  before update or delete on public.rider_earnings
  for each row execute function public.guard_rider_ledger();

drop trigger if exists guard_rider_ledger on public.rider_incentive_awards;
create trigger guard_rider_ledger
  before update or delete on public.rider_incentive_awards
  for each row execute function public.guard_rider_ledger();

drop trigger if exists guard_rider_ledger on public.rider_adjustments;
create trigger guard_rider_ledger
  before update or delete on public.rider_adjustments
  for each row execute function public.guard_rider_ledger();

-- ============================================================
-- 8 — record_rider_earning: AFTER UPDATE on deliveries
-- ------------------------------------------------------------
-- Fires only when status BECOMES delivered, after guard_delivery_transition
-- (BEFORE) has allowed the move and stamped delivered_at, alongside
-- log_delivery_event (AFTER). A delivery reaches delivered only through the
-- guarded paths — completeDelivery or a staff correction — so failed and
-- cancelled never earn. While the rider holds a live earning for the delivery
-- nothing is written; after a reversal (section 8a) the rider earns again as
-- the next attempt, from the card in force now.
-- A delivery with no rider (only a correction can deliver one) has nobody to
-- pay and writes nothing.
-- ============================================================
create or replace function public.record_rider_earning()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  card     record;
  ord      record;
  km       numeric(6,2);
  billable numeric(6,2);
  dist_fee numeric(10,2);
  base     numeric(10,2);
  topup    numeric(10,2);
  tip      numeric(10,2);
  in_cash  boolean;
  next_try smallint;
begin
  if new.driver_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('rider_earning'), hashtext(new.id::text));

  if exists (
    select 1
      from public.rider_earnings e
     where e.delivery_id = new.id
       and e.driver_id   = new.driver_id
       and not exists (select 1 from public.rider_adjustments j where j.reverses_earning_id = e.id)) then
    return null;  -- already earned, not reversed
  end if;

  select coalesce(max(e.attempt), 0) + 1
    into next_try
    from public.rider_earnings e
   where e.delivery_id = new.id
     and e.driver_id   = new.driver_id;

  select s.rider_base_fee, s.rider_km_included, s.rider_per_km, s.rider_min_per_delivery
    into card
    from public.platform_settings s
   limit 1;

  select o.tip, o.payment_method::text as method
    into ord
    from public.orders o
   where o.id = new.order_id;

  base     := coalesce(card.rider_base_fee, 0);
  km       := coalesce(new.distance_km, 0);
  billable := greatest(km - coalesce(card.rider_km_included, 0), 0);
  dist_fee := round(billable * coalesce(card.rider_per_km, 0), 2);
  topup    := greatest(coalesce(card.rider_min_per_delivery, 0) - (base + dist_fee), 0);
  tip      := coalesce(ord.tip, 0);
  -- COD (or no method recorded, as before 0025): the tip is cash in hand.
  in_cash  := coalesce(ord.method, 'cod') = 'cod';

  insert into public.rider_earnings
    (delivery_id, attempt, order_id, driver_id, earned_at,
     base_fee, distance_km, distance_source, billable_km, distance_fee, min_topup,
     tip_amount, tip_in_cash, amount)
  values
    (new.id, next_try, new.order_id, new.driver_id, coalesce(new.delivered_at, now()),
     base, km, case when new.distance_km is null then null else new.distance_source end,
     billable, dist_fee, topup,
     tip, in_cash, base + dist_fee + topup + case when in_cash then 0 else tip end)
  on conflict (delivery_id, driver_id, attempt) do nothing;

  return null;
end;
$$;

drop trigger if exists record_rider_earning on public.deliveries;
create trigger record_rider_earning
  after update on public.deliveries
  for each row
  when (new.status = 'delivered' and old.status is distinct from new.status)
  execute function public.record_rider_earning();

-- ============================================================
-- 8a — reverse_rider_earning: AFTER UPDATE on deliveries (ruling P3-R4)
-- ------------------------------------------------------------
-- Fires when status LEAVES delivered. guard_delivery_transition (rule 5)
-- admits that only as a correction, i.e. a staff path. Every live earning of
-- the delivery — one, since its rider cannot change while it is delivered
-- (section 8b) — gets one reversing adjustment,
-- `on conflict (reverses_earning_id) do nothing`. The order code is the one
-- the apps show (shortOrderId: first 8 characters of the id, upper case).
-- ============================================================
create or replace function public.reverse_rider_earning()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('rider_earning'), hashtext(new.id::text));

  insert into public.rider_adjustments
    (driver_id, kind, amount, reason, order_id, effective_on, created_by, reverses_earning_id)
  select e.driver_id, 'adjustment', -e.amount,
         format('Delivery %s corrected after delivery', upper(left(e.order_id::text, 8))),
         e.order_id, (now() at time zone 'Asia/Kolkata')::date, auth.uid(), e.id
    from public.rider_earnings e
   where e.delivery_id = new.id
     and not exists (select 1 from public.rider_adjustments j where j.reverses_earning_id = e.id)
  on conflict (reverses_earning_id) do nothing;

  return null;
end;
$$;

drop trigger if exists reverse_rider_earning on public.deliveries;
create trigger reverse_rider_earning
  after update on public.deliveries
  for each row
  when (old.status = 'delivered' and new.status is distinct from old.status)
  execute function public.reverse_rider_earning();

-- ============================================================
-- 8b — guard_delivered_rider: a delivered delivery keeps its rider (P3-R7)
-- ------------------------------------------------------------
-- Every role, corrections included: the earning belongs to the rider who
-- delivered, so moving the job means correcting it out of delivered (which
-- reverses the earning) and completing it with the other rider.
-- ============================================================
create or replace function public.guard_delivered_rider()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if old.status = 'delivered' and new.driver_id is distinct from old.driver_id then
    raise exception 'invalid_delivery_transition'
      using errcode = 'check_violation',
            detail  = 'the rider of a delivered delivery cannot change; correct it out of delivered first';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_delivered_rider on public.deliveries;
create trigger guard_delivered_rider
  before update of driver_id on public.deliveries
  for each row execute function public.guard_delivered_rider();

-- ============================================================
-- 8c — guard_delivery_delete: a delivery with an earning stays (P3-R8)
-- ------------------------------------------------------------
-- Live or reversed, an earning is money the ledger has recorded against this
-- delivery. A deleted order cascades here, so the order delete is refused
-- too. SECURITY DEFINER: managers delete deliveries with their own JWT and
-- read no earnings under RLS, so an invoker check would wave them through.
-- ============================================================
create or replace function public.guard_delivery_delete()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.rider_earnings e where e.delivery_id = old.id) then
    raise exception 'delivery_has_earnings'
      using errcode = 'restrict_violation',
            detail  = 'a delivery with a rider earning (live or reversed) cannot be deleted';
  end if;
  return old;
end;
$$;

drop trigger if exists guard_delivery_delete on public.deliveries;
create trigger guard_delivery_delete
  before delete on public.deliveries
  for each row execute function public.guard_delivery_delete();

-- ============================================================
-- 9 — award_rider_incentives: AFTER INSERT on rider_earnings
-- ------------------------------------------------------------
-- A rule counts this rider's earnings that fall in the rule's period (IST day,
-- or IST week from Monday), on the rule's own dates (starts_on..ends_on) and,
-- for a window rule, inside [window_start, window_end) IST, and not reversed
-- (P3-R4). Only an earning
-- that is itself in force for the rule can trigger it. ">=" rather than "=":
-- a rule switched on after the rider already passed its target awards on the
-- next delivery instead of never; the unique key keeps it to one.
-- ============================================================
create or replace function public.award_rider_incentives()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  local_at constant timestamp := new.earned_at at time zone 'Asia/Kolkata';
  local_on constant date      := (new.earned_at at time zone 'Asia/Kolkata')::date;
  r        record;
  p_start  date;
  lo       date;
  hi       date;
  n        integer;
begin
  -- One rider's earnings are counted one at a time (see the header).
  perform pg_advisory_xact_lock(hashtext('rider_incentives'), hashtext(new.driver_id::text));

  for r in
    select *
      from public.rider_incentive_rules
     where active
       and starts_on <= local_on
       and (ends_on is null or ends_on >= local_on)
       and (window_start is null
            or (local_at::time >= window_start and local_at::time < window_end))
  loop
    if r.period = 'daily' then
      p_start := local_on;
      hi      := local_on + 1;
    else
      p_start := date_trunc('week', local_at)::date;  -- Monday
      hi      := p_start + 7;
    end if;
    lo := greatest(p_start, r.starts_on);
    if r.ends_on is not null then
      hi := least(hi, r.ends_on + 1);
    end if;

    select count(*)
      into n
      from public.rider_earnings e
     where e.driver_id = new.driver_id
       and e.earned_at >= (lo::timestamp at time zone 'Asia/Kolkata')
       and e.earned_at <  (hi::timestamp at time zone 'Asia/Kolkata')
       and (r.window_start is null
            or ((e.earned_at at time zone 'Asia/Kolkata')::time >= r.window_start
                and (e.earned_at at time zone 'Asia/Kolkata')::time < r.window_end))
       and not exists (select 1 from public.rider_adjustments j where j.reverses_earning_id = e.id);

    if n >= r.target_deliveries then
      insert into public.rider_incentive_awards
        (rule_id, driver_id, period_start, deliveries_count, amount, trigger_delivery_id, trigger_earning_id)
      values
        (r.id, new.driver_id, p_start, n, r.bonus_amount, new.delivery_id, new.id)
      on conflict (rule_id, driver_id, period_start) do nothing;
    end if;
  end loop;

  return null;
end;
$$;

drop trigger if exists award_rider_incentives on public.rider_earnings;
create trigger award_rider_incentives
  after insert on public.rider_earnings
  for each row execute function public.award_rider_incentives();

-- ============================================================
-- 10 — record_rider_payout: settle a rider up to an IST date
-- ------------------------------------------------------------
-- Errors: forbidden (42501) for a non-admin; invalid_payout (22023) for a
-- missing driver / date, a period_end after today (IST) — it would settle
-- days not yet worked — or a paid_on before period_end; nothing_to_pay (P0001) when the net is <= 0 —
-- including a repeat call, and a deduction larger than everything else (the
-- rows then stay unattached and the rider's pending figure shows the
-- negative balance). A bad method fails the table CHECK (23514).
-- ============================================================
create or replace function public.record_rider_payout(
  p_driver     uuid,
  p_period_end date,
  p_method     text,
  p_reference  text,
  p_paid_on    date,
  p_note       text
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
  if not coalesce(public.is_admin(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_driver is null or p_period_end is null or p_paid_on is null then
    raise exception 'invalid_payout'
      using errcode = '22023', detail = 'driver, period end and paid-on date are required';
  end if;
  if p_period_end > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'invalid_payout'
      using errcode = '22023', detail = 'the period cannot end after today (IST)';
  end if;
  if p_paid_on < p_period_end then
    raise exception 'invalid_payout'
      using errcode = '22023', detail = 'paid_on cannot be before the period end';
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

  -- An award is dated by the earning row that reached the target — joined by
  -- id, so each award is one row here however many earnings its delivery has.
  select coalesce(array_agg(x.id), '{}'), coalesce(sum(x.amount), 0)
    into award_ids, award_sum
    from (select a.id, a.amount
            from public.rider_incentive_awards a
            left join public.rider_earnings t on t.id = a.trigger_earning_id
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
             and (j.effective_on <= p_period_end
                  -- P3-R6: the reversal of an earning this payout attaches.
                  or j.reverses_earning_id = any (earn_ids))
             for update) x;

  net := earn_sum + award_sum + adj_sum;
  if net <= 0 then
    raise exception 'nothing_to_pay'
      using detail = format('net payable up to %s is %s', p_period_end, net);
  end if;

  insert into public.rider_payouts
    (driver_id, period_end, amount, method, reference, paid_on, note, created_by)
  values
    (p_driver, p_period_end, net, p_method, nullif(btrim(p_reference), ''), p_paid_on,
     nullif(btrim(p_note), ''), auth.uid())
  returning id into payout;

  update public.rider_earnings         set payout_id = payout where id = any (earn_ids);
  update public.rider_incentive_awards set payout_id = payout where id = any (award_ids);
  update public.rider_adjustments      set payout_id = payout where id = any (adj_ids);

  return payout;
end;
$$;

-- ============================================================
-- 11 — RLS and privileges
-- ============================================================
alter table public.rider_earnings         enable row level security;
alter table public.rider_incentive_rules  enable row level security;
alter table public.rider_incentive_awards enable row level security;
alter table public.rider_adjustments      enable row level security;
alter table public.rider_payouts          enable row level security;

drop policy if exists "rider_earnings — read" on public.rider_earnings;
create policy "rider_earnings — read" on public.rider_earnings for select
  using (driver_id = auth.uid() or public.is_admin());

drop policy if exists "rider_incentive_awards — read" on public.rider_incentive_awards;
create policy "rider_incentive_awards — read" on public.rider_incentive_awards for select
  using (driver_id = auth.uid() or public.is_admin());

drop policy if exists "rider_adjustments — read" on public.rider_adjustments;
create policy "rider_adjustments — read" on public.rider_adjustments for select
  using (driver_id = auth.uid() or public.is_admin());

drop policy if exists "rider_adjustments — admin insert" on public.rider_adjustments;
create policy "rider_adjustments — admin insert" on public.rider_adjustments for insert
  with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "rider_payouts — read" on public.rider_payouts;
create policy "rider_payouts — read" on public.rider_payouts for select
  using (driver_id = auth.uid() or public.is_admin());

drop policy if exists "rider_incentive_rules — read" on public.rider_incentive_rules;
-- A rider reads the active rules, and any rule they hold an award under (the
-- awards subquery runs under the rider's own awards policy).
create policy "rider_incentive_rules — read" on public.rider_incentive_rules for select
  using (public.is_admin()
         or (public.current_role() = 'driver'
             and (active
                  or exists (select 1 from public.rider_incentive_awards a
                              where a.rule_id = rider_incentive_rules.id
                                and a.driver_id = auth.uid()))));

drop policy if exists "rider_incentive_rules — admin insert" on public.rider_incentive_rules;
create policy "rider_incentive_rules — admin insert" on public.rider_incentive_rules for insert
  with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "rider_incentive_rules — admin update" on public.rider_incentive_rules;
create policy "rider_incentive_rules — admin update" on public.rider_incentive_rules for update
  using (public.is_admin())
  with check (public.is_admin());

revoke all on public.rider_earnings, public.rider_incentive_rules, public.rider_incentive_awards,
              public.rider_adjustments, public.rider_payouts
  from anon, authenticated;
grant select on public.rider_earnings, public.rider_incentive_rules, public.rider_incentive_awards,
                public.rider_adjustments, public.rider_payouts
  to authenticated;
-- Admin writes, by column: never id, payout_id, reverses_earning_id or the
-- timestamps; a rule's period and starts_on are fixed once created (header 3).
grant insert (name, period, target_deliveries, bonus_amount, window_start, window_end,
              starts_on, ends_on, active, created_by)
  on public.rider_incentive_rules to authenticated;
grant update (name, target_deliveries, bonus_amount, window_start, window_end,
              ends_on, active)
  on public.rider_incentive_rules to authenticated;
grant insert (driver_id, kind, amount, reason, order_id, effective_on, created_by)
  on public.rider_adjustments to authenticated;
grant select, insert, update, delete
  on public.rider_earnings, public.rider_incentive_rules, public.rider_incentive_awards,
     public.rider_adjustments, public.rider_payouts
  to service_role;

revoke execute on function public.record_rider_earning()       from public, anon, authenticated;
revoke execute on function public.reverse_rider_earning()      from public, anon, authenticated;
revoke execute on function public.guard_delivered_rider()      from public, anon, authenticated;
revoke execute on function public.guard_delivery_delete()      from public, anon, authenticated;
revoke execute on function public.award_rider_incentives()     from public, anon, authenticated;
revoke execute on function public.guard_rider_ledger()         from public, anon, authenticated;
revoke execute on function public.touch_rider_incentive_rule() from public, anon, authenticated;
revoke execute on function public.record_rider_payout(uuid, date, text, text, date, text)
  from public, anon, authenticated, service_role;
grant  execute on function public.record_rider_payout(uuid, date, text, text, date, text)
  to authenticated;

commit;
