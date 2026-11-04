-- ============================================================
-- 0204 — The owner's Google Drive, for food photos (Admin → Storage)
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database.
-- Deploy order: … → 0203 → 0204.
--
-- One row at most: the Google account the owner connected, and the folder holding
-- the food photos dishes are matched against. The refresh token is
-- what lets the server reach Drive later, so it can't be hashed: it is stored
-- AES-256-GCM encrypted with GOOGLE_DRIVE_TOKEN_KEY, which is not in the database.
-- Reading this table alone gives nobody access to the Drive.
--
-- Contained the way vendor_login_credentials is (0039): own table, RLS on with no
-- policies, every privilege revoked from anon and authenticated, service_role only,
-- reached through server-only code behind requireRole("admin").
--
-- Rollback:
--   drop table if exists public.google_drive_connection;
-- Nothing in the Drive is touched by that. Revoke access from the Google account too.
-- ============================================================

begin;

create table if not exists public.google_drive_connection (
  id                boolean primary key default true check (id),
  google_email      text not null,
  refresh_token_enc text not null,
  folder_id         text,
  folder_name       text,
  connected_by      uuid references public.profiles (id) on delete set null,
  connected_at      timestamptz not null default now()
);

comment on table public.google_drive_connection is
  'The Google account connected for Admin → Storage (0204). Refresh token encrypted outside the database''s reach. Service role only.';

alter table public.google_drive_connection enable row level security;
revoke all on public.google_drive_connection from public, anon, authenticated;
grant select, insert, update, delete on public.google_drive_connection to service_role;

commit;
