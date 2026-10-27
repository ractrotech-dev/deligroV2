-- 0179 — Guests can read the catalog again.
--
-- 0145 added "restaurants — manager read" (using manager_can_see_zone) for every
-- role, but 0141 had revoked that function from anon. Postgres checks EXECUTE
-- when a policy is evaluated, so every guest read of `restaurants` (and of
-- `menu_items`, whose policy joins restaurants) failed with "permission denied
-- for function manager_can_see_zone": the customer app's "Browse as guest"
-- showed "Couldn't load this". Found on the live database, 2026-10-27.
--
-- The functions answer false for a guest (no auth.uid(), not an admin), so
-- letting anon call them widens nothing; it only lets the policies be checked.
-- Order-independent; apply as soon as possible.
--
-- Rollback:
--   revoke execute on function public.manager_can_see_zone(uuid), public.manager_can_see_order(uuid) from anon;

grant execute on function public.manager_can_see_zone(uuid), public.manager_can_see_order(uuid) to anon;
