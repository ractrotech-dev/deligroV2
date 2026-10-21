-- 0150 — The Rider tables the manager rider screens need, converged.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0150.mjs); run it on staging first.
-- Depends on 0081 (rider_profiles), 0082 (delivery-proofs bucket), 0083 (the
-- rider money ledger, which it does not touch), 0047 (cod_handovers). Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-5-riders.md (S1).
--
-- Why this exists: the Manager app's rider screens (§5) read the rider money
-- ledger, ratings, cash deposits and documents. Those belong to the Rider app
-- branch (feat/rider-app) as migrations 0083–0086. 0083 (the money ledger:
-- rider_payouts, rider_earnings, rider_incentive_rules / _awards,
-- rider_adjustments, guard_rider_ledger, record_rider_payout) HAS landed and
-- is the one definition of those objects — this migration no longer touches
-- them (an earlier draft re-declared them and dropped 0083's checks, guard
-- and payout lock). 0084–0086 have not landed, so their tables are built HERE
-- with the Rider plans' exact names, columns, checks and RLS, every statement
-- guarded (`if not exists`, `drop policy if exists`), so whichever branch
-- lands first builds them and the other's copy is a no-op (AGENTS.md: one
-- source of truth).
--
-- Identical to Rider 0084 (rider_ratings + my_rider_ratings; the target
-- settings stay with the Rider branch), Rider 0085 (cash_deposits,
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
-- policy for anyone signed in except a customer's one rating, writes service
-- role. rider_documents: column grants only, never `number` (the raw identity
-- number is read by the server with the service role and masked). rider_payout_accounts and its staged table:
-- RLS on, NO policies, all privileges revoked from anon/authenticated — the
-- vendor_login_credentials containment. Riders read their ratings only through
-- my_rider_ratings (no customer_id). Managers' zone-scoped reads arrive in 0151.
--
-- Rollback:
--   drop view if exists public.my_rider_ratings;
--   drop table if exists public.rider_profile_change_requests, public.rider_payout_accounts_staged,
--     public.rider_payout_accounts, public.rider_documents, public.cash_reminders, public.cash_disputes,
--     public.cash_deposits, public.rider_ratings;
--   alter table public.rider_profiles drop column if exists address_line, … (the 0086 columns below);
--   delete from storage.buckets where id = 'rider-documents';  -- after emptying it

begin;

-- ============================================================
-- 1 — Rider 0084: ratings
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
-- 2 — Rider 0085: cash deposits, disputes, reminders
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
-- 3 — Rider 0086: profile fields, documents, payout accounts, change requests
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
-- 4 — RLS and privileges (the Rider plans' rules; managers come in 0151)
-- ============================================================
alter table public.rider_ratings                 enable row level security;
alter table public.cash_deposits                 enable row level security;
alter table public.cash_disputes                 enable row level security;
alter table public.cash_reminders                enable row level security;
alter table public.rider_documents               enable row level security;
alter table public.rider_payout_accounts         enable row level security;
alter table public.rider_payout_accounts_staged  enable row level security;
alter table public.rider_profile_change_requests enable row level security;


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

-- Writes: service role only.
revoke all on public.rider_ratings, public.cash_deposits, public.cash_disputes, public.cash_reminders,
  public.rider_documents, public.rider_profile_change_requests
  from anon, authenticated;
grant select on public.cash_deposits, public.cash_disputes, public.rider_profile_change_requests
  to authenticated;
-- Documents by column, never `number` (0151 repeats this; a table-level grant
-- would override any column revoke).
grant select (id, driver_id, doc_type, number_masked, file_path, expires_on, status, remarks, reviewed_by, reviewed_at,
              reminded_30_at, reminded_7_at, reminded_1_at, reminded_expired_at, created_at)
  on public.rider_documents to authenticated;
-- Customers insert ratings and read their own; riders use the view.
-- Column grant, not table grant: nobody signed in can select customer_id (a
-- table-level grant would override a column revoke).
grant select (id, order_id, driver_id, rating, comment, created_at) on public.rider_ratings to authenticated;
grant insert on public.rider_ratings to authenticated;
grant select on public.my_rider_ratings to authenticated;
revoke all on public.my_rider_ratings from anon;

-- Bank and UPI details: nobody signed in, ever.
revoke all on public.rider_payout_accounts, public.rider_payout_accounts_staged from anon, authenticated;

grant select, insert, update, delete on
  public.rider_ratings, public.cash_deposits, public.cash_disputes, public.cash_reminders,
  public.rider_documents, public.rider_payout_accounts, public.rider_payout_accounts_staged,
  public.rider_profile_change_requests
  to service_role;

commit;
