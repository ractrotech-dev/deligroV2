-- ============================================================
-- 0184 — Feature switches for admin-console screens.
-- Requires 0052 (role_feature_flags) and 0141 (ops_set_feature_switch).
--
-- Admin → Settings → Feature access gains an "Admin console" group: whole
-- console screens (the first is `admin.refunds`) that can be switched off for
-- every admin at once. Off hides the screen's nav entry, the route renders a
-- notice and its Server Actions refuse (src/lib/features/guards.server.ts,
-- adminFeatureOn). They are role-wide only: the app refuses a per-person
-- admin switch before it reaches the database.
--
-- Only the role check changes. The table stays service_role-only (0052), and
-- ops_set_feature_switch already re-checks that the actor is an admin or a
-- developer and writes the audit entry. As before, these are product switches,
-- not the security boundary: requireRole("admin") and RLS are unchanged.
--
-- Rollback:
--   delete from public.role_feature_flags where role = 'admin';
--   alter table public.role_feature_flags drop constraint if exists role_feature_flags_role_check;
--   alter table public.role_feature_flags add constraint role_feature_flags_role_check
--     check (role in ('vendor', 'manager', 'driver'));
--
-- Idempotent: safe to re-run.
-- ============================================================

begin;

alter table public.role_feature_flags drop constraint if exists role_feature_flags_role_check;
alter table public.role_feature_flags
  add constraint role_feature_flags_role_check
  check (role in ('vendor', 'manager', 'driver', 'admin'));

comment on table public.role_feature_flags is
  'Admin switches for vendor/manager/driver features (role-wide or per shop/person) and admin-console screens (role-wide). service_role only — see migrations 0052, 0184.';

commit;
