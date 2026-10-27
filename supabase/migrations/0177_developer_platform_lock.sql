-- 0177 — Developer platform lock: the platform developer can pause operations.
--
-- A visible, documented switch in the Developer panel (Operations), for the
-- developer only:
--   off     — normal.
--   orders  — no new orders anywhere. Customers see the developer's message in
--             the maintenance banner every app and the site already show.
--   full    — as `orders`, and the Admin console and the Manager app show a
--             "paused by the platform developer" screen. Shops and riders can
--             still finish orders already placed.
--
-- How it holds: the lock lives on platform_settings (dev_lock_*). Setting it
-- also turns accepting_orders off and puts the message in maintenance_message,
-- which every customer surface — including app versions already installed —
-- reads today. A guard stops anyone but set_platform_lock (the developer) from
-- changing the lock, or switching ordering back on, while it is set; an order
-- insert guard refuses new orders as a second line. Lifting it restores the
-- ordering switch and message the admin had before.
--
-- An admin cannot get around it from their own login: the settings row cannot
-- be deleted (an absent row reads as "accepting orders") while it is locked,
-- and no app login — admins included — can make an account a developer or
-- take that role away (guard_developer_role); only the service role can.
--
-- What it cannot stop: whoever owns the database can drop these triggers. It is
-- a switch, not DRM, and the panel says so.
--
-- Rollback:
--   drop trigger if exists guard_orders_platform_lock on public.orders;
--   drop function if exists public.guard_orders_platform_lock();
--   drop trigger if exists guard_developer_role on public.profiles;
--   drop function if exists public.guard_developer_role();
--   drop trigger if exists guard_platform_lock_delete on public.platform_settings;
--   drop function if exists public.guard_platform_lock_delete();
--   drop trigger if exists guard_platform_lock on public.platform_settings;
--   drop function if exists public.guard_platform_lock();
--   drop function if exists public.set_platform_lock(uuid, text, text);
--   drop table if exists public.platform_lock_events;
--   alter table public.platform_settings drop column if exists dev_lock_level, drop column if exists dev_lock_message,
--     drop column if exists dev_lock_by, drop column if exists dev_lock_at,
--     drop column if exists dev_lock_prev_accepting, drop column if exists dev_lock_prev_message;

begin;

alter table public.platform_settings
  add column if not exists dev_lock_level text not null default 'off',
  add column if not exists dev_lock_message text not null default '',
  add column if not exists dev_lock_by uuid references public.profiles (id) on delete set null,
  add column if not exists dev_lock_at timestamptz,
  add column if not exists dev_lock_prev_accepting boolean,
  add column if not exists dev_lock_prev_message text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.platform_settings'::regclass and conname = 'platform_settings_dev_lock_level_check') then
    alter table public.platform_settings add constraint platform_settings_dev_lock_level_check
      check (dev_lock_level in ('off', 'orders', 'full'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.platform_settings'::regclass and conname = 'platform_settings_dev_lock_message_len') then
    alter table public.platform_settings add constraint platform_settings_dev_lock_message_len
      check (char_length(dev_lock_message) <= 500);
  end if;
end $$;

-- The apps may read whether operations are paused, and why.
grant select (dev_lock_level, dev_lock_message) on public.platform_settings to anon, authenticated;

-- Every change, for the Developer panel.
create table if not exists public.platform_lock_events (
  id         bigint generated always as identity primary key,
  level      text not null check (level in ('off', 'orders', 'full')),
  message    text not null default '',
  actor_id   uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.platform_lock_events enable row level security;
revoke all on public.platform_lock_events from anon, authenticated;
grant select, insert on public.platform_lock_events to service_role;

-- Only set_platform_lock may move the lock, and nobody may switch ordering back
-- on (or change the customer message) while it is set.
create or replace function public.guard_platform_lock()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if coalesce(current_setting('deligro.dev_lock', true), '') = 'on' then
    return new;
  end if;
  if (new.dev_lock_level, new.dev_lock_message, new.dev_lock_at, new.dev_lock_prev_accepting, new.dev_lock_prev_message)
     is distinct from
     (old.dev_lock_level, old.dev_lock_message, old.dev_lock_at, old.dev_lock_prev_accepting, old.dev_lock_prev_message)
     -- Clearing who set it is the profile's own "on delete set null"; nothing else may move it.
     or (new.dev_lock_by is distinct from old.dev_lock_by and new.dev_lock_by is not null) then
    raise exception 'platform_locked' using errcode = '42501';
  end if;
  if old.dev_lock_level <> 'off'
     and (new.accepting_orders, new.maintenance_message) is distinct from (old.accepting_orders, old.maintenance_message) then
    raise exception 'platform_locked' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_platform_lock on public.platform_settings;
create trigger guard_platform_lock
  before update on public.platform_settings
  for each row execute function public.guard_platform_lock();

-- The settings row is never deleted while locked: with no row every reader falls
-- back to "accepting orders" and the order guard below sees no lock.
create or replace function public.guard_platform_lock_delete()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if old.dev_lock_level <> 'off' then
    raise exception 'platform_locked' using errcode = '42501';
  end if;
  return old;
end;
$$;

drop trigger if exists guard_platform_lock_delete on public.platform_settings;
create trigger guard_platform_lock_delete
  before delete on public.platform_settings
  for each row execute function public.guard_platform_lock_delete();

-- No app login may write the settings row in or out of existence.
revoke insert, delete on public.platform_settings from anon, authenticated;

-- Only the service role (the developer's own scripts, scripts/create-developer.ts)
-- makes an account a developer or takes the role away. lock_role (0003) lets an
-- admin change any role; for this one it must not, or an admin could lift the
-- pause, or lock the developer out.
create or replace function public.guard_developer_role()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.role::text = 'developer')
     or (tg_op = 'UPDATE' and new.role is distinct from old.role and 'developer' in (new.role::text, old.role::text)) then
    raise exception 'developer_role' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_developer_role on public.profiles;
create trigger guard_developer_role
  before insert or update of role on public.profiles
  for each row execute function public.guard_developer_role();

-- Second line: whatever path an order takes, it does not land while paused.
create or replace function public.guard_orders_platform_lock()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.platform_settings s where s.id and s.dev_lock_level <> 'off') then
    raise exception 'platform_paused' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_orders_platform_lock() from public;

drop trigger if exists guard_orders_platform_lock on public.orders;
create trigger guard_orders_platform_lock
  before insert on public.orders
  for each row execute function public.guard_orders_platform_lock();

-- The developer's switch. Called by the server as service_role after
-- requireRole("developer"); checks the actor's role again here.
create or replace function public.set_platform_lock(p_actor uuid, p_level text, p_message text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  -- One line: the admin form resends it from a single-line field, and must match.
  msg constant text := left(btrim(regexp_replace(coalesce(p_message, ''), '\s+', ' ', 'g')), 500);
  cur public.platform_settings%rowtype;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin')
     or not exists (select 1 from public.profiles p where p.id = p_actor and p.role::text = 'developer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_level is null or p_level not in ('off', 'orders', 'full') then
    raise exception 'invalid_level' using errcode = '22023';
  end if;
  select * into cur from public.platform_settings where id for update;
  if not found then
    raise exception 'not_configured' using errcode = '55000';
  end if;

  perform set_config('deligro.dev_lock', 'on', true);
  if p_level = 'off' then
    update public.platform_settings
       set dev_lock_level = 'off', dev_lock_message = '', dev_lock_by = p_actor, dev_lock_at = now(),
           accepting_orders = case when cur.dev_lock_level <> 'off' then coalesce(cur.dev_lock_prev_accepting, true) else accepting_orders end,
           maintenance_message = case when cur.dev_lock_level <> 'off' then coalesce(cur.dev_lock_prev_message, '') else maintenance_message end,
           dev_lock_prev_accepting = null, dev_lock_prev_message = null
     where id;
  else
    update public.platform_settings
       set dev_lock_level = p_level, dev_lock_message = msg, dev_lock_by = p_actor, dev_lock_at = now(),
           -- Remember what the admin had only on the way in, not on a change of level.
           dev_lock_prev_accepting = case when cur.dev_lock_level = 'off' then cur.accepting_orders else dev_lock_prev_accepting end,
           dev_lock_prev_message = case when cur.dev_lock_level = 'off' then cur.maintenance_message else dev_lock_prev_message end,
           accepting_orders = false,
           maintenance_message = case when msg <> '' then msg
                                      else 'Ordering is paused for now. Please check back later.' end
     where id;
  end if;
  perform set_config('deligro.dev_lock', '', true);

  insert into public.platform_lock_events (level, message, actor_id) values (p_level, msg, p_actor);
  return jsonb_build_object('level', p_level, 'message', msg);
end;
$$;
revoke execute on function public.set_platform_lock(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_platform_lock(uuid, text, text) to service_role;

commit;
