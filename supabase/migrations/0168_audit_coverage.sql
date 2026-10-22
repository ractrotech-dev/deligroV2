-- ============================================================
-- 0168 — Audit log: the index the audit screen's action filter needs
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database.
-- Deploy order: … → 0141 → … → 0167 → 0168.
--
-- The audit-coverage check (scripts/qa/manager-audit-coverage.ts) found every
-- logged manager action already written by its RPC in the same transaction,
-- so no RPC changes here. 0141 indexed the log by actor, zone and entity; the
-- audit screen also filters by action (exact or "order.*"), newest first.
-- scripts/qa/sql/migration-0168.mjs spot-checks five representative RPCs: one
-- call, one audit row with actor, zone, time and reason; a refused call, none.
--
-- Rollback:
--   drop index if exists public.ops_audit_log_action_idx;
-- ============================================================

begin;

create index if not exists ops_audit_log_action_idx on public.ops_audit_log (action text_pattern_ops, created_at desc);

commit;
