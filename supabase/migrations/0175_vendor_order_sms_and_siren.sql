-- ============================================================
-- 0175 — New-order SMS to vendors (admin-managed) and the siren alert sound.
--
-- 1. order_sms_settings (singleton) and vendor_order_sms (one row per shop):
--    the admin's "SMS a shop when a new order arrives" switch, the message
--    template, and per shop whether it gets one and on which number. Read and
--    written only by the server with the service role, behind
--    requireRole("admin") (src/lib/data-access/vendor-order-sms.ts). RLS on, no
--    policies, every privilege revoked from anon/authenticated: a shop's SMS
--    number is owner contact data, and the switch is not the vendor's to flip.
--    Separate tables rather than columns on `restaurants`, so nothing here
--    needs adding to restaurants' column grants (0024) or to the owner write
--    lock (lock_restaurant_privileged_fields, 0145).
--
-- 2. 'siren' joins the alert sound presets (0044), and becomes the vendor and
--    rider board sound where the admin had left the original 'chime' — the
--    owner's decision (2026-10-27): every new-order alert is a siren. An admin
--    who picked another preset or uploaded a file keeps it.
--
-- Order-independent: touches only its own tables and two check constraints.
-- Idempotent: safe to re-run.
-- ============================================================

begin;

-- ---------- 1. order SMS ----------

create table if not exists public.order_sms_settings (
  id          boolean primary key default true check (id),
  enabled     boolean     not null default false,
  template    text        not null default
    'Deligro: new order #{order} for {shop} ({items} items, Rs {total}). Open the Deligro Partner app to accept.'
    check (char_length(template) between 10 and 300),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);

comment on table public.order_sms_settings is
  'Admin switch + template for new-order SMS to vendors. service_role only — see migration 0175.';

insert into public.order_sms_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.vendor_order_sms (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  enabled       boolean     not null default true,
  -- E.164. Null = the shop owner's registered mobile (restaurants.owner_mobile).
  phone         text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles(id) on delete set null
);

comment on table public.vendor_order_sms is
  'Per-shop new-order SMS: on/off and the number to text. service_role only — see migration 0175.';

alter table public.order_sms_settings enable row level security;
alter table public.vendor_order_sms   enable row level security;
revoke all on public.order_sms_settings from public, anon, authenticated;
revoke all on public.vendor_order_sms   from public, anon, authenticated;
grant select, insert, update, delete on public.order_sms_settings to service_role;
grant select, insert, update, delete on public.vendor_order_sms   to service_role;

-- ---------- 2. siren preset ----------

alter table public.platform_settings
  drop constraint if exists platform_settings_vendor_alert_preset_check;
alter table public.platform_settings
  add constraint platform_settings_vendor_alert_preset_check
  check (vendor_alert_sound_preset in ('siren', 'chime', 'beep', 'alarm', 'bell'));

alter table public.platform_settings
  drop constraint if exists platform_settings_rider_alert_preset_check;
alter table public.platform_settings
  add constraint platform_settings_rider_alert_preset_check
  check (rider_alert_sound_preset in ('siren', 'chime', 'beep', 'alarm', 'bell'));

alter table public.platform_settings alter column vendor_alert_sound_preset set default 'siren';
alter table public.platform_settings alter column rider_alert_sound_preset  set default 'siren';

update public.platform_settings
   set vendor_alert_sound_preset = 'siren'
 where vendor_alert_sound_preset = 'chime' and vendor_alert_sound_url is null;
update public.platform_settings
   set rider_alert_sound_preset = 'siren'
 where rider_alert_sound_preset = 'chime' and rider_alert_sound_url is null;

commit;

-- Rollback:
--   begin;
--   drop table if exists public.vendor_order_sms;
--   drop table if exists public.order_sms_settings;
--   update public.platform_settings set vendor_alert_sound_preset = 'chime' where vendor_alert_sound_preset = 'siren';
--   update public.platform_settings set rider_alert_sound_preset  = 'chime' where rider_alert_sound_preset  = 'siren';
--   (then restore the two 0044 check constraints and 'chime' defaults)
--   commit;
