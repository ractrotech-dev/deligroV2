-- 0150 — The Rider tables the manager rider screens need, converged.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0150.mjs); run it on staging first.
-- Depends on 0081 (rider_profiles), 0082 (delivery-proofs bucket), 0047
-- (cod_handovers). Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-5-riders.md (S1).
--
-- Why this exists: the Manager app's rider screens (§5) read the rider money
-- ledger, ratings, cash deposits and documents. Those belong to the Rider app
-- branch (feat/rider-app) as migrations 0083–0086, which have not landed. Rather
-- than wait or write a second copy, this migration builds them HERE with the
-- Rider plans' exact names, columns, checks and RLS, every statement guarded
-- (`if not exists`, `drop policy if exists`), so whichever branch lands first
-- builds them and the other's copy is a no-op (AGENTS.md: one source of truth).
--
-- Identical to Rider 0083 (money ledger, without the rate card, incentive
-- triggers and earnings trigger — those stay with the Rider branch and produce
-- no rows for salaried riders; rider_incentive_rules exists only for the
-- awards foreign key), Rider 0084 (rider_ratings + my_rider_ratings; the
-- target settings stay with the Rider branch), Rider 0085 (cash_deposits,
-- cash_disputes, cash_reminders; the threshold settings stay with the Rider
-- branch), Rider 0086 (rider_profiles columns, rider_documents,
-- rider_payout_accounts + _staged, rider_profile_change_requests, the
-- rider-documents bucket; block_dispatch_on_expired_docs stays with the Rider
-- branch). When those migrations are merged, every block below is a no-op.
--
-- Claude's call: the Rider plan does not spell out rider_payout_accounts_staged's
-- columns; it mirrors rider_payout_accounts with its own id and created_at.
--
-- Security (docs/SECURITY_AUDIT.md applies): every table RLS on, no write
-- policy for anyone signed in, writes service role (or the security definer
-- record_rider_payout, admin only). rider_payout_accounts and its staged table:
-- RLS on, NO policies, all privileges revoked from anon/authenticated — the
-- vendor_login_credentials containment. Riders read their ratings only through
-- my_rider_ratings (no customer_id). Managers' zone-scoped reads arrive in 0151.
--
-- Rollback:
--   drop function if exists public.record_rider_payout(uuid, date, text, text, date, text);
--   drop view if exists public.my_rider_ratings;
--   drop table if exists public.rider_profile_change_requests, public.rider_payout_accounts_staged,
--     public.rider_payout_accounts, public.rider_documents, public.cash_reminders, public.cash_disputes,
--     public.cash_deposits, public.rider_ratings, public.rider_incentive_awards, public.rider_adjustments,
--     public.rider_earnings, public.rider_payouts, public.rider_incentive_rules;
--   alter table public.rider_profiles drop column if exists address_line, … (the 0086 columns below);
--   delete from storage.buckets where id = 'rider-documents';  -- after emptying it

begin;

-- ============================================================
-- 1 — Rider 0083: the money ledger
-- ============================================================
create table if not exists public.rider_payouts (
  id          uuid primary key default gen_random_uuid(),
  driver_id   uuid not null references public.profiles (id) on delete cascade,
  period_end  date not null,
  amount      numeric(10,2) not null check (amount > 0),
  method      text not null check (method in ('bank', 'upi', 'cash', 'other')),
  reference   text,
  paid_on     date not null,
  note        text,
  created_by  uuid not null references public.profiles (id),
  created_at  timestamptz not null default now()
);
create index if not exists rider_payouts_driver_idx on public.rider_payouts (driver_id, paid_on desc);

create table if not exists public.rider_earnings (
  id           uuid primary key default gen_random_uuid(),
  delivery_id  uuid not null unique references public.deliveries (id) on delete cascade,
  order_id     uuid not null references public.orders (id) on delete cascade,
  driver_id    uuid not null references public.profiles (id) on delete cascade,
  earned_at    timestamptz not null,
  base_fee     numeric(10,2) not null default 0,
  distance_km  numeric(6,2),
  billable_km  numeric(6,2),
  distance_fee numeric(10,2) not null default 0,
  min_topup    numeric(10,2) not null default 0,
  tip_amount   numeric(10,2) not null default 0,
  tip_in_cash  boolean not null,
  amount       numeric(10,2) not null,
  payout_id    uuid references public.rider_payouts (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists rider_earnings_driver_idx on public.rider_earnings (driver_id, earned_at desc);
create index if not exists rider_earnings_unpaid_idx on public.rider_earnings (driver_id) where payout_id is null;

create table if not exists public.rider_incentive_rules (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  period            text not null check (period in ('daily', 'weekly')),
  target_deliveries int not null check (target_deliveries > 0),
  bonus_amount      numeric(10,2) not null check (bonus_amount > 0),
  window_start      time,
  window_end        time,
  starts_on         date not null,
  ends_on           date,
  active            boolean not null default true,
  created_by        uuid references public.profiles (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint rider_incentive_rules_window check ((window_start is null) = (window_end is null))
);

create table if not exists public.rider_incentive_awards (
  id                  uuid primary key default gen_random_uuid(),
  rule_id             uuid not null references public.rider_incentive_rules (id) on delete cascade,
  driver_id           uuid not null references public.profiles (id) on delete cascade,
  period_start        date not null,
  deliveries_count    int not null,
  amount              numeric(10,2) not null,
  trigger_delivery_id uuid,
  awarded_at          timestamptz not null default now(),
  notified_at         timestamptz,
  payout_id           uuid references public.rider_payouts (id) on delete set null,
  unique (rule_id, driver_id, period_start)
);

create table if not exists public.rider_adjustments (
  id           uuid primary key default gen_random_uuid(),
  driver_id    uuid not null references public.profiles (id) on delete cascade,
  kind         text not null check (kind in ('bonus', 'adjustment', 'deduction', 'salary')),
  amount       numeric(10,2) not null,
  reason       text not null,
  order_id     uuid references public.orders (id) on delete set null,
  effective_on date not null,
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  payout_id    uuid references public.rider_payouts (id) on delete set null,
  -- bonus / salary / deduction are positive (a deduction is subtracted);
  -- an adjustment is any non-zero amount.
  constraint rider_adjustments_amount check (
    (kind in ('bonus', 'salary', 'deduction') and amount > 0) or (kind = 'adjustment' and amount <> 0)
  )
);
create index if not exists rider_adjustments_driver_idx on public.rider_adjustments (driver_id, effective_on desc);

-- Settles everything unpaid up to p_period_end in one statement set: lock the
-- rider's unattached rows, sum them, refuse a net ≤ 0, insert the payout,
-- attach every summed row to it. Admin only (0152 adds the manager path through
-- maker–checker payment requests on top of the same arithmetic).
create or replace function public.record_rider_payout(
  p_driver uuid, p_period_end date, p_method text, p_reference text, p_paid_on date, p_note text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  net    numeric(12,2);
  payout uuid;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform 1 from public.rider_earnings
   where driver_id = p_driver and payout_id is null
     and (earned_at at time zone 'Asia/Kolkata')::date <= p_period_end for update;
  perform 1 from public.rider_incentive_awards
   where driver_id = p_driver and payout_id is null
     and (awarded_at at time zone 'Asia/Kolkata')::date <= p_period_end for update;
  perform 1 from public.rider_adjustments
   where driver_id = p_driver and payout_id is null and effective_on <= p_period_end for update;

  select coalesce((select sum(amount) from public.rider_earnings
                    where driver_id = p_driver and payout_id is null
                      and (earned_at at time zone 'Asia/Kolkata')::date <= p_period_end), 0)
       + coalesce((select sum(amount) from public.rider_incentive_awards
                    where driver_id = p_driver and payout_id is null
                      and (awarded_at at time zone 'Asia/Kolkata')::date <= p_period_end), 0)
       + coalesce((select sum(case when kind = 'deduction' then -amount else amount end)
                     from public.rider_adjustments
                    where driver_id = p_driver and payout_id is null and effective_on <= p_period_end), 0)
    into net;

  if net <= 0 then
    raise exception 'nothing_to_pay' using errcode = '22023';
  end if;

  insert into public.rider_payouts (driver_id, period_end, amount, method, reference, paid_on, note, created_by)
  values (p_driver, p_period_end, net, p_method, nullif(trim(p_reference), ''), p_paid_on, nullif(trim(p_note), ''), auth.uid())
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
revoke execute on function public.record_rider_payout(uuid, date, text, text, date, text) from public, anon;
grant execute on function public.record_rider_payout(uuid, date, text, text, date, text) to authenticated, service_role;

-- ============================================================
-- 2 — Rider 0084: ratings
-- ============================================================
create table if not exists public.rider_ratings (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique,
  driver_id   uuid not null references public.profiles (id) on delete cascade,
  customer_id uuid not null references public.profiles (id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  comment     text check (comment is null or char_length(comment) <= 300),
  created_at  timestamptz not null default now()
);
create index if not exists rider_ratings_driver_idx on public.rider_ratings (driver_id, created_at desc);

-- The rider's view of their ratings: never who left them.
create or replace view public.my_rider_ratings
with (security_invoker = false) as
  select id, order_id, driver_id, rating, comment, created_at
    from public.rider_ratings
   where driver_id = auth.uid();

-- ============================================================
-- 3 — Rider 0085: cash deposits, disputes, reminders
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
-- 4 — Rider 0086: profile fields, documents, payout accounts, change requests
-- ============================================================
alter table public.rider_profiles
  add column if not exists address_line         text,
  add column if not exists city                 text,
  add column if not exists pincode              text check (pincode ~ '^\d{6}$'),
  add column if not exists vehicle_type         text check (vehicle_type in ('ev_bike', 'bike', 'scooter', 'bicycle', 'other')),
  add column if not exists vehicle_owner        text default 'deligro' check (vehicle_owner in ('deligro', 'rider')),
  add column if not exists vehicle_registration text,
  add column if not exists licence_number       text,
  add column if not exists licence_expires_on   date,
  add column if not exists emergency_name       text,
  add column if not exists emergency_phone      text check (emergency_phone ~ '^\+?\d{10,13}$'),
  add column if not exists emergency_relation   text,
  add column if not exists verification_status  text not null default 'unverified'
                                                check (verification_status in ('unverified', 'pending', 'verified', 'rejected')),
  add column if not exists verified_at          timestamptz,
  add column if not exists verified_by          uuid references public.profiles (id) on delete set null,
  add column if not exists notification_prefs   jsonb not null default '{}',
  add column if not exists nav_app              text,
  add column if not exists language             text default 'en';

create table if not exists public.rider_documents (
  id                  uuid primary key default gen_random_uuid(),
  driver_id           uuid not null references public.profiles (id) on delete cascade,
  doc_type            text not null check (doc_type in ('aadhaar', 'pan', 'driving_licence', 'vehicle_rc', 'insurance', 'puc', 'photo')),
  number_masked       text,
  number              text,
  file_path           text not null,
  expires_on          date,
  status              text not null default 'pending' check (status in ('pending', 'verified', 'rejected', 'expired', 'replaced')),
  remarks             text,
  reviewed_by         uuid references public.profiles (id) on delete set null,
  reviewed_at         timestamptz,
  reminded_30_at      timestamptz,
  reminded_7_at       timestamptz,
  reminded_1_at       timestamptz,
  reminded_expired_at timestamptz,
  created_at          timestamptz not null default now()
);
create unique index if not exists rider_documents_one_active_idx
  on public.rider_documents (driver_id, doc_type) where status <> 'replaced';
create index if not exists rider_documents_status_idx on public.rider_documents (status, created_at);

create table if not exists public.rider_payout_accounts (
  driver_id      uuid primary key references public.profiles (id) on delete cascade,
  kind           text not null check (kind in ('bank', 'upi')),
  holder_name    text,
  account_number text,
  ifsc           text check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  upi_id         text,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles (id) on delete set null
);

create table if not exists public.rider_payout_accounts_staged (
  id             uuid primary key default gen_random_uuid(),
  driver_id      uuid not null references public.profiles (id) on delete cascade,
  kind           text not null check (kind in ('bank', 'upi')),
  holder_name    text,
  account_number text,
  ifsc           text check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  upi_id         text,
  created_at     timestamptz not null default now()
);

create table if not exists public.rider_profile_change_requests (
  id            uuid primary key default gen_random_uuid(),
  driver_id     uuid not null references public.profiles (id) on delete cascade,
  field         text not null check (field in ('full_name', 'licence', 'vehicle', 'payout_account')),
  new_value     jsonb not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by    uuid references public.profiles (id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);
create unique index if not exists rider_profile_change_requests_one_pending_idx
  on public.rider_profile_change_requests (driver_id, field) where status = 'pending';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rider-documents', 'rider-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================
-- 5 — RLS and privileges (the Rider plans' rules; managers come in 0151)
-- ============================================================
alter table public.rider_payouts                 enable row level security;
alter table public.rider_earnings                enable row level security;
alter table public.rider_incentive_rules         enable row level security;
alter table public.rider_incentive_awards        enable row level security;
alter table public.rider_adjustments             enable row level security;
alter table public.rider_ratings                 enable row level security;
alter table public.cash_deposits                 enable row level security;
alter table public.cash_disputes                 enable row level security;
alter table public.cash_reminders                enable row level security;
alter table public.rider_documents               enable row level security;
alter table public.rider_payout_accounts         enable row level security;
alter table public.rider_payout_accounts_staged  enable row level security;
alter table public.rider_profile_change_requests enable row level security;

drop policy if exists "rider_payouts — read" on public.rider_payouts;
create policy "rider_payouts — read" on public.rider_payouts for select
  using (driver_id = auth.uid() or public.is_admin());
drop policy if exists "rider_earnings — read" on public.rider_earnings;
create policy "rider_earnings — read" on public.rider_earnings for select
  using (driver_id = auth.uid() or public.is_admin());
drop policy if exists "rider_incentive_awards — read" on public.rider_incentive_awards;
create policy "rider_incentive_awards — read" on public.rider_incentive_awards for select
  using (driver_id = auth.uid() or public.is_admin());
drop policy if exists "rider_adjustments — read" on public.rider_adjustments;
create policy "rider_adjustments — read" on public.rider_adjustments for select
  using (driver_id = auth.uid() or public.is_admin());
drop policy if exists "rider_adjustments — admin write" on public.rider_adjustments;
create policy "rider_adjustments — admin write" on public.rider_adjustments for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "rider_incentive_rules — read" on public.rider_incentive_rules;
create policy "rider_incentive_rules — read" on public.rider_incentive_rules for select
  using (public.is_admin() or (active and public.current_role() = 'driver'));
drop policy if exists "rider_incentive_rules — admin write" on public.rider_incentive_rules;
create policy "rider_incentive_rules — admin write" on public.rider_incentive_rules for all
  using (public.is_admin()) with check (public.is_admin());

-- Ratings: the customer inserts once for their own delivered order with that
-- rider; riders read through my_rider_ratings only.
drop policy if exists "rider_ratings — customer insert" on public.rider_ratings;
create policy "rider_ratings — customer insert" on public.rider_ratings for insert
  with check (
    customer_id = auth.uid()
    and exists (
      select 1 from public.orders o
        join public.deliveries d on d.order_id = o.id
       where o.id = rider_ratings.order_id
         and o.customer_id = auth.uid()
         and o.status = 'delivered'
         and d.driver_id = rider_ratings.driver_id
    )
  );
drop policy if exists "rider_ratings — read" on public.rider_ratings;
create policy "rider_ratings — read" on public.rider_ratings for select
  using (customer_id = auth.uid() or public.is_admin());

drop policy if exists "cash_deposits — read" on public.cash_deposits;
create policy "cash_deposits — read" on public.cash_deposits for select
  using (driver_id = auth.uid() or public.is_admin());
drop policy if exists "cash_disputes — read" on public.cash_disputes;
create policy "cash_disputes — read" on public.cash_disputes for select
  using (driver_id = auth.uid() or public.is_admin());

drop policy if exists "rider_documents — read" on public.rider_documents;
create policy "rider_documents — read" on public.rider_documents for select
  using (driver_id = auth.uid() or public.is_admin());
drop policy if exists "rider_profile_change_requests — read" on public.rider_profile_change_requests;
create policy "rider_profile_change_requests — read" on public.rider_profile_change_requests for select
  using (driver_id = auth.uid() or public.is_admin());

-- Writes: service role (and the security definer function above) only.
revoke all on public.rider_payouts, public.rider_earnings, public.rider_incentive_awards,
  public.rider_ratings, public.cash_deposits, public.cash_disputes, public.cash_reminders,
  public.rider_documents, public.rider_profile_change_requests
  from anon, authenticated;
grant select on public.rider_payouts, public.rider_earnings, public.rider_incentive_awards,
  public.cash_deposits, public.cash_disputes, public.rider_documents, public.rider_profile_change_requests
  to authenticated;
-- Customers insert ratings and read their own; riders use the view.
-- Column grant, not table grant: nobody signed in can select customer_id (a
-- table-level grant would override a column revoke).
grant select (id, order_id, driver_id, rating, comment, created_at) on public.rider_ratings to authenticated;
grant insert on public.rider_ratings to authenticated;
revoke all on public.rider_incentive_rules, public.rider_adjustments from anon;
grant select, insert, update, delete on public.rider_incentive_rules, public.rider_adjustments to authenticated;
grant select on public.my_rider_ratings to authenticated;
revoke all on public.my_rider_ratings from anon;

-- Bank and UPI details: nobody signed in, ever.
revoke all on public.rider_payout_accounts, public.rider_payout_accounts_staged from anon, authenticated;

grant select, insert, update, delete on
  public.rider_payouts, public.rider_earnings, public.rider_incentive_rules, public.rider_incentive_awards,
  public.rider_adjustments, public.rider_ratings, public.cash_deposits, public.cash_disputes, public.cash_reminders,
  public.rider_documents, public.rider_payout_accounts, public.rider_payout_accounts_staged,
  public.rider_profile_change_requests
  to service_role;

commit;
