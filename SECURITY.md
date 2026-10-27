# Deligro — security & setup

This app enforces authorization the way the project checklist demands: **on the
server, every time**, and — most importantly — **at the database** via Supabase
Row Level Security (RLS). RLS is the real boundary. Even if an API route forgets
a check, Postgres refuses to return rows that aren't yours, which closes the
IDOR / broken-access-control class (OWASP API #1).

## The three checks (authenticated → role → ownership)

Every request that touches a record passes:

1. **Authenticated** — verified in `src/proxy.ts` (session refresh + coarse gate)
   and re-checked in route handlers via `supabase.auth.getUser()`.
2. **Authorized role** — enforced server-side in each portal layout with
   `requireRole()` (`src/lib/auth.ts`) **and** in RLS policies. The client's
   claimed role is never trusted.
3. **Resource ownership** — enforced by RLS policies in
   `supabase/migrations/0001_init.sql`. A row you may not see doesn't come back,
   so the app returns **404** (identical to "doesn't exist") — existence never
   leaks.

Reference endpoint: [`src/app/api/orders/[id]/route.ts`](src/app/api/orders/[id]/route.ts).
Reference data layer: [`src/lib/data-access/orders.ts`](src/lib/data-access/orders.ts).

## Role matrix → RLS policies

| Can access… | Customer | Restaurant | Driver | Admin | Enforced by |
|---|---|---|---|---|---|
| Own orders | ✅ | – | – | ✅ | `orders — read` |
| Place an order as themselves | ✅ | ❌ | ❌ | ✅ | `orders — customer insert` |
| Others' orders | ❌ | ❌ | assigned & active only | ✅ | `is_active_driver_for()` |
| Own menu/listing | – | ✅ | – | ✅ | `owns_restaurant()` |
| Others' menus (write) | – | ❌ | – | ✅ | `menu — owner manage` |
| Issue refunds | request only | ❌ | ❌ | ✅ | `refunds — *` |
| User management / role change | ❌ | ❌ | ❌ | ✅ | `lock_role()` trigger |

Driver access auto-revokes when the delivery status leaves `assigned`/`picked_up`
(delivered or reassigned) — the "assigned only, while active" rule, in SQL.

Admin appears on the "place an order" row as of migration **0040**, and the row
is worded "as themselves" on purpose: the policy still requires
`customer_id = auth.uid()`, so an admin shops as one more customer and cannot
post an order in anyone else's name. Before 0040 the owner's own account — which
is an admin, because that is the account that runs the console — was refused at
checkout by RLS and told to "sign in with your customer account", which does not
exist. Writing an order *for* another person remains the phone-order path below:
service role, re-checked role, stamped attribution.

### Manager — an operations role, not a small admin

`manager` (migrations **0022**/**0023**) reads every order, advances its status,
and manages `deliveries` to dispatch riders. It has no write on
`platform_settings`, no refund decision, and no vendor management. It is not
`is_admin()`, so `guard_order_update()` holds it to `status` — and, since
migration **0051**, to `cancellation_reason` on the one update that actually
cancels an order (see below) — exactly as it holds a vendor or a driver.

**Phone orders are the one exception, and it is a code path rather than a
privilege.** A manager has no INSERT policy on `orders` — deliberately, and
0023 says so in its header. An INSERT policy would travel with the role into any
raw PostgREST call, with any `customer_id`, any `total` and no attribution.
Instead, `placePhoneOrder()` (`src/lib/data-access/manager-phone-orders.ts`) is
the only way to create one:

- It re-checks the acting role in the same scope as `createAdminClient()`, so a
  future caller that forgets `requireRole` still fails.
- The bill is computed from `menu_items` prices and live platform settings. The
  request carries dish ids and quantities and no amount at all.
- Every row it writes stamps `channel = 'phone'` and `placed_by = <the
  operator>` (migration **0029**). Both join the locked-column list in
  `guard_order_update()`, so nobody below admin can rewrite the attribution
  afterwards — including the manager who created it.
- On a database without 0029 it **refuses to place the order**. The audit trail
  is what makes writing an order in someone else's name defensible, so producing
  one without it is not an acceptable degradation.
- Payment is always COD. There is no path by which this role can mark money
  received; `payment_status` still only leaves `pending` through the service
  role after a verified signature.

### Developer pause switch (0177)

Developer panel → Operations lets the platform developer (role `developer`
only) stop new orders or pause operations. It is deliberately visible: the
customer banner shows the developer's message, and Admin/Manager staff see
"Operations are paused … by the platform developer". Every change is in
`platform_lock_events`.

- `set_platform_lock` is service-role only and re-checks that the actor is a
  developer; the server action also calls `requireRole("developer")`.
- `guard_platform_lock` refuses any other change to the lock columns, and any
  change to `accepting_orders` / `maintenance_message` while locked (admin
  form, admin RLS policy and service role alike).
- `guard_orders_platform_lock` refuses every order insert while locked.
- Level `full` sends admin and manager to `/paused` from `requireRole` and makes
  the Manager API answer `423 platform_paused`. Shops and riders keep working
  so orders already placed can be finished. The read fails open (a missing
  migration or an outage never locks staff out).
- It is a switch, not DRM: whoever owns the database can drop the triggers.

### Manager menu sheets and photo replacement (0176)

Two switches, both off until an admin turns them on per manager:
`manager.products.bulk_menu` (`POST /api/manager/vendors/[id]/menu-sheet`) and
`manager.products.replace_photo` (`POST /api/manager/products/[id]/photo`,
`GET …/photo-suggestions`). Writes go through `ops_bulk_menu_apply` and
`ops_replace_listing_photo` (service role only), which re-check the manager's
zone, log every field change as `ops` with the actor, and write one audit row.

- A sheet cannot touch another shop's dish: each update is matched on
  `restaurant_id` inside the RPC, not only in the planner.
- Restricted categories are held exactly as for a vendor's edit, and the manager
  whose sheet held a dish cannot approve it (`self_approval`, `menu_items.submitted_by`,
  which a vendor cannot set or clear).
- Stock counts on existing dishes still need `manager.products.adjust_stock` and
  go through `ops_adjust_stock` with its stale check.
- A replacement photo is either a library photo (its URL is read server-side by
  id, never taken from the request) or an upload whose bytes are checked against
  the claimed type before it reaches the public `menu-images` bucket (≤ 2 MB).
- Shop notices carry no manager name and no free text.

### Who cancelled an order, and why (0051)

`orders.cancelled_at` (0026) recorded *when* a cancellation happened and nothing
recorded *who* or *why*, so a customer looking at a run of cancelled orders had
no way to tell a restaurant rejection from their own tap. Two columns close it,
on two different footings:

- **`cancelled_by` is evidence and is never accepted from a client.** It is on
  `guard_order_update()`'s locked list and is derived by
  `stamp_order_lifecycle()` from `cancelling_party()`, which tests the caller
  against the order's customer, then `owns_restaurant()`, then `is_admin()`,
  then `is_manager()`. The customer test is first on purpose: 0040 lets an
  operator shop, and cancelling your own dinner is a customer act whatever else
  the account can do. **One exception** — a service-role writer may state it,
  because the customer cancel route holds no UPDATE on `orders` under RLS and
  writes through `createAdminClient()`, so the trigger would otherwise read the
  platform as the cancelling party on the most common cancellation there is.
- **`cancellation_reason` is deliberately not locked**, because the kitchen
  rejecting an order is exactly who should be typing it. It is bounded to 200
  characters by a CHECK, and the trigger accepts it **only on the update that
  performs the transition to `cancelled`** — every other update carries the
  stored value through untouched. Freezing it merely "once set" was not enough:
  a vendor holds UPDATE on their own orders, so on an order cancelled by support
  with no reason recorded they could have attached a sentence afterwards and had
  it render to the customer under "Cancelled by Deligro support".

A `BEFORE INSERT` trigger clears both columns, because RLS constrains rows and
not columns and an order is always created `placed`. Rows cancelled before 0051
carry null, which the customer app renders as nothing at all rather than as a
guess about whose fault it was.

Placing a phone order can create a customer account for a number that has none.
It goes through `resolveAccountByPhone()` — the same resolver OTP login uses, so
there is one account per mobile — and the action is rate-limited on the
operator's id.

## What's covered vs. still to wire

**Covered now:** server-side role gating, DB-level ownership (RLS), role can't be
self-assigned (signup trigger defaults to `customer`; `lock_role` blocks
escalation), authoritative order totals (`recompute_order_total`), consistent
404s, secrets kept server-side (`.env.local` gitignored; service-role key never
`NEXT_PUBLIC`), **security headers** (CSP, HSTS, X-Frame-Options, nosniff,
Referrer-Policy, Permissions-Policy — `next.config.ts`), and **app-level rate
limiting** (`src/lib/rate-limit.ts` via Upstash/Vercel KV, applied to the orders
API; in-memory fallback when KV env vars are unset).

Migration **0024** additionally closes the findings from the first full audit:
column-level SELECT on `restaurants` (RLS filters rows, not columns — and 0017
/ 0020 had added payout, KYC and plaintext-credential columns to a publicly
readable table), admin-only vendor creation and approval, a column guard so a
vendor cannot rewrite an order's `total`, explicit `order_items` visibility, and
`bump_banner_stat` off the anon grant. Application-side: fail-closed config,
mandatory admin MFA, OTP-verified phone changes, scrypt OTP hashing, magic-byte
upload checks, and rate limits on every write endpoint. (Admin MFA was later
removed — see **MFA** below.)

Migration **0025** adds online payment (Razorpay), shipped switched off — see
**Payments** below.

Migration **0030** fixes a control that had been asserted here and was not
true. 0024 locked `total` against every role below admin and stated that
`recompute_order_total()` was exempt "because it is SECURITY DEFINER owned by
postgres". SECURITY DEFINER changes a function's *privileges*; it does not
change `auth.uid()` or `auth.jwt()`, which still describe the requesting
customer. So the guard fired on the recompute and **no customer could place an
order** — checkout 500'd after writing an orphan order at `total = 0`. The
guard is now SECURITY INVOKER and tests `current_user`, which really is
`postgres` inside a trusted definer and `authenticated` under PostgREST. 0030
also pins `total` at INSERT: `orders — customer insert` only ever checked row
ownership, so a direct PostgREST call could post its own total.

Migration **0040** widens that same policy by exactly one role — see the note
under the role matrix. The INSERT pin is unaffected for everyone below admin,
and admin was already exempt from it and from `guard_order_update()`.

**Still to wire when you go live:** vendor payout settlement, and swapping any
remaining portal mocks for the RLS-backed data layer.

Coupon discounts are applied as of migration **0031**, and scoped to a shop
with a recorded payer as of **0041** — see below.

## Coupons

A discount is money, so none of it is the client's to state:

- **The amount is derived, never accepted.** `apply_coupon_to_order()` reads the
  order's own `order_items` for the subtotal and prices the coupon itself.
  `/api/coupons/validate` still exists, but only as the checkout's preview —
  the same split `computeChargesWith` already makes for fees.
- **`orders.discount` and `orders.coupon_code` cannot be written from a
  client.** Both are on the locked list in `guard_order_update()`, and the
  INSERT trigger from 0030 pins them alongside `total`. The sole writer is the
  SECURITY DEFINER function, which passes the guard because of 0030's
  `current_user` test.
- **One redemption per order, enforced by a unique constraint** — not by the
  code remembering to check. Two concurrent calls cannot both discount the same
  order; the loser catches `unique_violation` and reports the discount as
  already applied, which it is.
- **Codes are limited per customer.** `max_per_customer` defaults to **1**.
  Before 0031 the table had no limit column at all, so both live codes were
  usable by the same person on every order they ever placed — a promo that is
  really a permanent price cut. NULL means unlimited, so "no limit" is now
  something an admin chose.
- **The order must still be `placed`.** A coupon cannot be applied to an order
  the kitchen has already accepted, which would change a bill someone agreed to.
- `coupon_redemptions` has no INSERT/UPDATE/DELETE policy for anyone; reads are
  RLS-scoped to the customer the row is about, plus admins — and, since 0041,
  the vendor whose own code the row is against.
- **A code cannot be read unless you already know it.** Until 0041 the
  `coupons — read active` policy from 0006 handed every live code to anyone who
  asked, `anon` included, which made the preview route's session requirement and
  20/minute rate limit decorative. SELECT is now revoked from `anon`, and the
  policies admit only admins (all rows) and vendors (their own). A shopper
  reaches a coupon through `preview_coupon()`, which answers about one code they
  named and nothing else.
- **A scoped code only works at its shop.** `coupons.restaurant_id` is checked
  against the order's own `restaurant_id` inside `apply_coupon_to_order()`, not
  against a restaurant the client named.
- **Who funds a discount is recorded on the order.** `orders.discount_funded_by`
  is snapshotted from `coupons.funded_by` at redemption and is on the same
  locked list as `discount` itself. Before 0041 there was no such column, so
  every payout derived the shop's food value from a total that was already net
  of the discount — the shop funded every platform promotion and paid
  commission on the reduced value. `foodGrossFromOrder()` now adds a
  platform-funded discount back, and the COD branch remits it, because on a
  cash order the shop collected that much less at the door. A discount with no
  recorded funder reads as vendor-absorbed, so applying the migration does not
  silently re-price a settled backlog. A vendor may create only `funded_by = 'vendor'` codes,
  enforced in the RLS `WITH CHECK`, so a shop cannot write a code the platform
  would be billed for.
- **One pricing implementation.** `price_coupon()` is called by both the preview
  and the redemption. The TypeScript copy it replaced never checked
  `max_redemptions` and could not check the restaurant, so the two answers could
  disagree about the same code.

**The offer badge is derived, not typed.** `restaurants.offer` used to be a free
text field in the vendor's store editor — a shop could advertise "35% OFF up to
₹120" with no code behind it and nothing a customer could do about it. Since
0041 it is written only by `refresh_restaurant_offer()`, off that shop's own
live coupons, and a `BEFORE INSERT OR UPDATE` trigger reverts the column for
every caller except the definer function — service role and admin included,
because a hand-set badge would be silently overwritten by the next coupon write.
`offer_expires_at` carries the campaign's end so a lapsed offer stops
advertising itself without anything having to run; the app drops the badge on
read once it is past.

The delivery fee is not discountable — the discount is capped at the food
subtotal, because somebody still rides the order to the door. The discount comes
off the grand total *after* tax rather than reducing the taxable base; that
keeps one implementation of the fee-and-tax arithmetic (`src/lib/pricing.ts`)
instead of forking it into SQL. Revisit if GST-correct invoicing is needed.

## Payments

Online payment is **off by default**. The customer sees "Available soon" at
checkout and COD is the only method until *both* an admin enables it in
**Settings → Platform → Online payment** *and* the Razorpay keys are present.
`onlinePaymentsEnabled()` is the single gate; a missing key reduces what is
offered rather than being ignored.

What holds the money boundary:

- **`orders.payment_status` is the only truth about payment**, and nothing
  holding a user JWT can set it. A `before insert` trigger pins it to `pending`
  for customers, and it joins the locked-column list in `guard_order_update()`
  so a vendor, driver or manager can still only move `status`. It leaves
  `pending` exclusively through the service role, after a verified signature.
- **Two signatures, two secrets.** The browser callback is signed over
  `${order_id}|${payment_id}` with `RAZORPAY_KEY_SECRET`; the webhook is signed
  over its **raw body** with `RAZORPAY_WEBHOOK_SECRET`. Both are compared in
  constant time. The webhook must read `request.text()` before any JSON parse —
  re-serialising reorders keys and the digest stops matching.
- **A valid signature does not say *which* of our orders was paid.** It covers
  Razorpay's own ids only, so `/api/payments/razorpay/verify` also checks that
  the signed provider order belongs to the Deligro order being settled —
  otherwise a genuine signature from a ₹50 order could be replayed onto a ₹5,000
  one.
- **The webhook is the authority.** It is idempotent (unique
  `provider_order_id`), never walks a settled payment backwards, and answers 2xx
  for anything applied or duplicate so Razorpay stops retrying. It does *not*
  check whether payments are currently switched on: money already in flight when
  an admin flips the toggle off is still real.
- **No secret is configured → the endpoint 503s.** It does not process an
  unverified body.
- **The vendor never sees an unpaid online order.** The kitchen board filters to
  `payment_method = 'cod' OR payment_status = 'paid'`, so an abandoned checkout
  does not put a kitchen to work.
- `payments` has no INSERT/UPDATE/DELETE policy at all — reads are RLS-scoped to
  the customer and admins (not the vendor, driver or manager), and every write
  goes through the service role behind a signature check.

Verify the crypto with `npm run test:payments` (offline — no keys, no network).
Point the Razorpay dashboard webhook at `/api/payments/razorpay/webhook` and
subscribe to `payment.captured`, `payment.failed` and `refund.processed`.

**Deliberately not done — a nonce-based CSP.** Dropping `'unsafe-inline'` from
`script-src` requires a per-request nonce, and per the Next 16 CSP guide that
forces *every* page to render dynamically: no static generation, no ISR, no CDN
caching, and PPR becomes incompatible. That is a real cost for a storefront, so
it is a product decision rather than a default. The exploitable vector it would
have covered (a `javascript:` banner target) is closed directly instead, at both
the write and read ends. Tracked in `docs/SECURITY_AUDIT.md` under accepted risks.

**MFA: removed** (migration 0033). There is no TOTP enrollment, no challenge
screen, and no assurance-level check anywhere in the app. `MFA_EXEMPT_EMAILS` is
no longer read — drop it from every environment. Factors a user enrolled while
MFA existed remain in `auth.mfa_factors` and are simply never asked for; clear
them from the Supabase dashboard if you want them gone.

What guards an operator portal now is the sign-in page it is behind, plus the
role check in its layout:

| Portal | Door | Layout gate |
| --- | --- | --- |
| `/admin` | `/admin/login` — email or mobile + password, or phone OTP | `requireRole("admin")` |
| `/vendor` | `/vendor/login` — email or mobile + password, or phone OTP | `requireVendorAccess()` (role **or** restaurant ownership) |
| `/manager` | `/manager/login` — email or mobile + password, or phone OTP | `requireRole(["manager","admin"])` |
| `/driver` | `/driver/login` — email or mobile + password, or phone OTP | `requireRole("driver")` |
| customer app | `/login` — phone OTP, or guest | none — the app is public to any account |
| `/switch` | none — it is *behind* a door | `requireUser()`; lists only the caller's own surfaces |

**No global login.** A single `/login` used to authenticate everyone and then
route on `profiles.role`, which meant one account's role decided which app you
got: the owner's phone is an admin, so signing in to *shop* landed on the admin
console. Each door now leads to exactly one place. A door never inspects your
role to redirect you elsewhere — the portal's own layout decides whether to
admit you, and bounces back to that same door with `?denied=1` if not.

**Switching surfaces (`/switch`).** One person is often two things — the owner's
phone is an admin account *and* the account they shop with — so after a customer
sign-in `/login` lands on `/switch`, which asks which app to open. It reads
`profiles.role` (plus restaurant ownership) for **the caller's own account** and
renders links; `src/lib/auth/surfaces.ts` computes the list. An account with only
the customer app is redirected straight through and never sees the screen. The
same list drives the "Switch app" rows on the customer profile tab and the
"Customer app" link in the admin console's chrome.

This is navigation, not authorization. Every link lands on a layout that still
runs `requireRole()` / `requireVendorAccess()`, with RLS underneath. Getting the
list wrong can only offer a door the account cannot open — never open one. The
old failure mode (routing *on* role) is not back: nothing here redirects an
operator away from the customer app, and the choice is the person's, per sign-in,
with no stored preference to poison.

**Mobile + password (0039).** The first field on every operator door takes an
email address *or* a mobile number. Vendors are onboarded by hand and are told
their number and a password; most never learn the email address the account was
created against, so an email-only door locks out the people it exists for. The
mobile path runs through a Server Action (`src/app/(portal-auth)/actions.ts`),
not the browser client, because number → profile → account email must stay
behind the password check: the lookup uses the service role, the address is used
immediately and never returned, and an unknown number and a wrong password give
the same reply. It is rate-limited on two buckets — per caller IP and per number
— so neither walking a list of numbers nor a distributed attempt on one number
is cheap. It grants nothing: the portal layout's `requireRole()` /
`requireVendorAccess()` still decides who is admitted.

**Vendor passwords are stored, deliberately (0039).** This reverses audit
finding C-2, and the reasoning is in the migration header rather than only in
this paragraph. The admin desk is the support channel for shop owners who lose
their login, and rotating a working credential mid-service is the wrong answer
to "what was my password". What made the old `restaurants.temp_password`
unacceptable was *where* it lived — a row anon and authenticated could read.
The replacement is `vendor_login_credentials`: its own table, RLS enabled with
zero policies, every privilege revoked from `anon`/`authenticated` and granted
only to `service_role`, read solely through the `server-only`
`src/lib/data-access/vendor-credentials.ts` from paths already gated by
`requireRole("admin")`, with `updated_by` recording which admin last set it.
Supabase Auth still holds the bcrypt hash that authenticates; this is a copy for
hand-off, written in the same operation. The admin UI keeps it masked until a
row is revealed, one at a time.

Every door offers phone OTP as well as a password, because operator accounts are
not all email accounts — the owner's admin account is a phone account seeded by
`scripts/seed-developer.ts`, and an email-only admin door would lock it out. That
is not new exposure (the old global `/login` already handed that account admin on
an OTP), but it does mean **possession of an admin's phone number is possession
of the admin console**. With MFA gone and no second factor behind it, the
operator-account hygiene items in `docs/SECURITY_AUDIT.md` — unique addresses, no
shared logins, rotation on offboarding, and now control of the registered mobile
— are the whole of the account-security story.

## Observability (0046)

The admin Observability centre records telemetry about the platform's own
failures. That makes it a new store of operational data and a new public write
endpoint, so it is worth reading as a security surface rather than as a feature.

**Containment.** The nine `obs_*` tables follow the `rate_limits` (0027) and
`vendor_login_credentials` (0039) pattern exactly: RLS enabled **and forced**,
**zero policies**, every privilege revoked from `anon` and `authenticated`, and
granted only to `service_role`. There is no PostgREST path to them and no
authenticated path. Reads happen solely through the `server-only`
`src/lib/obs/read.ts` and `src/lib/obs/metrics.ts`, each of which begins with
`requireRole("admin")` before it touches `createAdminClient()` — the check sits
above the RLS bypass in the same path, per the project rule. Every Server Action
in `src/app/admin/observability/actions.ts` re-checks the role for the same
reason: a layout gate protects a page, not an endpoint.

**Access is admin-only, and that is a decision rather than an omission.**
`profiles.role` is a five-value enum for the whole platform, so there is no
admin sub-role to hang a read-only or support-scoped tier on. Adding one would be
a security change of its own and would need its own audit. `manager` does not
reach this section. Recorded as Q1 in `docs/OBSERVABILITY_PLAN.md` §12.

**Redaction is enforced at write, never at display.** `src/lib/obs/redact.ts`
runs inside `emit()` *before* the row is built, so no code path — including a
future debug flag — can put an unredacted value in the table. `attrs` is an
**allowlist**, not a deny-list: a field nobody thought about is invisible until
someone adds it deliberately, the same default the `restaurants` column grant
uses. Denied key names are matched after stripping separators, so `apiKey`,
`API_KEY` and `x-api-key` collapse to one rule. Free text (messages, stack
traces) is additionally scrubbed for Luhn-valid card numbers, JWTs, `rzp_*` /
`sk_*` / Bearer credentials, emails and Indian mobile numbers.

**What is deliberately never collected:** request bodies, response bodies, IP
addresses, names, phone numbers, emails, and every header outside a four-key
allowlist. `x-razorpay-signature` is specifically excluded — it is the entire
authentication of the payment webhook, so logging it would put a replayable
credential in a table an operator browses. Identity is a `profiles.id` UUID and
nothing else; the console resolves it to a customer page, where access is
already audited.

**`POST /api/obs/client` is the one anonymous write endpoint.** It is
rate-limited by IP (30 per 5 minutes), refuses anything but three known report
shapes, and re-derives every field server-side — the caller cannot choose its
own level, kind, severity, environment, actor or order id, so a script cannot
write `critical` production issues into an operator's queue or attribute its
noise to somebody else's account. The actor comes from the session cookie or is
null. It answers 204 for everything it discards, so it is not a probing oracle.

These rules are tested rather than asserted: `npm run test:obs`
(`scripts/qa/obs-telemetry.ts`) emits synthetic events carrying a card number, a
JWT, a password field and a signature header, and fails if any of them reaches
the stored row.

**Environments never merge.** `env` is part of the issue fingerprint, so a
developer's deliberate test failures cannot inflate a production issue's count,
and the console filters to production by default with a banner when it does not.

### CSP note
The CSP in `next.config.ts` allows `'unsafe-inline'` for scripts because of the
inline pre-paint theme bootstrap. To fully harden against XSS, generate a
per-request nonce in `src/proxy.ts`, attach it to the bootstrap `<script>`, and
replace `'unsafe-inline'` with `'nonce-…'` in `script-src`.

## Setup

1. Create a project at [supabase.com](https://supabase.com) (free tier).
2. `cp .env.example .env.local` and fill in the URL + anon key + service-role key
   from **Settings → API**.
3. Run the migration: paste `supabase/migrations/0001_init.sql` into the Supabase
   **SQL editor** and run it (or `supabase db push` with the CLI).
4. Create users in **Authentication → Users**. Each gets a `customer` profile by
   default. To make someone an admin/restaurant/driver, run in SQL:
   ```sql
   update public.profiles set role = 'admin' where id = '<user-uuid>';
   ```
5. Restart `npm run dev`. Auth + enforcement are now live; without keys the app
   runs as a static demo (enforcement off).
6. Run `0002_catalog_display.sql`, then `npm run db:seed` to load restaurants.

## Test it yourself (do this before launch)

### Automated suite (preferred)

```bash
# Password for QA + demo accounts (never commit). Creates qa-customer-a/b@deligro.qa.
QA_PASSWORD='…' npm run test:idor     # RLS + HTTP cross-account IDOR
BASE_URL=http://localhost:3003 npm run test:e2e   # guest gates, headers, auth walls
ZAP_TARGET_URL=https://your-staging.example npm run test:zap   # OWASP ZAP baseline
npm run test:obs                      # telemetry redaction, grouping, severity (offline)

# All three (ZAP only if ZAP_TARGET_URL / STAGING_URL is set):
QA_PASSWORD='…' BASE_URL=http://localhost:3003 npm run test:qa
```

Scripts live in `scripts/qa/`. The IDOR suite provisions two customers, plants an
order + address for A, then asserts B gets **null / 404** (never a data leak),
vendors/drivers cannot see unowned orders, and `lock_role` blocks escalation.

`test:obs` needs no database and no server: it asserts that a card number, a
JWT, a bearer token, a password field and the Razorpay signature header are all
absent from a stored telemetry row, that identical bugs with different order ids
group to one issue, that production and development never merge, and that the
root-cause engine reports **Unknown** rather than inventing a cause.

### Manual spot-checks

- Create two customers, A and B. Sign in as A, note an order id from the Network
  tab, then `GET /api/orders/<A's id>` while signed in as **B** → must be **404**.
- Sign in as a customer and open `/admin` → must redirect to `/login?denied=1`.
- Try to `update public.profiles set role='admin'` as a normal user via the API →
  blocked by `lock_role`.
- Run OWASP ZAP against a **staging** copy, never production data
  (`npm run test:zap`).
