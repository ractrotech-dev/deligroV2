-- ============================================================
-- 0203 — Resetting an admin's password signs them out too
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database.
-- Deploy order: … → 0190 → … → 0203.
--
-- Admin → Team can now reset another admin's password. A reset is meant to lock out
-- whoever prompted it, which needs their sessions ended, and
-- ops_revoke_staff_sessions (0190) only accepted managers and riders.
--
--   * It now accepts an admin too, but never the caller's own account.
--
-- Stopping or removing an admin is still refused (0190, 0202). The developer's master
-- account is refused by the server before this is reached (lib/developers.ts).
--
-- Rollback: re-run ops_revoke_staff_sessions from 0190.
-- ============================================================

begin;

create or replace function public.ops_revoke_staff_sessions(p_actor uuid, p_user uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform public.ops_require_admin(p_actor);
  if not exists (select 1 from public.profiles p where p.id = p_user and p.role::text in ('manager', 'driver', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_user = p_actor then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from auth.sessions where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.ops_revoke_staff_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ops_revoke_staff_sessions(uuid, uuid) to service_role;

commit;
