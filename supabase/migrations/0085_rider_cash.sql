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
--
-- Rollback (destroys the deposit and dispute history — export it first). The
-- proof runs this block:
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

commit;
