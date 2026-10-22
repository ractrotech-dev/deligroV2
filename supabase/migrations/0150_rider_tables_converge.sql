-- 0150 — Superseded by the Rider branch's 0084–0086 (kept so the numbering holds).
--
-- STATUS: PENDING APPROVAL. Not applied anywhere.
--
-- History: while the Rider branch (feat/rider-app) had not yet landed its
-- 0084 (rider ratings), 0085 (rider cash deposits, disputes, reminders) and
-- 0086 (rider profile fields, documents, payout accounts, change requests),
-- this migration built those tables here in the Rider plans' shapes so the
-- manager rider screens had something to read. Those migrations have now
-- landed and are the one definition of every object this file used to build
-- (AGENTS.md: one source of truth). Every column the later manager migrations
-- (0151–0154) read is present in them (checked when the branches merged).
--
-- What remains is a guard: the manager rider migrations need those tables, so
-- applying this file before 0084–0086 stops here with a plain message instead
-- of failing somewhere in 0151 with a missing relation.
--
-- Deploy order: 0061 → 0063 → 0081 → 0082 → 0083 → 0084 → 0085 → 0086 → 0087
-- → 0141 → 0142+ (docs/DATABASE.md).
--
-- Rollback: nothing to undo.

do $$
begin
  if to_regclass('public.rider_ratings') is null
     or to_regclass('public.cash_deposits') is null
     or to_regclass('public.rider_documents') is null
     or to_regclass('public.rider_profile_change_requests') is null then
    raise exception 'apply the Rider migrations 0084, 0085 and 0086 before 0150 (see docs/DATABASE.md, deploy order)';
  end if;
end
$$;
