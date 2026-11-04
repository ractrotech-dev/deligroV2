-- ============================================================
-- 0198 — Customer wallet (docs/RULE-BOOK.md, "Customer wallet")
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database.
-- Deploy order: … → 0191 → 0194 → 0195 → 0196 → 0198. Apply BEFORE the app code: the
-- app reads the new columns with a fallback (no 0198 = wallet off, nothing else moves).
--
-- A rider with no change adds the leftover to the customer's wallet as points, proved
-- by a code only the customer can see. 1 point = ₹1, whole rupees. Points pay for later
-- orders. They never expire and can't be taken out as cash. Only an admin corrects a
-- balance, with a written reason.
--
-- HOW THE MONEY STAYS RIGHT
--
--   * `_wallet_apply` is the only code that moves a balance. It locks the profile row,
--     refuses a negative result, writes the ledger row and the balance in one go. It is
--     not callable from outside, not even by the service role.
--   * Four server functions call it, each one transaction, service role only:
--       wallet_add_change, wallet_spend_on_order, wallet_admin_correct, and the trigger
--       that returns points when an order is cancelled.
--   * guard_wallet_balance refuses any other write to profiles.wallet_balance, whoever
--     is asking: customer, admin session or service role. Only a definer function here
--     (running as the table owner) gets past it.
--   * The ledger is append-only and nobody but those functions can insert into it.
--   * Retries can't apply twice: one change credit, one spend and one return per order
--     (unique index on order + kind); a correction is unique by client action id.
--   * The lock order is always order row, then profile row, so these can't deadlock.
--
-- WHOLE RUPEES ON numeric(10,2)
--   The columns stay numeric(10,2): changing a column on `profiles` to integer rewrites
--   the table and breaks nothing we'd gain. Every function takes an integer, and CHECKs
--   refuse a fraction on the balance and on every new ledger row. A `legacy` ledger row
--   may hold paise, because history is kept as it was.
--
-- EXISTING ROWS
--   Nothing in the app has ever written these (0006 made them, 0056 guarded them), so
--   every balance should be 0 and the ledger empty. Section 2 reconciles anyway, because
--   the 0056 guard let an admin session write the balance by hand: the ledger is brought
--   up to the balance with one `legacy` row; a fraction rounds UP (it's the customer's
--   money) and a negative balance, which the NOT VALID check allowed on old rows, becomes
--   0. It raises a NOTICE with the counts. To look before applying, run read-only:
--     select count(*) filter (where wallet_balance <> 0) as with_balance,
--            coalesce(sum(wallet_balance), 0) as held,
--            count(*) filter (where wallet_balance <> trunc(wallet_balance) or wallet_balance < 0) as odd
--       from public.profiles;
--     select count(*), coalesce(sum(amount), 0) from public.wallet_transactions;
--
-- ORDERS
--   orders.total stays the full bill, so pricing and shop payouts don't move.
--   New column orders.wallet_points_used. Cash due = total − wallet_points_used.
--   Fully covered: payment_method stays 'cod' (no gateway was involved) and
--   payment_status becomes 'paid', which is already "nothing to collect" for every
--   reader. A cancel puts it back to 'pending': no money moved, nothing is owed.
--
-- CANCELLING
--   A BEFORE UPDATE trigger on orders returns the points when an order becomes
--   cancelled, on every path (20-second customer cancel, shop reject, staff cancel,
--   createOrder's own clean-up), once, with a ledger row. This is not a refund: no
--   money moved. Points added as change are NOT taken back: the customer really handed
--   over that cash.
--
-- THE CODE
--   wallet_change_codes holds only a salted hash (AGENTS.md rule 4: show once, then
--   drop). Asking again makes a new code and kills the old one. Wrong tries are counted
--   per order, so asking again can't reset them: 5 wrong tries lock that order's change.
--   A wrong try returns an answer rather than raising, so the count survives: an
--   exception would roll it back and give unlimited guesses.
--
-- SECURITY REVIEW (docs/SECURITY_AUDIT.md)
--   * profiles: RLS lets a shop read customers who ordered from it, and RLS filters rows,
--     not columns (AGENTS.md rule 1), so a shop could read a customer's balance. SELECT
--     on profiles is now granted per column, everything except wallet_balance. A new
--     profiles column is invisible to anon/authenticated until a migration grants it.
--     Customers read their balance through /api/wallet.
--   * wallet_transactions: read own row only; all writes revoked, service role included.
--   * wallet_change_codes: RLS on, no policies, all privileges revoked.
--   * orders.wallet_points_used: granted for SELECT per 0058. A customer's insert is
--     forced to 0 and only a definer function can change it, or a customer could insert
--     an order that owes nothing.
--
-- Rollback (only safe while the ledger has no real rows):
--   drop trigger if exists zzz_orders_wallet_settle on public.orders;
--   drop trigger if exists orders_guard_wallet_points on public.orders;
--   drop trigger if exists profiles_guard_wallet_balance on public.profiles;
--   drop trigger if exists wallet_ledger_append_only on public.wallet_transactions;
--   drop function if exists public.wallet_issue_change_code(uuid, uuid);
--   drop function if exists public.wallet_add_change(uuid, uuid, integer, text, text);
--   drop function if exists public.wallet_spend_on_order(uuid, uuid, integer);
--   drop function if exists public.wallet_admin_correct(uuid, uuid, integer, text, text);
--   drop function if exists public.ops_wallet_summary();
--   drop function if exists public._wallet_apply(uuid, integer, text, text, uuid, uuid, text, text);
--   drop function if exists public._wallet_on();
--   drop function if exists public.orders_wallet_settle();
--   drop function if exists public.guard_order_wallet_points();
--   drop function if exists public.guard_wallet_balance();
--   drop function if exists public.wallet_ledger_append_only();
--   drop table if exists public.wallet_change_codes;
--   alter table public.orders drop column if exists wallet_points_used;
--   alter table public.platform_settings drop column if exists feature_wallet, drop column if exists wallet_change_max_per_order;
--   alter table public.profiles drop constraint if exists profiles_wallet_balance_whole;
--   grant select on public.profiles to anon, authenticated;
--   re-run guard_order_cod_ceiling from 0194.
--
-- Idempotent: safe to re-run.
-- ============================================================

begin;

-- 1. Settings -------------------------------------------------------------------
alter table public.platform_settings
  add column if not exists feature_wallet boolean not null default true,
  add column if not exists wallet_change_max_per_order integer not null default 100;

do $$ begin
  alter table public.platform_settings
    add constraint platform_settings_wallet_change_max_range
    check (wallet_change_max_per_order between 1 and 10000);
exception when duplicate_object then null;
end $$;

comment on column public.platform_settings.feature_wallet is
  'The customer wallet on or off for the whole platform. Off: no points can be added or used. Balances stay.';
comment on column public.platform_settings.wallet_change_max_per_order is
  'The most a rider can add to a customer''s wallet on one order, whole rupees.';

grant select (feature_wallet, wallet_change_max_per_order)
  on public.platform_settings to anon, authenticated;

-- 2. The ledger, and any rows already there ------------------------------------
alter table public.wallet_transactions
  add column if not exists kind text not null default 'legacy',
  add column if not exists actor_id uuid references public.profiles (id) on delete set null,
  add column if not exists actor_role text,
  add column if not exists balance_after numeric(10,2),
  add column if not exists client_action_id text;

do $$
declare
  fixed integer := 0;
  r record;
  target numeric(10,2);
begin
  for r in
    select p.id, p.wallet_balance, coalesce(l.total, 0) as ledger
      from public.profiles p
      left join (select user_id, sum(amount) as total from public.wallet_transactions group by 1) l
        on l.user_id = p.id
     where p.wallet_balance <> 0 or l.user_id is not null
  loop
    target := ceil(greatest(r.wallet_balance, 0));
    if target <> r.ledger then
      insert into public.wallet_transactions (user_id, amount, reason, kind, balance_after)
      values (r.id, target - r.ledger, 'Opening balance brought in by migration 0198', 'legacy', target);
    end if;
    if target <> r.wallet_balance or target <> r.ledger then
      fixed := fixed + 1;
    end if;
    if target <> r.wallet_balance then
      -- guard_wallet_balance does not exist yet on a first run, and this runs as the
      -- table owner on a re-run. 0056's guard lets the owner through.
      update public.profiles set wallet_balance = target where id = r.id;
    end if;
  end loop;
  raise notice '0198: % wallet balance(s) needed reconciling', fixed;
end $$;

-- Now every balance is whole, not negative, and equal to its ledger.
do $$ begin
  alter table public.profiles
    add constraint profiles_wallet_balance_whole check (wallet_balance = trunc(wallet_balance));
exception when duplicate_object then null;
end $$;
alter table public.profiles validate constraint profiles_wallet_balance_nonneg;

do $$ begin
  alter table public.wallet_transactions
    add constraint wallet_tx_kind_check check (kind in
      ('legacy', 'change_credit', 'order_spend', 'order_return', 'order_adjust', 'admin_correction'));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.wallet_transactions
    add constraint wallet_tx_whole_rupees check (kind = 'legacy' or amount = trunc(amount));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.wallet_transactions add constraint wallet_tx_nonzero check (amount <> 0);
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.wallet_transactions
    add constraint wallet_tx_reason_written check (char_length(btrim(reason)) > 0);
exception when duplicate_object then null;
end $$;

-- One of each per order, so a retry can't apply twice. order_adjust is left out: it
-- only happens when a bill falls below the points on it, and each one lowers the points.
create unique index if not exists wallet_tx_once_per_order
  on public.wallet_transactions (order_id, kind)
  where order_id is not null and kind in ('change_credit', 'order_spend', 'order_return');
create unique index if not exists wallet_tx_client_action
  on public.wallet_transactions (client_action_id)
  where client_action_id is not null;
create index if not exists wallet_tx_created_idx on public.wallet_transactions (created_at desc);
create index if not exists wallet_tx_kind_created_idx on public.wallet_transactions (kind, created_at desc);
create index if not exists wallet_tx_order_idx on public.wallet_transactions (order_id) where order_id is not null;
create index if not exists profiles_wallet_balance_idx on public.profiles (wallet_balance desc) where wallet_balance > 0;

comment on table public.wallet_transactions is
  'The customer wallet ledger. Append-only: written only by _wallet_apply (0198). For every profile, the sum of amount equals profiles.wallet_balance.';
comment on column public.wallet_transactions.kind is
  'change_credit: a rider added change. order_spend: points used on an order. order_return: an order paid with points was cancelled. order_adjust: a bill fell below the points on it. admin_correction: an admin corrected it. legacy: before 0198.';
comment on column public.wallet_transactions.actor_id is
  'Who did it. Null only for legacy rows and a system action with no person behind it.';
comment on column public.wallet_transactions.balance_after is
  'The customer''s balance straight after this row.';
comment on column public.profiles.wallet_balance is
  'Wallet points, whole rupees. Equal to the sum of this customer''s wallet_transactions. Moves only through _wallet_apply (0198). Not granted to anon/authenticated: read through /api/wallet.';

-- A customer's ledger survives everything: a profile with wallet history can't vanish.
alter table public.wallet_transactions drop constraint if exists wallet_transactions_user_id_fkey;
alter table public.wallet_transactions
  add constraint wallet_transactions_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete restrict;

-- Nobody writes the ledger directly. The owner (the definer functions below, and a
-- foreign key's own action) can.
revoke all on public.wallet_transactions from public, anon, authenticated, service_role;
grant select on public.wallet_transactions to authenticated, service_role;

create or replace function public.wallet_ledger_append_only()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if current_user in ('postgres', 'supabase_admin') and tg_op <> 'DELETE' then
    return coalesce(new, old);
  end if;
  raise exception 'wallet_transactions is append-only' using errcode = '42501';
end;
$$;
revoke all on function public.wallet_ledger_append_only() from public, anon, authenticated;

drop trigger if exists wallet_ledger_append_only on public.wallet_transactions;
create trigger wallet_ledger_append_only
  before insert or update or delete on public.wallet_transactions
  for each row execute function public.wallet_ledger_append_only();

-- 3. The balance: nobody but the functions below, and no one can read it sideways -----
create or replace function public.guard_wallet_balance()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.wallet_balance := 0;
  elsif new.wallet_balance is distinct from old.wallet_balance then
    raise exception 'profiles.wallet_balance can only be changed by the server' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_wallet_balance() from public, anon, authenticated;

drop trigger if exists profiles_guard_wallet_balance on public.profiles;
create trigger profiles_guard_wallet_balance
  before insert or update on public.profiles
  for each row execute function public.guard_wallet_balance();

-- Per-column SELECT, as restaurants (0022) and orders (0058) already do: a shop may read
-- a customer's name and phone for an order, not how much is in their wallet.
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles' and column_name <> 'wallet_balance';
  execute 'revoke select on public.profiles from anon, authenticated';
  execute format('grant select (%s) on public.profiles to anon, authenticated', cols);
end $$;

-- 4. The order column -----------------------------------------------------------
alter table public.orders
  add column if not exists wallet_points_used integer not null default 0;

do $$ begin
  alter table public.orders add constraint orders_wallet_points_nonneg check (wallet_points_used >= 0);
exception when duplicate_object then null;
end $$;

comment on column public.orders.wallet_points_used is
  'Wallet points used on this order. orders.total stays the full bill; cash due = total − this. After a cancel it stays as the record of what was used; the ledger shows the return.';

-- AGENTS.md rule 1: orders is granted per column since 0058.
grant select (wallet_points_used) on public.orders to authenticated;

-- 5. The one place a balance moves -----------------------------------------------
create or replace function public._wallet_on()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select s.feature_wallet from public.platform_settings s where s.id = true), false);
$$;
revoke all on function public._wallet_on() from public, anon, authenticated, service_role;

create or replace function public._wallet_apply(
  p_user uuid, p_amount integer, p_kind text, p_reason text,
  p_order uuid, p_actor uuid, p_actor_role text, p_client_action_id text
)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  balance numeric(10,2);
  after_it numeric(10,2);
begin
  select p.wallet_balance into balance from public.profiles p where p.id = p_user for update;
  if balance is null then
    raise exception 'wallet_not_found' using errcode = '22023';
  end if;
  after_it := balance + p_amount;
  if after_it < 0 then
    raise exception 'wallet_insufficient' using errcode = '22023';
  end if;
  insert into public.wallet_transactions
    (user_id, amount, reason, order_id, kind, actor_id, actor_role, balance_after, client_action_id)
  values
    (p_user, p_amount, p_reason, p_order, p_kind, p_actor, p_actor_role, after_it, p_client_action_id);
  update public.profiles set wallet_balance = after_it where id = p_user;
  return after_it;
end;
$$;
revoke all on function public._wallet_apply(uuid, integer, text, text, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

-- 6. Orders: the column is the server's, and the money follows the row -----------
create or replace function public.guard_order_wallet_points()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.wallet_points_used := 0;
  elsif new.wallet_points_used is distinct from old.wallet_points_used then
    raise exception 'orders.wallet_points_used can only be changed by the server' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_order_wallet_points() from public, anon, authenticated;

drop trigger if exists orders_guard_wallet_points on public.orders;
create trigger orders_guard_wallet_points
  before insert or update on public.orders
  for each row execute function public.guard_order_wallet_points();

-- Named to run last: guard_order_update looks at payment_status under the caller's
-- session, and this may change it on a shop's reject.
create or replace function public.orders_wallet_settle()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor uuid;
  excess integer;
begin
  actor := coalesce(auth.uid(), nullif(current_setting('deligro.actor_id', true), '')::uuid);

  -- Cancelled: the points go back, once.
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if new.wallet_points_used > 0
       and not exists (select 1 from public.wallet_transactions t
                        where t.order_id = new.id and t.kind = 'order_return') then
      perform public._wallet_apply(
        new.customer_id, new.wallet_points_used, 'order_return',
        'Order cancelled, points returned', new.id, actor, coalesce(new.cancelled_by, 'system'), null);
    end if;
    if new.payment_method = 'cod' and new.payment_status = 'paid' then
      new.payment_status := 'pending';
    end if;
    return new;
  end if;

  -- Brought back from cancelled: the points have gone home, so the whole bill is cash.
  if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    if exists (select 1 from public.wallet_transactions t
                where t.order_id = new.id and t.kind = 'order_return') then
      new.wallet_points_used := 0;
    end if;
    return new;
  end if;

  if new.status = 'cancelled' then
    return new;
  end if;

  -- The bill fell below the points on it (a coupon applied to a placed order): the
  -- difference goes back. Cash due can never be negative.
  if new.total < new.wallet_points_used then
    excess := new.wallet_points_used - new.total;
    perform public._wallet_apply(
      new.customer_id, excess, 'order_adjust',
      'The bill went down, extra points returned', new.id, actor, 'system', null);
    new.wallet_points_used := new.total;
  end if;

  -- The bill and the points decide whether anything is still owed. Only ever between
  -- pending and paid, only on a cash order, and only while points are involved.
  if new.payment_method = 'cod' and new.payment_status in ('pending', 'paid')
     and (new.wallet_points_used > 0 or old.wallet_points_used > 0) then
    new.payment_status := case
      when new.wallet_points_used > 0 and new.total - new.wallet_points_used <= 0 then 'paid'
      else 'pending'
    end::public.payment_status;
  end if;
  return new;
end;
$$;
revoke all on function public.orders_wallet_settle() from public, anon, authenticated;

drop trigger if exists zzz_orders_wallet_settle on public.orders;
create trigger zzz_orders_wallet_settle
  before update on public.orders
  for each row
  when (old.wallet_points_used > 0 or new.wallet_points_used > 0)
  execute function public.orders_wallet_settle();

-- 0194's guard, judging the cash actually due. Nothing due: no cash, so neither the
-- limit nor the cash switch applies.
create or replace function public.guard_order_cod_ceiling()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  shop_limit integer;
  platform_limit integer := 0;
  cash_on boolean := true;
  cash_limit integer;
  cash_due integer;
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin') then
    return new;
  end if;
  if new.status = 'cancelled' or coalesce(new.payment_method, 'cod') <> 'cod' then
    return new;
  end if;

  cash_due := greatest(0, new.total - coalesce(new.wallet_points_used, 0));
  if cash_due = 0 then
    return new;
  end if;

  select coalesce(r.cod_max_order, 0) into shop_limit
    from public.restaurants r where r.id = new.restaurant_id;

  select coalesce(s.cash_limit_per_order, 0), coalesce(s.feature_cash_payment, true)
    into platform_limit, cash_on
    from public.platform_settings s limit 1;

  if not coalesce(cash_on, true) then
    raise exception 'orders: cash on delivery is switched off';
  end if;

  -- The smaller of the two limits that are set. 0 on either side means "not set".
  cash_limit := case
    when coalesce(shop_limit, 0) > 0 and coalesce(platform_limit, 0) > 0 then least(shop_limit, platform_limit)
    else greatest(coalesce(shop_limit, 0), coalesce(platform_limit, 0))
  end;

  if cash_limit > 0 and cash_due > cash_limit then
    raise exception 'orders: over the cash limit for this order';
  end if;
  return new;
end;
$$;

-- 7. The code --------------------------------------------------------------------
create table if not exists public.wallet_change_codes (
  order_id      uuid primary key references public.orders (id) on delete cascade,
  customer_id   uuid not null references public.profiles (id) on delete cascade,
  code_hash     text,
  expires_at    timestamptz,
  wrong_tries   integer not null default 0,
  locked_at     timestamptz,
  used_at       timestamptz,
  issued_at     timestamptz not null default now()
);
comment on table public.wallet_change_codes is
  'The proof a rider adds change to a customer''s wallet: a salted hash of a short-lived code. Never the code itself. Service definer functions only.';

alter table public.wallet_change_codes enable row level security;
revoke all on public.wallet_change_codes from public, anon, authenticated, service_role;

-- A hash salted with the order: the same code on two orders looks different.
create or replace function public._wallet_code_hash(p_order uuid, p_code text)
returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(p_order::text || ':' || p_code, 'UTF8')), 'hex');
$$;
revoke all on function public._wallet_code_hash(uuid, text) from public, anon, authenticated, service_role;

-- The customer asks for a code during a cash delivery. Only for their own order, only
-- while it is out for delivery with cash due. The answer holds the code; it is stored
-- only as a hash. Asking again replaces it, and does not reset the wrong tries.
create or replace function public.wallet_issue_change_code(p_customer uuid, p_order uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o public.orders%rowtype;
  d public.deliveries%rowtype;
  c public.wallet_change_codes%rowtype;
  code text;
  expires timestamptz := now() + interval '10 minutes';
begin
  if not public._wallet_on() then
    return jsonb_build_object('ok', false, 'error', 'wallet_off');
  end if;
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.customer_id is distinct from p_customer then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into d from public.deliveries where order_id = p_order;
  if o.status <> 'on_the_way' or d.status is distinct from 'picked_up' then
    return jsonb_build_object('ok', false, 'error', 'not_out_for_delivery');
  end if;
  if coalesce(o.payment_method::text, 'cod') <> 'cod' or o.payment_status = 'paid'
     or o.total - o.wallet_points_used <= 0 then
    return jsonb_build_object('ok', false, 'error', 'no_cash_due');
  end if;
  if exists (select 1 from public.wallet_transactions t where t.order_id = p_order and t.kind = 'change_credit') then
    return jsonb_build_object('ok', false, 'error', 'already_added');
  end if;
  select * into c from public.wallet_change_codes where order_id = p_order for update;
  if c.locked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;

  -- Six digits from a random UUID's first 32 random bits.
  code := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');

  insert into public.wallet_change_codes (order_id, customer_id, code_hash, expires_at, issued_at)
  values (p_order, p_customer, public._wallet_code_hash(p_order, code), expires, now())
  on conflict (order_id) do update
    set code_hash = excluded.code_hash, expires_at = excluded.expires_at, issued_at = excluded.issued_at;

  return jsonb_build_object('ok', true, 'code', code, 'expires_at', expires);
end;
$$;

-- 8. Adding change -----------------------------------------------------------------
-- The rider types what they received and the customer's code. The server works out the
-- change. In one transaction: the credit, the ledger row, and the cash collected on the
-- delivery as the FULL amount received, which is what the rider hands over and what
-- 0154, 0157 and 0195 count. The rider then taps Delivered as usual: the normal cash
-- record is conditional on being empty, so it leaves this one alone.
--
-- Every refusal is an answer, not an exception: a wrong try must be counted and kept.
create or replace function public.wallet_add_change(
  p_rider uuid, p_order uuid, p_received integer, p_code text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o public.orders%rowtype;
  d public.deliveries%rowtype;
  c public.wallet_change_codes%rowtype;
  done public.wallet_transactions%rowtype;
  max_change integer;
  cash_due integer;
  change integer;
  balance numeric;
  typed text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
  c_max_tries constant integer := 5;
begin
  if not public._wallet_on() then
    return jsonb_build_object('ok', false, 'error', 'wallet_off');
  end if;

  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_yours');
  end if;
  select * into d from public.deliveries where order_id = p_order for update;
  if d.id is null or d.driver_id is distinct from p_rider then
    return jsonb_build_object('ok', false, 'error', 'not_yours');
  end if;

  -- A retry of a credit that already went through: the same answer, nothing applied.
  select * into done from public.wallet_transactions t where t.order_id = p_order and t.kind = 'change_credit';
  if done.id is not null then
    return jsonb_build_object('ok', true, 'replayed', true, 'change', done.amount::integer,
                              'received', d.cod_collected_amount, 'customer_id', o.customer_id);
  end if;

  if d.status <> 'picked_up' or o.status <> 'on_the_way' then
    return jsonb_build_object('ok', false, 'error', 'not_active');
  end if;
  if coalesce(o.payment_method::text, 'cod') <> 'cod' or o.payment_status = 'paid' then
    return jsonb_build_object('ok', false, 'error', 'no_cash_due');
  end if;
  cash_due := o.total - o.wallet_points_used;
  if cash_due <= 0 then
    return jsonb_build_object('ok', false, 'error', 'no_cash_due');
  end if;
  if d.cod_collected_at is not null then
    return jsonb_build_object('ok', false, 'error', 'cash_already_recorded');
  end if;

  -- The amount first: a typing slip on the amount must not cost a try at the code.
  if p_received is null or p_received <= cash_due then
    return jsonb_build_object('ok', false, 'error', 'no_change', 'cash_due', cash_due);
  end if;
  change := p_received - cash_due;
  select s.wallet_change_max_per_order into max_change from public.platform_settings s where s.id = true;
  if max_change is null or change > max_change then
    return jsonb_build_object('ok', false, 'error', 'over_limit', 'limit', coalesce(max_change, 0), 'change', change);
  end if;

  select * into c from public.wallet_change_codes where order_id = p_order for update;
  if c.order_id is null or c.code_hash is null then
    return jsonb_build_object('ok', false, 'error', 'no_code');
  end if;
  if c.locked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;
  if c.expires_at is null or c.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'code_expired');
  end if;
  if c.code_hash is distinct from public._wallet_code_hash(p_order, typed) then
    update public.wallet_change_codes
       set wrong_tries = wrong_tries + 1,
           locked_at = case when wrong_tries + 1 >= c_max_tries then now() else null end
     where order_id = p_order;
    if c.wrong_tries + 1 >= c_max_tries then
      return jsonb_build_object('ok', false, 'error', 'locked');
    end if;
    return jsonb_build_object('ok', false, 'error', 'wrong_code', 'tries_left', c_max_tries - c.wrong_tries - 1);
  end if;

  balance := public._wallet_apply(
    o.customer_id, change, 'change_credit',
    format('Change from cash: received ₹%s on ₹%s due', p_received, cash_due),
    p_order, p_rider, 'driver', p_client_action_id);

  -- The rider holds all of it. Deligro holds the change for the customer.
  update public.deliveries
     set cod_collected_amount = p_received, cod_collected_at = now()
   where id = d.id;
  update public.wallet_change_codes
     set used_at = now(), code_hash = null, expires_at = null
   where order_id = p_order;

  return jsonb_build_object('ok', true, 'replayed', false, 'change', change, 'received', p_received,
                            'balance', balance, 'customer_id', o.customer_id);
end;
$$;

-- 9. Spending ----------------------------------------------------------------------
-- Called by createOrder once the order's bill is final, as the customer's own request
-- (the route has checked the session). Locks the order, then the balance. One spend per
-- order: a retry answers with the first one. Refusals are answers.
create or replace function public.wallet_spend_on_order(p_customer uuid, p_order uuid, p_points integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o public.orders%rowtype;
  done public.wallet_transactions%rowtype;
  balance numeric(10,2);
  after_it numeric;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.customer_id is distinct from p_customer then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select * into done from public.wallet_transactions t where t.order_id = p_order and t.kind = 'order_spend';
  if done.id is not null then
    return jsonb_build_object('ok', true, 'replayed', true, 'points', -done.amount::integer,
                              'cash_due', greatest(0, o.total - o.wallet_points_used));
  end if;

  if not public._wallet_on() then
    return jsonb_build_object('ok', false, 'error', 'wallet_off');
  end if;
  if p_points is null or p_points <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_points');
  end if;
  if o.status not in ('placed', 'kitchen') then
    return jsonb_build_object('ok', false, 'error', 'order_not_open');
  end if;
  -- Online orders aren't paid with points yet: the gateway charges the whole total.
  if coalesce(o.payment_method::text, 'cod') <> 'cod' then
    return jsonb_build_object('ok', false, 'error', 'cash_orders_only');
  end if;
  if p_points > o.total then
    return jsonb_build_object('ok', false, 'error', 'over_bill', 'total', o.total);
  end if;

  select p.wallet_balance into balance from public.profiles p where p.id = p_customer for update;
  if balance is null or balance < p_points then
    return jsonb_build_object('ok', false, 'error', 'insufficient', 'balance', coalesce(balance, 0));
  end if;

  after_it := public._wallet_apply(
    p_customer, -p_points, 'order_spend', 'Used on an order', p_order, p_customer, 'customer', null);

  -- orders_wallet_settle sets payment_status from this.
  update public.orders set wallet_points_used = p_points where id = p_order;

  return jsonb_build_object('ok', true, 'replayed', false, 'points', p_points,
                            'cash_due', o.total - p_points, 'balance', after_it);
end;
$$;

-- 10. Correcting -------------------------------------------------------------------
-- An admin only, with a written reason, audited. Can't take a balance below zero.
create or replace function public.wallet_admin_correct(
  p_actor uuid, p_customer uuid, p_delta integer, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  why constant text := nullif(btrim(coalesce(p_reason, '')), '');
  done public.wallet_transactions%rowtype;
  balance numeric(10,2);
  after_it numeric;
begin
  perform public.ops_require_admin(p_actor);

  if p_client_action_id is not null then
    select * into done from public.wallet_transactions t where t.client_action_id = p_client_action_id;
    if done.id is not null then
      if done.actor_id is distinct from p_actor or done.user_id is distinct from p_customer then
        raise exception 'client_action_id_conflict' using errcode = '23505';
      end if;
      return jsonb_build_object('ok', true, 'replayed', true, 'balance', done.balance_after);
    end if;
  end if;

  if why is null or char_length(why) < 5 or char_length(why) > 500 then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  if p_delta is null or p_delta = 0 or abs(p_delta) > 100000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  select p.wallet_balance into balance from public.profiles p where p.id = p_customer for update;
  if balance is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if balance + p_delta < 0 then
    return jsonb_build_object('ok', false, 'error', 'would_go_negative', 'balance', balance);
  end if;

  after_it := public._wallet_apply(
    p_customer, p_delta, 'admin_correction', why, null, p_actor, 'admin', p_client_action_id);

  perform public._ops_log(p_actor, 'wallet.correct', 'customer', p_customer::text, null, why,
                          jsonb_build_object('balance', balance),
                          jsonb_build_object('balance', after_it, 'delta', p_delta),
                          null);
  return jsonb_build_object('ok', true, 'replayed', false, 'balance', after_it);
end;
$$;

-- 11. The figures on the admin page and the Cash and expenses page ------------------
create or replace function public.ops_wallet_summary()
returns jsonb
language sql stable security definer set search_path = public as $$
  with month as (
    select (date_trunc('month', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata' as starts
  ), held as (
    select coalesce(sum(p.wallet_balance), 0)::bigint as total, count(*) as customers
      from public.profiles p where p.wallet_balance > 0
  ), moved as (
    select coalesce(sum(t.amount) filter (where t.kind = 'change_credit'), 0)::bigint as added,
           -- Used, less whatever came back on a cancelled order or a lowered bill.
           coalesce(-sum(t.amount) filter (where t.kind in ('order_spend', 'order_return', 'order_adjust')), 0)::bigint as used
      from public.wallet_transactions t, month m
     where t.created_at >= m.starts
  )
  select jsonb_build_object(
    'held', h.total, 'customers', h.customers,
    'added_this_month', m.added, 'used_this_month', m.used)
    from held h, moved m;
$$;

-- 12. Who can call what. Supabase's default privileges grant EXECUTE to everyone. ---
revoke all on function public.wallet_issue_change_code(uuid, uuid) from public, anon, authenticated;
revoke all on function public.wallet_add_change(uuid, uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.wallet_spend_on_order(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.wallet_admin_correct(uuid, uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.ops_wallet_summary() from public, anon, authenticated;
grant execute on function public.wallet_issue_change_code(uuid, uuid) to service_role;
grant execute on function public.wallet_add_change(uuid, uuid, integer, text, text) to service_role;
grant execute on function public.wallet_spend_on_order(uuid, uuid, integer) to service_role;
grant execute on function public.wallet_admin_correct(uuid, uuid, integer, text, text) to service_role;
grant execute on function public.ops_wallet_summary() to service_role;

commit;
