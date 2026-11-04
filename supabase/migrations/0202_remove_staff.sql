-- ============================================================
-- 0202 — Admin can remove a manager or rider from the team
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database.
-- Deploy order: … → 0151 → 0190 → … → 0202. Needs 0190 (ending their sessions).
--
-- "Remove" retires the account. It does not delete the row, because deleting it
-- would damage the books: rider cash ledgers cascade away with the profile, and
-- orders.driver_id and the other "who did this" columns go blank.
--
--   * profiles.removed_at: when they were removed. Null for everyone else.
--     Deliberately NOT granted to anon or authenticated (0198's per-column rule):
--     only the service role reads it, to leave them off the lists.
--   * A removed account stays account_status = 'suspended'. There is deliberately no
--     'removed' status: gates such as the offer check in 0142 list the statuses they
--     refuse, so a new value would pass them. Suspended is already refused everywhere.
--   * ops_admin_remove_staff: does it and writes its audit row in one transaction.
--     Admin only, service role only. Refuses yourself and anyone but a manager or
--     rider, and a rider who is carrying an order. Their zones are dropped, and kept
--     in the audit row. The server checks for cash held and bans the login.
--   * guard_removed_staff: nobody can set removed_at from a session, and nothing can
--     reactivate a removed account. The manager app's rider "reactivate" would
--     otherwise accept one, because it sees an ordinary suspended rider.
--
-- Rollback (brings nobody back; to restore a person, clear removed_at, set
-- account_status = 'active' and lift the Auth ban):
--   drop trigger if exists guard_removed_staff on public.profiles;
--   drop function if exists public.guard_removed_staff();
--   drop function if exists public.ops_admin_remove_staff(uuid, uuid, text, text);
--   alter table public.profiles drop column if exists removed_at;
-- ============================================================

begin;

alter table public.profiles add column if not exists removed_at timestamptz;

comment on column public.profiles.removed_at is
  'Set when an admin removed this manager or rider from the team (0202). They stay suspended; the row stays for history. Service role only.';

create or replace function public.guard_removed_staff()
returns trigger
language plpgsql set search_path = public as $$
begin
  -- Runs as the caller: a session is anon or authenticated, while the service role
  -- and the SECURITY DEFINER RPC below are neither.
  if new.removed_at is distinct from old.removed_at and current_user in ('anon', 'authenticated') then
    raise exception 'removed_at can only be changed by an admin' using errcode = '42501';
  end if;
  if new.removed_at is not null and new.account_status is distinct from 'suspended' then
    raise exception 'staff_removed' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_removed_staff() from public, anon, authenticated;

drop trigger if exists guard_removed_staff on public.profiles;
create trigger guard_removed_staff
  before update of account_status, removed_at on public.profiles
  for each row execute function public.guard_removed_staff();

create or replace function public.ops_admin_remove_staff(
  p_actor uuid, p_user uuid, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  role_name text;
  cur       text;
  gone      timestamptz;
  zones     jsonb;
  codes     text;
  v_reason constant text := trim(coalesce(p_reason, ''));
begin
  perform public.ops_require_admin(p_actor);
  if p_user = p_actor then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['staff.remove'], p_user::text);
    return jsonb_build_object('replayed', true);
  end if;
  select p.role::text, p.account_status, p.removed_at into role_name, cur, gone
    from public.profiles p where p.id = p_user for update;
  if role_name is null or role_name not in ('manager', 'driver') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if gone is not null then
    raise exception 'already' using errcode = '22023';
  end if;
  if role_name = 'driver' then
    perform public._ops_lock_rider_work(p_user);
    codes := public._ops_rider_active_codes(p_user);
    if codes is not null then
      raise exception 'active_delivery' using errcode = '22023', detail = codes;
    end if;
  end if;

  select coalesce(jsonb_agg(sz.zone_id), '[]'::jsonb) into zones from public.staff_zones sz where sz.user_id = p_user;
  perform public._ops_set_actor(p_actor, v_reason);
  update public.profiles
     set account_status = 'suspended', removed_at = now(), status_reason = v_reason,
         status_changed_by = p_actor, status_changed_at = now()
   where id = p_user;
  if role_name = 'driver' then
    perform public._ops_rider_offline(p_user);
  end if;
  delete from public.staff_zones where user_id = p_user;

  perform public._ops_log(
    p_actor, 'staff.remove', case role_name when 'driver' then 'rider' else 'staff' end, p_user::text, null, v_reason,
    jsonb_build_object('account', cur, 'zones', zones), jsonb_build_object('account', 'suspended', 'removed', true),
    p_client_action_id);
  return jsonb_build_object('replayed', false);
end;
$$;
revoke execute on function public.ops_admin_remove_staff(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.ops_admin_remove_staff(uuid, uuid, text, text) to service_role;

commit;
