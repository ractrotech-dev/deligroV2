-- ============================================================
-- Deligro — a shop cannot go live without a map pin
--
-- `restaurants.lat`/`lng` have been nullable since 0009, on the reasoning that
-- a vendor pins the shop when they get round to it and `distance_km` covers the
-- gap. What that actually produced: 68 of 70 shops with no pin at all, 49 of
-- them live and taking orders.
--
-- An unpinned shop breaks three things quietly and separately:
--
--   * the delivery radius cannot be evaluated, so `checkServiceArea` could not
--     answer and `createOrder` treated "could not answer" as a pass. A 70 km
--     order was accepted at the flat delivery fee and a rider dispatched.
--   * the delivery estimate has no distance to model, so it falls back to the
--     kitchen's advertised band — that same 70 km trip displayed as "25 min".
--   * the customer's tracking map has no origin, so it drew a route line out of
--     a coordinate hashed from the restaurant's UUID.
--
-- Each of those now degrades honestly in the application. This migration is the
-- other half: it stops the set of unpinned-but-live shops growing.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT
-- ----------------------------------------
-- A `check (status <> 'active' or lat is not null)` is the obvious shape and it
-- is the wrong one. Postgres validates a CHECK against every row on the way in,
-- so adding it would fail outright against the 49 rows that are already
-- active-and-unpinned — and `not valid` merely defers that to the first update
-- of each row, which means an operator could not so much as close one of those
-- shops for the evening without first finding its coordinates.
--
-- The rule we actually want binds the TRANSITION, not the state: you may not
-- MAKE a shop live without a pin. A shop already live stays editable, and is
-- already barred from taking orders by the service-area gate until someone pins
-- it. `is distinct from` is what expresses that, and it also covers the INSERT
-- case where OLD is null.
--
-- Deliberately NOT backfilled. There is no address text on those 68 rows to
-- geocode from (`address`, `landmark` and `pincode` are all null), and a guessed
-- coordinate is worse than an absent one: it produces a confident radius
-- decision and a confident ETA that are both wrong, with nothing flagging it.
-- Pinning them is manual work, and this makes the backlog finite.
-- ============================================================

create or replace function public.require_vendor_pin_before_active()
returns trigger
language plpgsql
as $$
begin
  -- Only the moment of going live. `is distinct from` rather than `<>` so an
  -- INSERT (OLD is null) is covered by the same expression.
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active')
     and (new.lat is null or new.lng is null)
  then
    raise exception
      'Vendor % has no map pin; set restaurants.lat and restaurants.lng before making it active', new.name
      using errcode = 'check_violation',
            hint = 'Pin the shop on the map in the admin vendor editor, or set lat/lng directly.';
  end if;

  -- `approved` is the other door: the 0017 trigger keeps it in step with
  -- `status`, so a write that sets approved without touching status must not
  -- slip past. Same transition-only reasoning.
  if new.approved
     and (tg_op = 'INSERT' or old.approved is distinct from true)
     and (new.lat is null or new.lng is null)
  then
    raise exception
      'Vendor % has no map pin; set restaurants.lat and restaurants.lng before approving it', new.name
      using errcode = 'check_violation',
            hint = 'Pin the shop on the map in the admin vendor editor, or set lat/lng directly.';
  end if;

  return new;
end $$;

comment on function public.require_vendor_pin_before_active() is
  'Refuses the transition into active/approved for a restaurant with no lat/lng. Binds the transition, not the state, so the rows that were already live without a pin stay editable. See migration 0050.';

drop trigger if exists require_vendor_pin on public.restaurants;

-- BEFORE, so the write is rejected rather than rolled back after the fact, and
-- so this runs alongside 0017's status/approved coherence trigger rather than
-- fighting it.
create trigger require_vendor_pin
  before insert or update on public.restaurants
  for each row
  execute function public.require_vendor_pin_before_active();

-- ------------------------------------------------------------
-- No grant changes and no column added, so the anon column allowlist that 0032
-- / 0034 / 0044 / 0045 each re-ran does NOT need re-running here: this migration
-- adds no column for it to omit. (AGENTS.md rule 1 — stated because the absence
-- of the block is the kind of thing a later reviewer should not have to re-derive.)
-- ------------------------------------------------------------
