# Cash orders now pay the shop (migration 0185)

## The rule

The rider picks up from the shop without paying it. The customer pays Deligro,
in cash to the rider or online. Deligro's owner then pays the shop on its weekly
or monthly settlement. Confirmed by the owner on 2026-11-04.

For every delivered order:

    Shop gets = customer paid − delivery, tax and tip − Deligro's cut − refunds

## What was wrong

The code treated a cash order as "the shop kept the cash, so it owes Deligro its
commission". A ₹764 cash order showed "− ₹70, platform collects" when the shop
was actually owed about ₹617. A shop with only cash orders appeared to owe
money, and its payment could not be marked paid.

## What changed

- `breakdownOrder` in `src/lib/settlements/math.ts` and `ops_order_breakdown` in
  migration 0185 now give a cash order the same payout as an online one.
- The admin Settlements screens lead with the one amount to send.
- An admin finishes a payment alone, with a reason on the record (0186 turns on
  the one-admin rule from 0152). A manager still needs someone else to approve.
- Partner app and vendor website wording no longer says the shop keeps the cash.

## Payments made before this change

Stored statements are never rewritten, so old figures stay as they were.

**Unfinished payments.** Approving one that holds cash orders at the old amount
rebuilds it at the correct amount and asks the approver to confirm. No action is
needed.

**Paid payments.** These may have paid a shop too little. The statement page now
shows how much. To list all of them in the Supabase SQL editor (read only):

```sql
select r.name as shop,
       s.id as settlement,
       s.paid_at,
       sum(l.vendor_net - coalesce(l.refund_recovered, 0) - l.contribution) as shop_was_short
  from public.vendor_settlement_orders l
  join public.vendor_settlements s on s.id = l.settlement_id
  join public.restaurants r on r.id = s.restaurant_id
 where s.status = 'paid'
   and l.payment_method = 'cod'
   and l.vendor_net - coalesce(l.refund_recovered, 0) - l.contribution > 0
 group by r.name, s.id, s.paid_at
 order by s.paid_at;
```

How to make those shops whole is the owner's decision. Nothing in the app does it
automatically.

## Still true

A shop can still show as owing Deligro when refunds come to more than its unpaid
orders, or on a delivered online order whose payment never arrived. An unknown
payment method is also not assumed to have reached Deligro.

"Pay" covers everything unpaid up to today, not just the last complete week or
month. "Pay only some dates instead" keeps the old date-range choice.
