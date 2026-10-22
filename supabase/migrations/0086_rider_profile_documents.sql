-- ============================================================
-- 0086 — Rider profile and documents: profile fields, identity documents,
--        payout accounts, change requests
-- STATUS: PENDING APPROVAL — not applied to any database. Staging first.
--         Requires 0081 (rider_profiles). Independent of 0082 / 0083.
-- ------------------------------------------------------------
-- Phase 6 of the rider app (plan: docs/superpowers/plans/
-- 2026-10-21-rider-app-phase-6-profile-documents.md; design: docs/superpowers/
-- specs/2026-10-21-rider-app-design.md, "Profile and documents (§12)").
--
--   1. `rider_profiles` gains the profile: address, vehicle (type, who owns
--      it, registration), driving licence (number, expiry), emergency
--      contact, verification (`unverified` → `pending` → `verified` |
--      `rejected`, with who verified and when), notification and navigation
--      preferences, language.
--   2. `rider_documents` — one row per uploaded file in the private
--      `rider-documents` bucket: Aadhaar, PAN, driving licence, vehicle RC,
--      insurance, PUC, photo. One live (non-`replaced`) row per type and
--      rider (partial UNIQUE). `number_masked` is what anyone signed in may
--      read; `number` is never granted to a client.
--      AADHAAR IS NEVER STORED IN FULL: `mask_rider_aadhaar` (BEFORE INSERT OR
--      UPDATE, every writer, the service role included) turns any Aadhaar
--      `number` into `number_masked = 'XXXX-XXXX-<last 4>'` and clears
--      `number`, so no code path — this branch's or another's — can keep the
--      twelve digits.
--   3. `rider_payout_accounts` — bank or UPI details, one row per rider. The
--      `vendor_login_credentials` containment (0039, AGENTS.md rule 4): RLS
--      on, NO policies, every privilege revoked from anon and authenticated,
--      service role only, reached only through the `server-only`
--      src/lib/data-access/rider-payout-accounts.ts behind an admin check
--      (the rider's own routes get the masked form only).
--      `rider_payout_accounts_staged` holds a rider's PROPOSED account while
--      the change request waits, with the same containment.
--   4. `rider_profile_change_requests` — a change to a verified field (name,
--      licence, vehicle) or to the payout account waits for an admin. One
--      pending request per (rider, field). `new_value` is never granted to a
--      client (it holds a licence or registration number); for
--      `payout_account` it is only `{"stagedId": <rider_payout_accounts_staged.id>}`
--      — the account itself never enters this table.
--   5. `rider_add_document(...)` — the rider's upload, atomically: the
--      previous live document of that type becomes `replaced`, the new one is
--      `pending`. An unverified rider's verification goes to `pending`; a
--      VERIFIED rider stays verified (ruling P6-R1) — only the new document
--      waits for review — and a REJECTED rider stays rejected until staff
--      act (ruling P8-R9).
--   6. `rider_decide_change_request(...)` — approve (apply the value; a
--      payout change copies the staged row into rider_payout_accounts and
--      deletes it) or reject (a staged account is deleted), atomically, once.
--      Applying without an admin (p_actor null) is refused for the payout
--      account and for any rider who has EVER been verified (verified_at set):
--      those changes need an admin, whatever the rider's status is now.
--   7. `guard_rider_verified_name` — a rider who has ever been verified
--      (verified_at set) cannot rename themselves through their own JWT
--      (0001's "own profile — update" would otherwise allow it): the name
--      changes through a change request. Admins and the service role are not
--      affected.
--   7a. `rider_profiles.verification_note` — the admin's note on the overall
--      verification decision (kept, not only pushed). Not granted to clients;
--      the rider reads it through the server.
--   8. `platform_settings.block_dispatch_on_expired_docs` (default false):
--      when on, dispatch skips riders holding an expired document and the
--      app refuses their accept (src/lib/rider/profile-rules.ts).
--   9. Private bucket `rider-documents`: 10 MB, PDF / JPEG / PNG. No
--      storage.objects policies: uploads and 10-minute signed URLs go through
--      the service role only, behind the rider's own session or an admin.
--
-- COORDINATION — the Manager-app branch built these same objects first, in
-- its 0150_rider_tables_converge.sql ("Rider 0086" section), and 0151 adds
-- column grants and ops_* RPCs. Every object in sections 1–4 and 9 here is
-- IDENTICAL to 0150 (names, columns, types, defaults, checks, indexes,
-- policies, grants), and every statement is guarded (`if not exists`,
-- `drop policy if exists`, `on conflict`), so whichever migration lands first
-- builds them and the other is a no-op. The rider_profiles column grant
-- (section 10) is identical to 0151's. What 0086 ADDS to that shape — none of
-- it conflicts with 0150 / 0151, and all of it is applied whichever lands
-- first: the Aadhaar masking trigger, guard_rider_verified_name, the two
-- functions, the platform setting. The proof
-- (scripts/qa/sql/migration-0086.mjs) applies 0086 alone, 0150 then 0086,
-- and 0086 then 0150, and checks the three databases match.
--
-- Security (docs/SECURITY_AUDIT.md applies — personal, statutory and
-- money-routing data):
--   * Every new table has RLS on. rider_documents and
--     rider_profile_change_requests: SELECT own rows (driver_id = auth.uid())
--     or is_admin(); no write policy; writes revoked from anon/authenticated;
--     SELECT granted BY COLUMN (never rider_documents.number, never
--     rider_profile_change_requests.new_value).
--   * rider_payout_accounts and rider_payout_accounts_staged: RLS on with NO
--     policies, every privilege revoked from anon and authenticated.
--   * rider_profiles: 0081 granted SELECT on the whole table and lets every
--     manager read every row; this migration adds a licence number to it, so
--     SELECT becomes a column grant WITHOUT licence_number (AGENTS.md rule 1:
--     RLS filters rows, not columns). The rider's own licence number reaches
--     them through the server. Address and emergency contact stay readable by
--     managers, as the rest of the row is (dispatch and safety calls need them).
--   * "Ever verified" is `verified_at is not null` everywhere a verified field
--     is protected, so a status that moves (an upload, a rejection) can never
--     reopen a field that was verified once.
--   * The two functions are SECURITY DEFINER with search_path pinned, EXECUTE
--     for service_role only. The trigger functions have EXECUTE revoked from
--     PUBLIC, anon and authenticated (0054).
--   * block_dispatch_on_expired_docs is granted by column to anon and
--     authenticated, as every other rider setting: a boolean, and the settings
--     facade reads with the caller's client.
--
-- Idempotent: safe to re-run.
-- Re-run rule (ruling P8-R3): re-apply every migration from 0081 through the
-- newest one applied, all branches, in number order — never this file or the
-- rider files alone (Manager 0141, 0142 and 0152 narrow what they open).
--
-- Rollback (destroys documents' rows and payout details — export first; empty
-- the bucket before deleting it):
--   drop trigger if exists guard_rider_verified_name on public.profiles;
--   drop trigger if exists mask_rider_aadhaar on public.rider_documents;
--   drop function if exists public.rider_decide_change_request(uuid, uuid, text, text),
--                           public.rider_add_document(uuid, text, text, text, text, date),
--                           public.guard_rider_verified_name(),
--                           public.mask_rider_aadhaar();
--   drop table if exists public.rider_profile_change_requests, public.rider_payout_accounts_staged,
--                        public.rider_payout_accounts, public.rider_documents;
--   alter table public.platform_settings drop column if exists block_dispatch_on_expired_docs;
--   alter table public.rider_profiles drop column if exists verification_note;
--   alter table public.rider_profiles
--     drop column if exists address_line, drop column if exists city, drop column if exists pincode,
--     drop column if exists vehicle_type, drop column if exists vehicle_owner,
--     drop column if exists vehicle_registration, drop column if exists licence_number,
--     drop column if exists licence_expires_on, drop column if exists emergency_name,
--     drop column if exists emergency_phone, drop column if exists emergency_relation,
--     drop column if exists verification_status, drop column if exists verified_at,
--     drop column if exists verified_by, drop column if exists notification_prefs,
--     drop column if exists nav_app, drop column if exists language;
--   revoke select on public.rider_profiles from authenticated; -- also clears the column grants below
--   grant select on public.rider_profiles to authenticated;    -- 0081's table grant
--   delete from storage.buckets where id = 'rider-documents';  -- after emptying it
-- (Skip the table drops if 0150 is applied: they are its tables too.)
-- ============================================================

begin;

-- ============================================================
-- 1 — rider_profiles: the profile (identical to 0150 §3)
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

-- 0086 only (not in 0150): the admin's note on the verification decision.
alter table public.rider_profiles add column if not exists verification_note text
  check (verification_note is null or char_length(verification_note) <= 300);

comment on column public.rider_profiles.licence_number is
  'Driving licence number, in full (0086). Not granted to anon/authenticated: read by the server and shown to the rider and admins only.';
comment on column public.rider_profiles.verification_status is
  'unverified | pending (documents waiting for review) | verified | rejected. Written by the service role (an unverified rider''s upload sets pending; staff decide; rejected stays rejected until staff act).';

-- ============================================================
-- 2 — rider_documents (identical to 0150 §3)
-- ============================================================
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

comment on table public.rider_documents is
  'A rider''s identity and vehicle documents (0086). The file is in the private rider-documents bucket at <driver_id>/<doc_type>/<uuid>.<ext>, served only through 10-minute signed URLs. number is never granted to a client; Aadhaar is stored masked only (mask_rider_aadhaar).';

-- Aadhaar: the last four digits only, whoever writes the row.
create or replace function public.mask_rider_aadhaar()
returns trigger
language plpgsql set search_path = public as $$
declare
  digits text;
begin
  -- Rebuilt from whichever column the writer filled, so neither `number` nor a
  -- `number_masked` that was handed the full twelve digits can keep them.
  if new.doc_type = 'aadhaar' then
    if new.number is not null or new.number_masked is not null then
      digits := regexp_replace(coalesce(new.number, new.number_masked), '\D', '', 'g');
      new.number_masked := case when char_length(digits) >= 4
                                then 'XXXX-XXXX-' || right(digits, 4)
                                else 'XXXX-XXXX-XXXX' end;
    end if;
    new.number := null;
  end if;
  return new;
end;
$$;

drop trigger if exists mask_rider_aadhaar on public.rider_documents;
create trigger mask_rider_aadhaar
  before insert or update on public.rider_documents
  for each row execute function public.mask_rider_aadhaar();

-- ============================================================
-- 3 — payout accounts (identical to 0150 §3)
-- ============================================================
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

comment on table public.rider_payout_accounts is
  'Rider bank / UPI details (0086). vendor_login_credentials containment: RLS on, no policies, no privileges for anon/authenticated, service role only via src/lib/data-access/rider-payout-accounts.ts behind an admin check.';
comment on table public.rider_payout_accounts_staged is
  'A rider''s proposed payout account while its change request is pending (0086). Same containment as rider_payout_accounts; deleted when the request is decided.';

-- ============================================================
-- 4 — change requests (identical to 0150 §3)
-- ============================================================
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

comment on column public.rider_profile_change_requests.new_value is
  'full_name {fullName} | licence {number, expiresOn} | vehicle {type, owner, registration} | payout_account {stagedId} only. Never granted to a client.';

-- ============================================================
-- 5 — rider_add_document: the rider's upload, atomically
-- ============================================================
-- The server has already checked the file's bytes and put it at
-- <driver>/<type>/<uuid>.<ext>; this records it. Raises (22023) bad_type,
-- expiry_required; (42501) forbidden for a path outside the rider's folder,
-- not_rider for an id that is not a driver.
create or replace function public.rider_add_document(
  p_driver uuid, p_type text, p_number text, p_number_masked text, p_file_path text, p_expires_on date
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  doc uuid;
begin
  if p_type is null or p_type not in ('aadhaar', 'pan', 'driving_licence', 'vehicle_rc', 'insurance', 'puc', 'photo') then
    raise exception 'bad_type' using errcode = '22023';
  end if;
  if p_type in ('driving_licence', 'insurance', 'puc') and p_expires_on is null then
    raise exception 'expiry_required' using errcode = '22023';
  end if;
  if p_file_path is null or p_file_path not like p_driver::text || '/' || p_type || '/%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_driver and role = 'driver') then
    raise exception 'not_rider' using errcode = '42501';
  end if;

  -- One upload at a time per rider: the profile row is the lock.
  insert into public.rider_profiles (driver_id)
  select p_driver where not exists (select 1 from public.rider_profiles where driver_id = p_driver)
  on conflict (driver_id) do nothing;
  perform 1 from public.rider_profiles where driver_id = p_driver for update;

  update public.rider_documents set status = 'replaced'
   where driver_id = p_driver and doc_type = p_type and status <> 'replaced';
  insert into public.rider_documents (driver_id, doc_type, number, number_masked, file_path, expires_on, status)
  values (p_driver, p_type, nullif(trim(coalesce(p_number, '')), ''), p_number_masked, p_file_path, p_expires_on, 'pending')
  returning id into doc;

  -- Ruling P6-R1: a verified (or already pending) rider keeps their status;
  -- only the new document waits for review. Ruling P8-R9: only an
  -- UNVERIFIED rider moves to pending — a rider staff rejected stays rejected
  -- (and cannot work, Manager 0151 rider_can_work) until staff act; an upload
  -- never reopens review by itself.
  update public.rider_profiles
     set verification_status = case when verification_status = 'unverified'
                                    then 'pending' else verification_status end,
         updated_at = now()
   where driver_id = p_driver;
  return doc;
end;
$$;

-- ============================================================
-- 6 — rider_decide_change_request: approve (apply) or reject, once
-- ============================================================
-- p_actor: the admin deciding, or null when the server applies a change
-- directly (a field that needs no approval: the rider is not verified yet).
-- Raises (P0002) not_found; (22023) already_decided, invalid_decision,
-- reason_required (a rejection needs a note of 3–300 characters),
-- invalid_value (the stored value is not the field's shape), staged_missing.
create or replace function public.rider_decide_change_request(
  p_request uuid, p_actor uuid, p_decision text, p_note text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  req    public.rider_profile_change_requests%rowtype;
  staged public.rider_payout_accounts_staged%rowtype;
  v      jsonb;
  note   constant text := nullif(trim(coalesce(p_note, '')), '');
  target text;
begin
  select * into req from public.rider_profile_change_requests where id = p_request for update;
  if req.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if req.status <> 'pending' then
    raise exception 'already_decided' using errcode = '22023';
  end if;
  target := case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' end;
  if target is null then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;
  if target = 'rejected' and (note is null or char_length(note) < 3 or char_length(note) > 300) then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if note is not null and char_length(note) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  -- Only an admin applies a payout account, or anything for a rider who has
  -- ever been verified.
  if target = 'approved' and p_actor is null
     and (req.field = 'payout_account'
          or exists (select 1 from public.rider_profiles
                      where driver_id = req.driver_id and verified_at is not null)) then
    raise exception 'approval_required' using errcode = '42501';
  end if;

  v := req.new_value;
  if target = 'approved' then
    if req.field = 'full_name' then
      if coalesce(jsonb_typeof(v -> 'fullName'), '') <> 'string'
         or char_length(trim(v ->> 'fullName')) not between 2 and 80 then
        raise exception 'invalid_value' using errcode = '22023';
      end if;
      update public.profiles set full_name = trim(v ->> 'fullName') where id = req.driver_id;
    elsif req.field = 'licence' then
      if coalesce(jsonb_typeof(v -> 'number'), '') <> 'string' or coalesce(jsonb_typeof(v -> 'expiresOn'), '') <> 'string' then
        raise exception 'invalid_value' using errcode = '22023';
      end if;
      insert into public.rider_profiles (driver_id)
      select req.driver_id where not exists (select 1 from public.rider_profiles where driver_id = req.driver_id)
      on conflict (driver_id) do nothing;
      update public.rider_profiles
         set licence_number = v ->> 'number', licence_expires_on = (v ->> 'expiresOn')::date, updated_at = now()
       where driver_id = req.driver_id;
    elsif req.field = 'vehicle' then
      if coalesce(jsonb_typeof(v -> 'type'), '') <> 'string' or coalesce(jsonb_typeof(v -> 'owner'), '') <> 'string' then
        raise exception 'invalid_value' using errcode = '22023';
      end if;
      insert into public.rider_profiles (driver_id)
      select req.driver_id where not exists (select 1 from public.rider_profiles where driver_id = req.driver_id)
      on conflict (driver_id) do nothing;
      update public.rider_profiles
         set vehicle_type = v ->> 'type', vehicle_owner = v ->> 'owner',
             vehicle_registration = nullif(v ->> 'registration', ''), updated_at = now()
       where driver_id = req.driver_id;
    elsif req.field = 'payout_account' then
      if coalesce(v ->> 'stagedId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'invalid_value' using errcode = '22023';
      end if;
      select * into staged from public.rider_payout_accounts_staged
       where id = (v ->> 'stagedId')::uuid and driver_id = req.driver_id;
      if staged.id is null then
        raise exception 'staged_missing' using errcode = '22023';
      end if;
      insert into public.rider_payout_accounts (driver_id, kind, holder_name, account_number, ifsc, upi_id, updated_at, updated_by)
      values (req.driver_id, staged.kind, staged.holder_name, staged.account_number, staged.ifsc, staged.upi_id, now(), p_actor)
      on conflict (driver_id) do update
        set kind = excluded.kind, holder_name = excluded.holder_name, account_number = excluded.account_number,
            ifsc = excluded.ifsc, upi_id = excluded.upi_id, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by;
      delete from public.rider_payout_accounts_staged where id = staged.id;
    end if;
  elsif req.field = 'payout_account'
        and coalesce(v ->> 'stagedId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    delete from public.rider_payout_accounts_staged
     where id = (v ->> 'stagedId')::uuid and driver_id = req.driver_id;
  end if;

  update public.rider_profile_change_requests
     set status = target, decided_by = p_actor, decided_at = now(), decision_note = note
   where id = req.id;
  return jsonb_build_object('id', req.id, 'driverId', req.driver_id, 'field', req.field, 'status', target);
end;
$$;

-- ============================================================
-- 7 — guard_rider_verified_name
-- ============================================================
-- SECURITY INVOKER on purpose: current_user must be the caller's role. A
-- definer function (the two above, 0151's ops_*) runs as the owner and passes.
create or replace function public.guard_rider_verified_name()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.full_name is distinct from old.full_name
     and old.role::text = 'driver'
     and current_user in ('anon', 'authenticated')
     and not public.is_admin()
     and exists (select 1 from public.rider_profiles rp
                  where rp.driver_id = old.id and rp.verified_at is not null) then
    raise exception 'needs_approval' using errcode = '42501',
      hint = 'A verified rider''s name changes through a change request.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_rider_verified_name on public.profiles;
create trigger guard_rider_verified_name
  before update of full_name on public.profiles
  for each row execute function public.guard_rider_verified_name();

-- ============================================================
-- 8 — platform_settings: block dispatch on expired documents
-- ============================================================
alter table public.platform_settings
  add column if not exists block_dispatch_on_expired_docs boolean not null default false;

comment on column public.platform_settings.block_dispatch_on_expired_docs is
  'When true, a rider holding an expired document (one that applies to them) is not offered orders and cannot accept one (0086). Default false: an expiry is flagged and pushed, not enforced.';

-- Column-granted since 0032: invisible until granted. The settings facade reads
-- with the caller's client (see 0083's note on anon).
grant select (block_dispatch_on_expired_docs) on public.platform_settings to anon, authenticated;

-- ============================================================
-- 9 — the rider-documents bucket (identical to 0150 §3)
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rider-documents', 'rider-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================
-- 10 — RLS and privileges (identical to 0150 §4 for these tables; the
--      rider_profiles column grant is identical to 0151's)
-- ============================================================
alter table public.rider_documents               enable row level security;
alter table public.rider_payout_accounts         enable row level security;
alter table public.rider_payout_accounts_staged  enable row level security;
alter table public.rider_profile_change_requests enable row level security;

drop policy if exists "rider_documents — read" on public.rider_documents;
create policy "rider_documents — read" on public.rider_documents for select
  using (driver_id = auth.uid() or public.is_admin());
drop policy if exists "rider_profile_change_requests — read" on public.rider_profile_change_requests;
create policy "rider_profile_change_requests — read" on public.rider_profile_change_requests for select
  using (driver_id = auth.uid() or public.is_admin());

-- Writes: service role only.
revoke all on public.rider_documents, public.rider_profile_change_requests from anon, authenticated;
-- By column: never rider_documents.number, never change_requests.new_value
-- (a table-level grant would override any column revoke).
grant select (id, driver_id, doc_type, number_masked, file_path, expires_on, status, remarks, reviewed_by, reviewed_at,
              reminded_30_at, reminded_7_at, reminded_1_at, reminded_expired_at, created_at)
  on public.rider_documents to authenticated;
grant select (id, driver_id, field, status, decided_by, decided_at, decision_note, created_at)
  on public.rider_profile_change_requests to authenticated;

-- Bank and UPI details: nobody signed in, ever. No policy, no privilege.
revoke all on public.rider_payout_accounts, public.rider_payout_accounts_staged from anon, authenticated;

grant select, insert, update, delete on
  public.rider_documents, public.rider_payout_accounts, public.rider_payout_accounts_staged,
  public.rider_profile_change_requests
  to service_role;

-- rider_profiles: by column from now on, never licence_number.
revoke select on public.rider_profiles from authenticated;
grant select (driver_id, rider_code, created_at, updated_at, address_line, city, pincode, vehicle_type, vehicle_owner,
              vehicle_registration, licence_expires_on, emergency_name, emergency_phone, emergency_relation,
              verification_status, verified_at, verified_by, notification_prefs, nav_app, language)
  on public.rider_profiles to authenticated;

revoke execute on function public.mask_rider_aadhaar()        from public, anon, authenticated;
revoke execute on function public.guard_rider_verified_name() from public, anon, authenticated;
revoke execute on function public.rider_add_document(uuid, text, text, text, text, date)    from public, anon, authenticated;
revoke execute on function public.rider_decide_change_request(uuid, uuid, text, text)       from public, anon, authenticated;
grant  execute on function public.rider_add_document(uuid, text, text, text, text, date)    to service_role;
grant  execute on function public.rider_decide_change_request(uuid, uuid, text, text)       to service_role;

commit;
