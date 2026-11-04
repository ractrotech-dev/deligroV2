-- ============================================================
-- 0185 — A cash order pays the shop, the same as an online one
-- ------------------------------------------------------------
-- Owner's rule (2026-11-04): the rider picks up without paying the shop, the
-- customer pays Deligro (cash to the rider, or online), and Deligro's owner pays
-- the shop on its weekly or monthly settlement.
--
-- This function followed the older assumption that a shop keeps the cash, so a
-- cash order came out as "the shop owes Deligro its commission". That contradicts
-- 0047, which records the same cash moving Customer -> Rider -> Manager -> Owner.
-- `breakdownOrder` (src/lib/settlements/math.ts) changes with it, and the parity
-- tests hold the two together.
--
-- Only the `contribution` case changes: p_method = 'cod' now takes the first branch.
--
-- History is deliberately left alone. A settlement stores its own lines, so this
-- does not rewrite any statement. An unfinished payment is rebuilt when someone
-- approves it. See docs/settlement-cash-rule-change.md for the paid statements to
-- review.
--
-- Idempotent: safe to re-run.
-- ============================================================

begin;

create or replace function public.ops_order_breakdown(
  p_total numeric,
  p_fee numeric,
  p_tax numeric,
  p_tip numeric,
  p_discount numeric,
  p_funded_by text,
  p_commission_pct double precision,
  p_gst_pct double precision,
  p_other_charges numeric,
  p_method text,
  p_payment text,
  p_refunds numeric
)
returns table (
  commission bigint,
  commission_gst bigint,
  other_charges bigint,
  deductions bigint,
  contribution bigint
)
language sql immutable parallel safe as $$
  select least(d.c, d.d),
         least(d.g, greatest(0, d.d - d.c)),
         greatest(0, d.d - d.c - d.g),
         d.d,
         case when p_method = 'cod' or (p_method = 'online' and p_payment in ('paid', 'refunded'))
              then (d.food - d.d) - d.refunded
              else d.pd - d.d - d.refunded end
    from (
      select s.pd, s.food, s.c, s.g, s.refunded, least(s.food, s.c + s.g + s.o) as d
        from (
          select f.pd, f.food, f.c, f.o, f.refunded,
                 public.ops_js_round(f.c::double precision * (f.gst / 100)) as g
            from (
              select b.pd, b.food, b.gst, b.o, b.refunded,
                     public.ops_js_round(b.food::double precision * (b.pct / 100)) as c
                from (
                  select p.pd,
                         greatest(0,
                           public.ops_js_round(p_total::double precision)
                           - public.ops_js_round(p_fee::double precision)
                           - public.ops_js_round(p_tax::double precision)
                           - public.ops_js_round(p_tip::double precision)
                           + p.pd) as food,
                         least(100, greatest(0, coalesce(p_commission_pct, 0))) as pct,
                         least(100, greatest(0, coalesce(p_gst_pct, 0))) as gst,
                         greatest(0, public.ops_js_round(p_other_charges::double precision)) as o,
                         greatest(0, public.ops_js_round(p_refunds::double precision)) as refunded
                    from (
                      select case when p_funded_by = 'platform'
                                  then greatest(0, public.ops_js_round(p_discount::double precision))
                                  else 0 end as pd
                    ) p
                ) b
            ) f
        ) s
    ) d;
$$;

commit;
