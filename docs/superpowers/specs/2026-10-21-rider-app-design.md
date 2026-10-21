# Deligro Rider app — design

Date: 2026-10-21 · Branch: `feat/rider-app` · Worktree: `F:\hub26\deligro-rider` · App: `apps/rider`

## Intent

A native Android app for a Deligro delivery rider to work a shift without the
website: go online, receive and accept or reject offers, ride to the shop and
the customer with navigation, prove pickup and delivery, see what they have
earned and what cash they hold, look back at their history and performance,
manage their documents, and reach Deligro when something goes wrong — including
in an emergency.

Source of truth for scope: the client's *Deligro Rider App — Complete Feature
Requirements Document* (sections 1–18). The owner's instruction: **every
section complete — nothing partial or "mostly"**, built in phases; the
dashboard shows exactly the client's twelve figures, in **our** UI and
aesthetic (the customer app's design system). Out of scope, as the document
says: rider staff accounts and vendor staff handling.

## Current state (audit, 2026-10-21)

The Rider APK today is the Capacitor wrapper around the website's `/driver`
portal: Jobs, History, Profile. It has accept, Google Maps hand-off, pickup and
delivery codes, cash-to-collect, location while a delivery is active, ringing
pushes, and a sound server-side state machine (`advanceDelivery`, the 0055
triggers). It has no online/offline state, no reject, no countdown, no
arrival or failed states, no earnings (removed: riders were recorded as
salaried, 0047), no rider-side cash view, no documents, support, safety,
inbox, Hindi or settings. Roughly a quarter of the document.

## Decisions

Calls made by Claude unless marked *owner*.

### App

- Flutter, `apps/rider`, same structure as `apps/customer` (Riverpod,
  go_router, supabase_flutter, `/api` through the `@supabase/ssr` cookie
  bridge, OneSignal). Copied and adapted, not shared through a package — same
  reasoning as the Partner app.
- App ID `com.ractrotech.deligro.rider` (installs over the Capacitor Rider
  app), display name **Deligro Rider**, version `2.0.0+3` (Capacitor is at
  versionCode 2). Released on the existing `rider` track of `/api/app-version`
  (`platform_settings.rider_apk_*`, migration 0045).
- Look *(owner: "our UI and aesthetic")*: the customer app's tokens — Inter,
  warm off-white surfaces, orange accent, JetBrains Mono for figures — light
  and dark. Rider art from `Resources/…/Electric Cycle3DIcon*.svg` rendered to
  PNG (never WebP: release builds dropped WebP).
- Bottom bar: **Home · Jobs · Earnings · History · More**. Home is the §1
  dashboard; Jobs is offers and the active delivery (it becomes the app's
  front screen whenever a delivery is active); More holds Cash, Performance,
  Notifications, Profile & documents, Help, Safety, Settings.
- Language: every string an English/Hindi pair via `tr(en, hi)`, switch in
  Settings, English by default. Hindi is required here (§16.1), unlike the
  Partner app's "where feasible".
- Login: phone OTP (existing `/api/auth/otp/*`), mobile + password (the
  Partner app's `/api/auth/password-login`, see *Shared with the Partner
  app*). Only `profiles.role = 'driver'` gets past the gate; anyone else is
  told plainly and offered sign-out.
- Pushes: OneSignal, `external_id = profile id`, as today. New offers ring
  through a native ring service ported from `mobile/native/RingService.java`
  / `DeligroNotificationExtension.java` (same `{ring:'start'|'stop', ringId}`
  protocol the server already sends to riders). Audible alerts can be muted
  per category in Settings, never for an offer held for this rider unless the
  rider is offline.
- Location: `geolocator` with its Android foreground-service notification
  ("Deligro Rider is sharing your location while you're online"), so tracking
  survives the screen locking. Every 30 s while online and idle, every 10 s on
  an active delivery, nothing while offline. A first-run disclosure screen
  explains what is collected and why before any permission prompt (Play
  prominent-disclosure rule; §5 "transparent, permission-based").
- Updates: the Jobs screen polls `GET /api/rider/board` every 5 s while
  foregrounded; Home every 15 s; pushes cover the background. No Supabase
  realtime (matches the Partner app; one transport to debug).
- Offline: the active delivery is cached on the device and stays on screen
  with no signal. Status changes made offline are queued with a client action
  id and replayed in order when the connection returns; the server treats the
  action id as an idempotency key, so a replay can never double-advance,
  double-complete or double-earn (§17.6–17.8).

### Backend

- Migrations `0081`+ (the Partner app owns `0061`–`0080`, so numbers never
  collide while both branches are open). Each ships a PGlite proof in
  `scripts/qa/sql/` and a rollback block in its header, house style. **Applying
  them to the live database and deploying the website is the owner's step.**
- Every app write goes through a `/api/rider/*` route: rider role check, rate
  limit, the rider id taken from the session and never from the body,
  `createAdminClient()` only under that check. Reads that RLS already scopes go
  to Supabase directly only where noted; everything else through the API.
- The web `/driver` portal keeps working during the transition; its Server
  Actions and the new routes call the same data-access functions, so web and
  app cannot drift. It is not extended with the new features — the app
  replaces it.
- Ops screens the new features need (approvals, documents, payouts, tickets,
  incidents) are built in the existing admin/manager consoles, following the
  console rules in `AGENTS.md` (two shells, tokens only, container queries).

### Shared with the Partner app

These are one feature serving both apps. Whichever branch builds one first
builds it role-generic; the other merges that commit in rather than writing a
second copy (AGENTS.md: one source of truth).

- `POST /api/auth/password-login` — Partner phase 1, Task 3.
- `order_status_events` (0061) — the rider app shows the order's history from
  it; delivery-level events get their own table (below).
- Support tickets (`support_tickets`, `support_messages`, private
  `support-attachments` bucket, admin screen) — Partner phase 6, rider phase 7.
  Shape: `requester_id`, `requester_role`, `category`, `priority`
  (`normal`/`high`/`emergency`), `order_id`, `status`, `lat`/`lng` (rider
  safety reports), timestamps.
- In-app inbox: one role-generic `user_notifications` table (recipient,
  kind, title, body, data, read_at) written wherever a push is sent, and
  `announcements` (audience role, admin-authored). The Partner design names a
  `vendor_notifications` table; the owner should point that session at this
  generic one before either is built.

### Delivery statuses (§4)

The `delivery_status` enum gains one value, `failed`. Everything else is a
timestamp on `deliveries`, the same approach as the Partner app's
`preparing_at`, so rider, manager, customer and web code keep reading the
statuses they already understand:

| App status | Database |
|---|---|
| Assigned (offered) | `unassigned` + `offered_driver_id` = rider, inside the window |
| Accepted | `assigned` |
| Arrived at Pickup | `assigned` + `arrived_pickup_at` |
| Order Picked Up | `picked_up` + `picked_up_at` (order `on_the_way`) |
| On the Way | `picked_up` + `departed_pickup_at` (set by "Start trip", or automatically when the rider leaves the shop geofence) |
| Arrived at Customer | `picked_up` + `arrived_drop_at` |
| Delivered | `delivered` + `delivered_at` |
| Failed Delivery | `failed` + `failed_at`, `failure_reason` (only through an approved exception, below) |
| Cancelled / Reassigned | `cancelled`, or a `delivery_events` row `reassigned` when ops moves it to another rider |

Rules, enforced in a `guard_delivery_transition` trigger (service role
included — the app is not the only writer that can get this wrong):
`delivered` requires `picked_up_at`; `picked_up` requires the order to be
`ready`; arrival stamps are set once; `failed` requires an approved exception.
The existing conditional updates in `advanceDelivery` stay. Manager/admin
corrections remain possible through the guarded admin path and are logged.

**`delivery_events`** (new): one row per offer, accept, reject, lapse,
arrival, pickup (with method), departure, delivery (with method), failure,
reassignment, exception request/decision — actor, time, reason, method,
lat/lng, client action id (unique). Written only by triggers and the data
layer. The rider reads their own; ops read all. This is the §17.5 audit trail
and the source for history, timelines and performance.

### Offers and dispatch (§2, §3)

- New `rider_status` table: `driver_id`, `is_online`, `break_until`,
  `last_lat/lng`, `last_fix_at`, `online_since`, `updated_at`; and
  `rider_shifts` (one row per online session) for hours and attendance.
- `chooseRider()` considers only riders who are online, not on break and have
  a fix younger than `MAX_FIX_AGE_MS` (§2.2). If none qualify, the order waits
  in the pool and the existing "no rider" ops alarm fires, as today.
- Going offline is refused while the rider has an active delivery or an
  outstanding offer, unless an approved `go_offline` exception exists (§2.4).
  Logout sets offline server-side before the session ends (§2.5). Breaks: 15,
  30 or 60 minutes, or until resumed; a break hides the rider from dispatch
  without ending the shift (§2.6).
- High demand (§2.7): the existing dispatch sweep counts ready-or-cooking
  orders without a rider against online idle riders; past a threshold set in
  admin settings it pushes offline riders "Orders are waiting near you",
  throttled to once per 30 minutes per rider.
- Offer card (§3): order code, shop name and address, drop address, distance
  shop→customer and rider→shop, estimated delivery time (rider→shop +
  remaining prep + shop→customer, same model as the customer ETA), estimated
  earning from the rate card, cash to collect, delivery instructions
  (address landmark and the customer's note), **Accept** and **Reject**.
- Countdown: the existing `EXCLUSIVE_OFFER_MS` window (180 s, now an admin
  setting) shown as a live countdown ring. Reject asks for a reason (too far,
  vehicle issue, on a break, other). Rejected or lapsed offers go back to
  dispatch, which re-offers to the next rider excluding this one (the sweep
  already does this for lapses; reject triggers it immediately).

### Pickup and delivery verification (§6, §7)

- Arrival at the shop and at the customer: a button, also suggested
  automatically inside a 150 m geofence. Arrival at the customer pushes the
  customer ("Your rider has arrived"), replacing today's position-based
  arriving push only as the second, final notice.
- Pickup confirmation, any one of: **pickup code** typed (exists); **QR**
  scanned from the vendor's order screen (encodes the same code, so the server
  check is unchanged; the Partner app and web vendor board render it);
  **vendor confirmation** (the vendor taps "Handed to rider", which records
  the pickup — needs one vendor route, built here); **manual verification**
  (an ops-approved `manual_pickup` exception). The method is recorded on the
  event. Double-taps are absorbed by the conditional update plus the action
  id (§6.6).
- Report at pickup: missing items, wrong package, vendor delay — creates a
  support ticket linked to the order with priority `high`, pushes ops, and
  for vendor delay also notes it on the order timeline.
- Delivery confirmation: customer **delivery code** (exists, rate-limited).
  **Proof-of-delivery photo** where required: an admin setting chooses
  never / COD only / always / only for exception completions (§7.5 "only when
  operationally necessary"). Photos go to a private `delivery-proofs`
  bucket, viewable through short-lived signed URLs by the rider, ops and the
  customer of that order only, deleted after 90 days by the cron. The camera
  screen tells the rider to photograph the package at the door, not people.
- **Exceptions** (§2.4, §6.3, §7.6–7.8): one `delivery_exceptions` table —
  kinds `customer_unreachable`, `wrong_address`, `complete_without_code`,
  `failed_delivery`, `manual_pickup`, `go_offline`, `return_to_shop` — with
  reason, notes, optional photo, rider location, status
  `pending/approved/rejected`, decider and time. The rider app requires the
  rider to have called the customer (logged) and waited at least the
  admin-set minutes before `customer_unreachable` can be raised. Managers and
  admins see pending exceptions on their boards with a sound and decide them;
  approval of `failed_delivery` sets the delivery `failed` and cancels the
  order through the existing cancellation path (refund rules unchanged,
  `cancelled_by` = the deciding role); approval of `complete_without_code`
  completes it with method `ops_approved`.

### Navigation (§5)

- Navigate opens the rider's chosen app (Settings): Google Maps (turn-by-turn
  intent, default), or any other app that handles `geo:` links. Recalculation
  is the navigation app's job (§5.7).
- In-app map (flutter_map, OSM tiles, as the customer app): rider, shop and
  drop, with the route line and ETA from OSRM's public routing API; if routing
  is unavailable, a straight line and a haversine ETA labelled "approx.".
- Call customer and **call vendor** buttons. The customer's number reaches the
  app only while the rider holds that order (existing rule); the shop's number
  likewise. Both respect the `driver.call_customer` switch. *(Number masking
  through a calling provider is not built — no provider is contracted; the
  approved contact option is the direct call, as today.)*
- Tracking stops the moment the delivery completes: the server answers
  `active:false` and the service drops to the idle cadence, or stops if the
  rider is offline (§5.9).

### Money — earnings, incentives, payouts (§1, §8, §9)

*Owner, by "complete all of these": riders see per-delivery earnings,
incentives, bonuses and payouts.* The pay model itself is set by admin, not
code, so the client can run per-delivery pay, salary plus incentives, or pure
salary (per-delivery rates at ₹0, salary recorded as an adjustment) without a
rebuild.

- **Rate card** (admin settings): base fee per delivery, km included, rate
  per extra km, minimum per delivery, and the distance basis (shop→customer
  road distance from OSRM at acceptance, stored on `deliveries.distance_km`;
  haversine × 1.3 if routing fails). The parked `riderPayout()` in
  `pricing.ts` is deleted, not revived — it was a share of the food bill.
- **`rider_earnings`** ledger, one row per delivered delivery, **unique on
  `delivery_id`**, written by a trigger when a delivery becomes `delivered`
  from the rate card in force at that moment (components stored, not
  recomputed): base, distance, tip (a COD order's tip is already in the
  rider's hand, so it's shown but not paid again), final. Never on a failed
  or cancelled delivery (§17.6, §18.4).
- **Incentive rules** (`rider_incentive_rules`, admin): daily or weekly
  target of N completed deliveries → bonus ₹X, optional peak-hour window,
  active dates. When a rider's count crosses a target, a trigger writes one
  incentive row, unique on (rule, rider, period). Riders see each rule, its
  eligibility and their progress (§9.1–9.4). Rules are shown to riders
  verbatim, so the calculation is transparent (§9).
- **`rider_adjustments`** (admin): bonus, adjustment (+/−), deduction, salary,
  each with a reason the rider can read.
- **`rider_payouts`** (admin records a payout: period, amount, method,
  reference, date). Earnings and adjustments are attached to the payout that
  paid them, so each record shows *paid / pending*, the settlement date and
  reference (§8 record fields). Amount already paid = sum of payouts; pending
  payout = unattached earnings + incentives + adjustments.
- **Statement**: date range → in-app view, and a PDF and CSV the rider can
  save or share (§8 "download or view").
- Earnings are always shown apart from cash collected on Deligro's behalf
  (§10).

### Cash (§10)

- Already recorded: `deliveries.cod_collected_amount/at` at delivery, and
  `cod_handovers` (rider → manager legs) recorded by managers on
  `/manager/cash`.
- Rider view: cash to collect (active and assigned COD orders), collected
  today, deposited (handovers from this rider), pending deposit (collected −
  deposited), order-wise collection list, and which orders were prepaid
  online (digital payment confirmation).
- **Deposit submission**: the rider declares a deposit (amount, manager,
  method cash/UPI, reference, optional photo of the UPI receipt) →
  `cash_deposits` row `submitted` → the manager confirms on `/manager/cash`,
  which writes the `cod_handovers` row and marks the deposit `confirmed`, or
  marks it `disputed` with a note. A manager can still record a handover
  directly, as today.
- Reconciliation status per day: *settled* (deposited = collected),
  *pending*, *disputed*. Disputes from the rider ("amount is wrong") open a
  support ticket in category *Cash reconciliation issue* linked to the day.
- Reminder push when pending cash exceeds an admin-set amount or is older
  than an admin-set number of hours (§11.10).

### Performance and ratings (§9)

- From `delivery_events` and `deliveries`: completed vs daily and weekly
  target, average delivery time (accepted → delivered and picked up →
  delivered), acceptance rate (accepted ÷ offers made), failed delivery rate,
  online hours from `rider_shifts`, and a month-by-month table (§9.10).
- **Rider ratings**: a new `rider_ratings` table (order, rider, 1–5, optional
  comment, unique per order). Customers rate the rider on the order screen
  after delivery — in the customer Flutter app and on the website — next to
  the existing restaurant review. Riders see their average, count and recent
  comments without the customer's name.

### Notifications (§11)

Push and inbox for: new offer (rings), offer cancelled or order reassigned,
pickup reminder (order ready and the rider not yet arrived after N minutes),
delivery instructions changed by the customer, delay alert (the delivery is
past its ETA by N minutes — to the rider, and ops), payout recorded,
incentive earned, announcement, ticket reply or status change, cash
reconciliation reminder, document expiring, exception decided, high demand.
Each category can be switched off in Settings except offers, cancellations
and safety; preferences are stored server-side so the server honours them.
Sound and vibration are separate switches.

### Profile and documents (§12)

- `rider_profiles`: rider ID (`DR-0001`, sequence, unique, shown on the
  profile and printed on statements), address, vehicle type, registration
  number, licence number and expiry, emergency contact, notification and
  navigation preferences, language.
- **Bank / UPI details** live in `rider_payout_accounts`: RLS on, no policies,
  all privileges revoked from anon and authenticated, service role only,
  reached through a `server-only` module behind an admin check — the
  `vendor_login_credentials` containment pattern. The rider sees and submits
  them masked (last four digits).
- `rider_documents` in a private `rider-documents` bucket: types Aadhaar,
  PAN, driving licence, vehicle RC, insurance, PUC, photo; number, expiry,
  status `pending/verified/rejected`, reviewer remarks. Only the rider and
  admins can read them.
- Changes to verified fields (name, licence, vehicle, bank) go through
  `rider_profile_change_requests` → admin approves; unverified fields save
  directly. Name/photo/phone keep today's flows.
- Daily cron: documents expiring in 30, 7 and 1 days push the rider and
  appear on the admin rider screen.
- Admin: **Riders** page (list with online state, phase, last fix, rider ID;
  detail with profile, documents to verify, change requests, earnings,
  adjustments, payouts, cash, performance, incidents). Rider accounts are
  still created from Settings → Employees; creation also creates the
  `rider_profiles` row and rider ID.

### Help, safety (§13, §15)

- Help: call or WhatsApp Deligro support (numbers from settings), raise a
  ticket with the document's eight categories, link an order, attach up to 4
  photos, see status and replies, and past tickets.
- Safety screen and an SOS button on the active-delivery screen: **Call 112**
  (dials it on the phone — labelled "This calls 112 from your phone"),
  **Alert Deligro** (an `emergency` ticket with live location, pushes and
  rings every manager and admin, appears at the top of their boards), call
  the rider's emergency contact, and report forms for unsafe situation,
  accident, breakdown, harassment or threats, suspicious order or location.
  Wording never says emergency services were contacted unless the rider
  dialled them (§15).
- Dispatch can call the rider: the admin rider page and the manager board
  show the rider's number and a call button while a delivery is active (§15.5).
- All incidents are tickets with a safety category, so they share the audit,
  attachments and admin screen; only authorised staff can read them.

### History (§14)

All of the rider's deliveries — delivered, failed, cancelled, reassigned
away — newest first, filter by date range and status, each with order code,
shop, pickup and delivery times, distance, earning, failure or cancellation
reason (and who cancelled), proof of delivery (code / photo / ops-approved)
and the event timeline.

### Settings (§16)

Language (English/हिन्दी), notification categories, sound, vibration,
navigation app, app version with update check (`/api/app-version`, rider
track, forced updates honoured), privacy and terms, location disclosure, sign out, and **sign out of all devices** (revokes every
session; §16.8).

Privacy and terms: Deligro has no published privacy policy or terms, and the
codebase deliberately does not invent legal text (see the customer
`/profile/privacy` page). The app shows a factual *Privacy & data* screen —
what it holds, who sees it, for how long — and links the real policy and
terms from two admin settings (`privacy_policy_url`, `terms_url`) once they
exist. Writing those documents is an owner step.

### Security (§17)

Covered by the rules above: OTP or password login; one account and rider ID
per rider; every read scoped by the session's rider id; server-side
transition guard plus trigger; `delivery_events` audit trail; idempotent
action ids and unique earnings; offline queue; customer numbers only during
the delivery; location only while online, disclosed. Every new table goes
through `docs/SECURITY_AUDIT.md`.

### Testing and release (§18)

Each phase ends with migrations proven in PGlite, routes covered by QA
scripts, Flutter unit and widget tests, analyzer clean, every new screen
checked on the emulator from the **release** APK (low-end profile: 2 GB RAM
AVD), and a commit with a short report. GPS, notifications, navigation hand
-off, codes, cash and payout maths each get a named test. The last phase
produces a signed test build for the client before production.

## Phases

1. **Foundation** — migration 0081 (`rider_status`, `rider_shifts`,
   `rider_profiles` + rider ID, `delivery_events`, delivery timestamps and the
   `failed` value, transition guard); `/api/rider/me`, online/offline/break,
   location; dispatch considers only online riders; logout goes offline; app
   scaffold (theme, splash, login OTP + password, gate, shell, Settings,
   language, update check), location disclosure and foreground service.
2. **Jobs** — board API; offers with countdown, accept, reject with reason;
   the full status flow with arrival, pickup by code / QR / vendor
   confirmation / manual, start trip, delivery by code and photo; exceptions
   with manager/admin approval screens; navigation app choice, in-app map and
   ETA; call customer and vendor; native ring; offline queue and cached
   delivery; order timeline; pickup and delivery issue reports.
3. **Money** — rate card and incentive rules (admin), earnings ledger,
   incentives, adjustments, payouts (admin), Earnings tab with every §8
   figure and record field, statements PDF/CSV.
4. **Dashboard, history and performance** — the twelve-figure Home, History
   with filters and detail, Performance with targets and reports, rider
   ratings (customer app and website side included).
5. **Cash** — rider cash screens, deposit submission, manager confirmation,
   reconciliation status, disputes, reminders.
6. **Profile and documents** — rider profile, vehicle, licence, emergency
   contact, payout account, documents and verification, change requests,
   expiry reminders, admin Riders pages.
7. **Help, safety and notifications** — tickets (shared), SOS and incident
   reports, inbox and announcements (shared), high demand, pickup reminders,
   delay alerts, notification preferences honoured server-side.
8. **Release** — Hindi pass over every screen, security and deployment
   checklists, full QA on the low-end AVD, signed release build, handover
   notes and the client test build.

## Requirement map

Every numbered line of the client's document, and the phase that delivers it.

| § | Requirement | Phase |
|---|---|---|
| 1.1–1.6 | Today's / pending / accepted / picked-up / completed / cancelled counts | 4 |
| 1.7–1.9 | Today's earnings, total earnings, pending payments | 3 data, 4 tiles |
| 1.10–1.11 | Online status, current delivery status | 1, 4 |
| 1.12 | Incentives earned | 3, 4 |
| 1.— | Figures update automatically | 4 (15 s poll + on return to app) |
| 2.1–2.3, 2.5 | Online/offline, dispatch only online, status shown, logout offline | 1 |
| 2.4 | Offline blocked during delivery unless authorised | 1 rule, 2 exception |
| 2.6 | Breaks | 1 |
| 2.7 | High-demand alert | 7 |
| 3.1–3.9 | Offer details incl. ETA, earning, cash, instructions | 2 (earning figure 3) |
| 3.10, countdown, reassignment | Accept/Reject, countdown, back to dispatch | 2 |
| 4 statuses | All nine statuses | 1 schema, 2 flow |
| 4.1–4.10 | Delivery details, contacts, instructions, cash, history, time, distance | 2 |
| 4 rule | No delivered before pickup except admin correction | 1 trigger |
| 5.1–5.4, 5.7–5.8 | Navigation, route, ETA, recalculation, calls | 2 |
| 5.5–5.6, 5.9 | Location while active / online, stop on completion | 1 |
| 5 rule | Transparent, permission-based location | 1 |
| 6.1–6.6 | Pickup details, arrival, OTP/QR/vendor/manual, time, reports, no duplicates | 2 |
| 7.1–7.8 | Arrival, OTP, POD, time, photo safeguards, failure reason, reports, authorised exceptions | 2 |
| 8.1–8.12, record fields, statement | Earnings section | 3 |
| 9.1–9.4 | Targets, rules, bonus progress | 3 |
| 9.5–9.10 | Completed vs target, times, rates, ratings, reports | 4 |
| 10.1–10.9 | Cash section | 5 |
| 11.1–11.2 | Offer and cancellation pushes | 2 |
| 11.3–11.10, inbox, audible | Remaining notifications | 7 (6.— expiry, 3.— payout/incentive pushes land with their features) |
| 12.1–12.3 | Name, photo, phone, rider ID | 1 (ID), 6 |
| 12.4–12.13 | Address, vehicle, licence, documents, verification, expiry, emergency, bank, change requests | 6 |
| 13.1–13.7 | Support and escalation | 7 |
| 14.1–14.9 | History | 4 |
| 15.1–15.7 | Safety | 7 (15.5 dispatch call: 2) |
| 16.1–16.8 | Settings | 1 (language, version, logout, sessions, privacy), 7 (notification prefs), 2 (navigation app, sound) |
| 17.1–17.10 | Security and reliability | 1–2, verified in 8 |
| 18.1–18.10 | Integration, sync, real time, states, low-end, tests, test build | every phase, signed off in 8 |

## Owner steps outside this repo

- Apply migrations `0081`+ to staging, then production; deploy the website.
- Set the rate card, incentive rules, POD-photo rule, unreachable-wait and
  cash-reminder thresholds in admin before riders switch apps (defaults ship
  at ₹0 per delivery, so nothing is paid by accident before they're set).
- Publish a privacy policy and rider terms, and set their URLs in Admin →
  Settings (the app shows the links as soon as they are set).
- Sign the release APK with the existing `deligro-release.jks` rider alias.
- Tell the Partner-app session about the shared pieces above
  (`user_notifications`, support tickets, password login).
- Confirm a staging Supabase project for end-to-end tests; without one, new
  flows can only be exercised against local Postgres and live read paths.
