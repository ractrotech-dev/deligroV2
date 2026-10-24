-- ============================================================
-- 0171 — Observability v2, phase 3: sign-in records (docs/OBSERVABILITY_V2.md)
-- ------------------------------------------------------------
-- obs_sign_ins: every OTP and password sign-in, succeeded or failed, with the
-- account it was FOR when that can be told (a failure is tied to the account
-- of the number typed), a device label ("Chrome on Android"), the country, and
-- whether the device or country is new for that person.
-- obs_known_devices: the devices and countries each person has signed in from.
-- A person's very first remembered sign-in is never "new" — otherwise everyone
-- is flagged on day one.
--
-- Never stored: the code, the password, the full phone number (only its last
-- four digits, to tell two numbers of one account apart), the IP address.
-- Sign-ins are kept 30 days; known devices 30 days from last use.
--
-- Written only through obs_record_sign_in (service role); read only by the
-- developer console (service role). Additive. Rollback:
--   drop function if exists public.obs_record_sign_in(text,text,text,text,uuid,text,text,text);
--   drop table if exists public.obs_known_devices;
--   drop table if exists public.obs_sign_ins;
-- ============================================================

begin;

create table if not exists public.obs_sign_ins (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  env          text        not null,
  -- 'otp' | 'password'
  method       text        not null check (method in ('otp','password')),
  outcome      text        not null check (outcome in ('success','failure')),
  -- Our own word for why it failed: invalid, expired, locked, bad_credentials, suspended…
  reason       text,
  actor_id     uuid,
  actor_role   text,
  phone_tail   text,
  device       text,
  country      text,
  new_device   boolean not null default false,
  new_country  boolean not null default false
);

create index if not exists obs_sign_ins_time_idx on public.obs_sign_ins (env, occurred_at desc);
create index if not exists obs_sign_ins_actor_idx on public.obs_sign_ins (actor_id, occurred_at desc) where actor_id is not null;

create table if not exists public.obs_known_devices (
  actor_id    uuid        not null,
  -- 'device' | 'country'
  kind        text        not null check (kind in ('device','country')),
  value       text        not null,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  primary key (actor_id, kind, value)
);

do $$
declare t text;
begin
  foreach t in array array['obs_sign_ins', 'obs_known_devices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

create or replace function public.obs_record_sign_in(
  p_env text, p_method text, p_outcome text, p_reason text,
  p_actor uuid, p_phone_tail text, p_device text, p_country text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_new_device  boolean := false;
  v_new_country boolean := false;
  v_known       int;
begin
  if p_actor is not null then
    select role::text into v_role from public.profiles where id = p_actor;
  end if;

  if p_outcome = 'success' and p_actor is not null then
    if p_device is not null then
      select count(*) into v_known from public.obs_known_devices where actor_id = p_actor and kind = 'device';
      v_new_device := v_known > 0 and not exists (
        select 1 from public.obs_known_devices where actor_id = p_actor and kind = 'device' and value = p_device);
      insert into public.obs_known_devices (actor_id, kind, value) values (p_actor, 'device', p_device)
      on conflict (actor_id, kind, value) do update set last_seen = now();
    end if;
    if p_country is not null then
      select count(*) into v_known from public.obs_known_devices where actor_id = p_actor and kind = 'country';
      v_new_country := v_known > 0 and not exists (
        select 1 from public.obs_known_devices where actor_id = p_actor and kind = 'country' and value = p_country);
      insert into public.obs_known_devices (actor_id, kind, value) values (p_actor, 'country', p_country)
      on conflict (actor_id, kind, value) do update set last_seen = now();
    end if;
  end if;

  insert into public.obs_sign_ins (env, method, outcome, reason, actor_id, actor_role, phone_tail, device, country, new_device, new_country)
  values (coalesce(p_env, 'production'), p_method, p_outcome, left(p_reason, 60), p_actor, v_role,
          left(p_phone_tail, 4), left(p_device, 80), left(p_country, 2), v_new_device, v_new_country);

  -- Keep the window: a cheap, indexed delete now and then.
  if random() < 0.02 then
    delete from public.obs_sign_ins where occurred_at < now() - interval '30 days';
    delete from public.obs_known_devices where last_seen < now() - interval '30 days';
  end if;

  return jsonb_build_object('new_device', v_new_device, 'new_country', v_new_country);
end;
$$;

comment on function public.obs_record_sign_in(text,text,text,text,uuid,text,text,text) is
  'Record one sign-in attempt and whether its device or country is new for that person (0171). Service role only; called from src/lib/obs/sign-ins.ts after the response.';

revoke all on function public.obs_record_sign_in(text,text,text,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.obs_record_sign_in(text,text,text,text,uuid,text,text,text) to service_role;

commit;
