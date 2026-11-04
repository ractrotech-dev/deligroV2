-- ============================================================
-- 0186 — An admin pays shops and riders alone, by default
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database from this branch.
-- Order: after 0185. Depends on 0141 (ops_audit_log) and 0152
-- (platform_settings.allow_single_admin_payments, its guard trigger).
--
-- Owner's decision (2026-11-04): the owner alone approves payments to shops and
-- riders, so a payment must not sit waiting for a second person. This does not
-- add a rule. It turns on the one 0152 already has:
--
--   * an ADMIN may approve their own payment request, with a reason;
--   * the request is marked self_approved and the audit row says who and why;
--   * a MANAGER still can never approve their own (_payment_maker_checker checks
--     the role, and this migration does not touch that function).
--
-- The switch stays where it was: Admin → Platform configuration can turn it off,
-- with a reason, through ops_set_single_admin_payments.
--
-- Security review (docs/SECURITY_AUDIT.md): this removes the second person from
-- admin payments, deliberately. One admin account can now pay money out, so that
-- account's sign-in is the control (accepted risk P-1 applies). No policy, grant
-- or function changes. The change is written to the audit log here: the owner did
-- not make it through the settings screen, and the log should still show it. It
-- has no signed-in person behind it, so its actor is the nil uuid, role `system`.
--
-- Rollback:
--   alter table public.platform_settings alter column allow_single_admin_payments set default false;
--   -- then turn it off from Admin → Platform configuration, which writes its own audit row.
--
-- Idempotent: safe to re-run.
-- ============================================================

begin;

alter table public.platform_settings
  alter column allow_single_admin_payments set default true;

comment on column public.platform_settings.allow_single_admin_payments is
  'When true (the default since 0186) an admin may approve their own payment request (reason required, marked self_approved). Never a manager. Changed only through ops_set_single_admin_payments.';

do $$
begin
  if exists (select 1 from public.platform_settings where allow_single_admin_payments is distinct from true) then
    perform set_config('deligro.ops_settings', 'on', true);
    update public.platform_settings set allow_single_admin_payments = true;
    perform set_config('deligro.ops_settings', '', true);
    insert into public.ops_audit_log (actor_id, actor_role, action, entity_type, entity_id, reason, before, after)
    values ('00000000-0000-0000-0000-000000000000', 'system', 'settings.single_admin_payments', 'platform_settings',
            'allow_single_admin_payments', 'Owner decision: the owner alone approves payments (migration 0186)',
            jsonb_build_object('enabled', false), jsonb_build_object('enabled', true));
  end if;
end;
$$;

commit;
