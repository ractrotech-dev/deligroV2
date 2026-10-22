# Rider app — requirement coverage

Phase 8 Task 3 · 2026-10-22 · branch `rider/p8-cov` (base `fcf54c3`, every phase merged)

Every numbered line of the client's *Deligro Rider App — Complete Feature
Requirements Document*, in the client's order, with the code that delivers it
and the test that proves it. Each claim was checked against the code and a test
that runs in `scripts/qa/rider-run-all.sh`, not taken from the plans. A line
without both a working implementation and a running test is a **Defect**.

Owner decisions that change requirements:

- **English only** (2026-10-21) — replaces §16.1's Hindi/English setting.
- **Salaried riders** (ruling P3-R11) — riders are paid a fixed salary outside
  the app; the ledger records salary, bonus, incentive, deductions and payouts.
  There is no per-delivery pay: "Earnings per delivery" reads *Salaried — not
  paid per delivery*, offers show no estimate, ₹0 per-delivery rows are never
  shown as money.
- **No published legal text** — the privacy policy and terms links come from
  admin settings (`privacy_policy_url`, `terms_url`); no legal text is invented.

## Summary

| § | Section | Rows | Delivered | With owner override | Defect |
|---|---|---|---|---|---|
| 1 | Rider Dashboard | 13 | 13 | 0 | 0 |
| 2 | Online / Offline Availability | 7 | 7 | 0 | 0 |
| 3 | New Delivery Requests | 12 | 11 | 1 | 0 |
| 4 | Delivery Management | 20 | 20 | 0 | 0 |
| 5 | Navigation & Location Tracking | 10 | 10 | 0 | 0 |
| 6 | Pickup Verification | 6 | 6 | 0 | 0 |
| 7 | Delivery Verification | 8 | 8 | 0 | 0 |
| 8 | Rider Earnings & Payment | 22 | 18 | 4 | 0 |
| 9 | Incentives & Performance | 11 | 11 | 0 | 0 |
| 10 | Cash Collection & Reconciliation | 10 | 10 | 0 | 0 |
| 11 | Notifications | 12 | 12 | 0 | 0 |
| 12 | Rider Profile & Documents | 14 | 14 | 0 | 0 |
| 13 | Help & Support | 7 | 7 | 0 | 0 |
| 14 | Delivery History | 9 | 8 | 1 | 0 |
| 15 | Safety & Emergency Features | 8 | 8 | 0 | 0 |
| 16 | App Settings | 8 | 6 | 2 | 0 |
| 17 | Security & Reliability | 10 | 10 | 0 | 0 |
| 18 | Developer Implementation Requirements | 10 | 8 | 0 | 2 |
| F | Final deliverable and scope note | 2 | 2 | 0 | 0 |
| | **Total** | **199** | **189** | **8** | **2** |

### Defects

| ID | Line | What is missing |
|---|---|---|
| D1 | 7.5 | **Fixed (ruling P8-R4):** the dispatch sweep deletes proof photos of deliveries that ended (delivered or failed) more than 90 days ago (hourly, at most 100 a run, oldest first, idempotent; held while the order has a pending exception or an open support ticket), clears `pod_photo_path` and stamps the new `deliveries.pod_photo_removed_at` (added to the unapplied 0082; no guard refuses the write — PGlite 0083); the customer web and app say "Photo removed after 90 days"; the camera step says "Photograph the package at the door — not people." Was: no retention and no guidance. |
| D2 | 11.2 | **Fixed:** a manager/admin hand-assignment (`assignRider`, the only staff assign path) now reads the offeree before the claim and, after it, calls `notifyOffereeOfHandAssignment`: their ring stops and, if the order went to someone else, they get a `cancellations` push and inbox row. The cancel path `cancelDeliveryForOrder` → `notifyDriverOrderCancelled` is now tested end to end. Was: the offeree kept ringing and was never told; the cancel trigger was untested. |
| D3 | 11.6 | **Fixed:** recording a payout now announces it to the rider through `announcePayoutRecorded` → `notifyRiderPayoutRecorded`. Was: the notifier had no caller. |
| D4 | 18.7 | The low-end device proof is not done yet: no cold-start time, memory-over-10-minutes or battery observation on the 2 GB `deligro_low` AVD (Phase 8 Task 4). The limited-connectivity half is built and tested (offline queue, cached delivery, image shrinking). |
| D5 | 18.10 | No signed test build for the client exists yet (Phase 8 Task 4: release APK, low-end run, handover). |

D4 and D5 are scheduled Phase 8 Task 4 work, recorded here because the line has
no proof today. D1–D3 were code gaps, now fixed on this branch.

### How to read the test column

- **Flutter** — `apps/rider/test/<file>` › "test name" (run by `flutter test`).
- **QA** — `npm run test:<name>` › group or check name (`scripts/qa/*.ts`; the data
  tiers run against in-process fakes; the HTTP contract tiers need a local dev
  server and print SKIP without one, so they are never cited as the proof).
- **PGlite** — `scripts/qa/sql/migration-00xx.mjs` › assertion (in-process Postgres).

Paths: `lib/` = `apps/rider/lib/`; `api/` = `src/app/api/`; `da/` =
`src/lib/data-access/`; migrations are in `supabase/migrations/`.

---

## 1. Rider Dashboard

Home: `lib/features/home/home_screen.dart` (route `/home`), tiles in
`lib/features/home/dashboard_grid.dart`; `GET api/rider/dashboard` →
`getRiderDashboard` (`da/rider-insights.ts`), counting rules in
`src/lib/rider/figures.ts`.

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 1.1 | Today's total deliveries | `CountTile` `tile-deliveries` (accepted today, IST) | Flutter `dashboard_test.dart` › "all twelve are there with the servers values"; QA `test:rider-insights` › "data: the dashboard's twelve figures, from the same rules as History and Performance", "a delivery accepted at 23:58 IST and delivered at 00:10 is yesterday's delivery and today's completion" | Delivered |
| 1.2 | Pending deliveries | `tile-pending` = offers held for the rider now | Flutter same test; QA `test:rider-insights` › "data: Pending is what Jobs lists - upcoming pickups with no window, ready offers inside it - and nothing while offline" | Delivered |
| 1.3 | Accepted deliveries | `tile-accepted` | Flutter "all twelve are there…"; QA "data: the dashboard's twelve figures…" | Delivered |
| 1.4 | Picked-up orders | `tile-picked-up` | same | Delivered |
| 1.5 | Completed deliveries | `tile-completed` (delivered today) | same | Delivered |
| 1.6 | Cancelled deliveries | `tile-cancelled` (cancelled + failed + reassigned away, failed shown apart) | Flutter "all twelve…", "deliveries, completed and cancelled go to History, filtered"; QA › "cancelled counts today's accepted stints that ended cancelled, failed or reassigned away; failed is shown apart" | Delivered |
| 1.7 | Today's earnings | `MoneyRow` `tile-earnings-today` (ledger, salary caption, ruling P4-R-APP2) | Flutter "all twelve…", "the money says what the Earnings tab says"; QA `test:rider-earnings` › "summary: a salaried rider's period figures are the signed sum of every non-reversed ledger entry" | Delivered |
| 1.8 | Total earnings | `tile-earnings-total` | same | Delivered |
| 1.9 | Pending payments | `tile-earnings-pending` (negative = rider owes) | Flutter "owing says it comes off the next payout", "money owed shows as a minus"; QA `test:rider-earnings` › "summary: pending can be negative…" | Delivered |
| 1.10 | Online / offline status | `AvailabilityCard` (`lib/features/home/availability_card.dart`) | Flutter `shell_test.dart` › "offline rider: offline card, Offline chip, no break button", "with a recent fix the chip says Online, and time online shows" | Delivered |
| 1.11 | Current delivery status | `CurrentDeliveryCard` (`lib/features/home/current_delivery_card.dart`), `current {status,next}` in the dashboard JSON | Flutter `dashboard_test.dart` › "the current delivery opens Jobs"; QA `test:rider-insights` › "the delivery status and the next step" | Delivered |
| 1.12 | Incentives earned | `IncentivesCard` — incentives earned this week and the nearest target's progress | Flutter "all twelve…"; QA `test:rider-insights` › "nearest target: fewest deliveries to go among rules not yet earned" | Delivered |
| 1.— | All figures update automatically | 15 s poll while Home shows, on resume, after any action (`dashboardPollEvery`) | Flutter `dashboard_test.dart` › "asks again every 15 seconds while Home shows", "are asked for again the moment Home comes back", "a phone whose app is not in front does not poll" | Delivered |

## 2. Online / Offline Availability

`lib/features/home/availability_card.dart`, `availability_actions.dart`,
`lib/state/availability.dart`; `POST api/rider/status` → `setRiderAvailability`
(`da/rider-status.ts`), rules `src/lib/rider/availability.ts`; tables
`rider_status`, `rider_shifts` (0081).

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 2.1 | Switch online / offline | Availability card switch → `RiderRepository.setStatus` → `api/rider/status` | Flutter `shell_test.dart` › "going online calls setStatus(online) and shows \"Waiting for location\" (no fix yet)", "going offline calls setStatus(offline)"; QA `test:rider-availability` › "online from offline opens a shift…", "offline closes the shift…"; QA `test:rider-status` › "online opens one shift; online again opens none" | Delivered |
| 2.2 | Only online riders get new assignments | `eligibleCandidates` (`src/lib/dispatch/eligibility.ts`), `chooseRider` (`src/lib/dispatch/rider-dispatch.ts`); accept refused `not_online` (`acceptOffer`, `da/rider-jobs.ts`) | QA `test:rider-dispatch` › "only the online rider with a fresh fix is offered the order (offline, no row, stale, on break are not)"; `test:rider-eligibility` › "an offline rider is excluded"; `test:rider-jobs` › "accept: a rider who is offline (or has never been online) gets not_online and nothing is written" | Delivered |
| 2.3 | Show current availability status | Phase chip (offline / online / waiting for location / on break) on the card | Flutter `shell_test.dart` › "offline rider: offline card, Offline chip, no break button", "break 30 sends minutes 30 and shows \"On break until\""; QA `test:rider-availability` › "riderPhase" | Delivered |
| 2.4 | No going offline during an active delivery without an authorised exception | Server refuses `active_delivery` (`nextAvailability`); `go_offline` exception, ops approval releases the job (`raiseException`/`decideException`, `da/delivery-exceptions.ts`; 0082 `delivery_exceptions`; ruling P2-R9) | QA `test:rider-availability` › "offline with a commitment is refused: active_delivery"; `test:delivery-exceptions` › "state gates: go_offline only before pickup…", "approve go_offline on an active job: released (correction, unique reason)…"; Flutter `shell_test.dart` › "409 active_delivery: the snackbar says to finish the order, the switch stays on"; `active_delivery_test.dart` › "go offline / hand back only before the pickup" | Delivered |
| 2.5 | Offline automatically after logout | App calls `POST api/rider/signout` → `forceRiderOffline(…, "logout")` before ending the session; web `/auth/signout` does the same | Flutter `shell_test.dart` › "signs out: offline hand-off first, then the session ends and /login shows", "a failing offline hand-off (503) still signs out"; `auth_test.dart` › "signoutOffline posts to /api/rider/signout"; QA `test:rider-status` › "forceRiderOffline ends the shift with its reason and never creates a row" | Delivered |
| 2.6 | Temporary breaks and availability controls | Break 15 / 30 / 60 min or until resumed; Resume; a break hides the rider from dispatch (`rider_status.break_until`) | Flutter `shell_test.dart` › "break 30 sends minutes 30…", "break until I resume sends minutes null and never shows a date (R4)", "Resume ends the break"; QA `test:rider-availability` › "break 15 / 30 / 60 end that many minutes from now"; `test:rider-eligibility` › "an online rider on a timed break is excluded; once the break ends, included" | Delivered |
| 2.7 | Notify riders when demand is high | `alertHighDemand` (`da/rider-alerts.ts`) from the dispatch sweep, thresholds in Admin → Settings → Riders, `notifyRidersHighDemand` (category `high_demand`) | QA `test:support` › "high demand: 4 waiting, 1 idle -> offline riders seen in 14 days, at most once per 30 min", "alert rules at their thresholds" | Delivered |

## 3. New Delivery Requests

Jobs tab `lib/features/jobs/jobs_screen.dart` (route `/jobs`), card
`lib/features/jobs/offer_card.dart`; `GET api/rider/board` → `getRiderBoard`
(`da/rider-jobs.ts`).

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 3.1 | Order ID | Order code on the card | Flutter `jobs_screen_test.dart` › "shows the shop, both lines, instructions, figures, cash and who holds it" (`DL-4821`) | Delivered |
| 3.2 | Pickup location and vendor name | Shop name + PICKUP line | same (shop name) | Delivered |
| 3.3 | Pickup address | `_StopLine` PICKUP | same (`Main Road, Bemetara`) | Delivered |
| 3.4 | Drop location | `_StopLine` DROP | same (`Ward 7, near the water tank`) | Delivered |
| 3.5 | Approximate distance | Shop→drop and rider→shop km (road distance after accept, ×1.3 estimate before) | same (`2.6 km`, `0.8 km`); QA `test:rider-offers` › "roadKmFallback is straight line x 1.3 to 2 dp"; `test:rider-jobs` › "accept: the estimate is stored at once ('estimate'), then upgraded to the routed distance ('road')…" | Delivered |
| 3.6 | Estimated delivery time | `ETA n min` fact (rider→shop + prep + shop→customer) | Flutter same test (`16 min`); QA `test:eta` | Delivered |
| 3.7 | Delivery fee or estimated earning | Owner override (P3-R11, P3-R10): salaried riders, offers show no estimate; `estimatedEarning` always null on the board | Flutter `jobs_screen_test.dart` › "no estimated earning is ever shown: riders are on a salary"; QA `test:rider-jobs` › "board: estimatedEarning is always null (salaried fleet), rate card or not" | Delivered with owner override |
| 3.8 | Payment collection requirement | Cash pill: Collect ₹ / Prepaid / Payment not confirmed | Flutter "shows the shop…" (`Collect ₹485`), "a prepaid order says Prepaid; an unconfirmed one does not demand cash" | Delivered |
| 3.9 | Special delivery instructions | Instructions box (customer's courier note, ruling P2-R7) | Flutter "shows the shop…" (`Ring the bell twice`); QA `test:order-instructions` | Delivered |
| 3.10 | Accept / Reject buttons | `POST api/rider/offers/[orderId]/accept` → `acceptOffer`; `…/reject` → `rejectOffer`, reason sheet `lib/features/jobs/reject_sheet.dart` | Flutter `jobs_screen_test.dart` › "calls accept, then the next board shows the active delivery", "sends the reason and the card goes", "Send stays disabled until a reason is chosen"; QA `test:rider-jobs` › "accept an offer held for me…", "reject by the offeree: rejected event with reason and position…" | Delivered |
| 3.— | Response countdown | `CountdownRing` (`lib/features/jobs/countdown_ring.dart`), window `rider_offer_window_seconds` (admin), server clock offset | Flutter › "shows 2:59, runs down, and at 0:00 the card opens to everyone", "a phone clock 3 minutes fast still shows 2:59 for a fresh offer"; QA `test:rider-offers` › "offerDeadline is offeredAt + the window (not a constant)" | Delivered |
| 3.— | Rejected or unanswered requests return to dispatch | Reject re-offers at once excluding the rider; the sweep re-offers lapsed offers (`redispatchOrders`, `src/lib/dispatch/sweep.ts`) | QA `test:rider-jobs` › "reject: re-offer excludes every prior rejecter and lapser…", "sweep: a lapsed offer writes a lapsed event for the rider who let it lapse and re-offers to someone else"; `test:rider-offers` › "redispatchTargets: a lapsed offer on a ready order is re-offered, naming who let it lapse" | Delivered |

## 4. Delivery Management

Active delivery: `lib/features/delivery/active_delivery_screen.dart` (shown in
`/jobs` while a delivery is active), status strip `step_tracker.dart`, timeline
`timeline.dart`; `POST api/rider/deliveries/[orderId]/action` →
`performDeliveryAction` (`da/rider-delivery-actions.ts`), rules
`src/lib/rider/delivery-machine.ts`; schema 0081 (stamps, `failed`,
`guard_delivery_transition`, `delivery_events`), 0082.

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 4.S1 | Status: Assigned | Offer held for the rider (`unassigned` + `offered_driver_id`), step tracker "Assigned" | Flutter `active_delivery_test.dart` › "the step tracker lists all nine statuses and marks the current one"; PGlite `migration-0081.mjs` › "an offer logs offered against the offered rider" | Delivered |
| 4.S2 | Accepted | `assigned` | Flutter same; PGlite `0081` › "unassigned -> assigned" | Delivered |
| 4.S3 | Arrived at pickup | `arrived_pickup_at` (set once) | Flutter same + "arrive at the shop: a fresh v4 UUID and the latest fix"; PGlite `0081` › "first arrived_pickup_at", "second arrived_pickup_at is refused" | Delivered |
| 4.S4 | Order picked up | `picked_up` + `picked_up_at` + method | Flutter "each status has its one primary action"; PGlite `0081` › "assigned -> picked_up (no stamp sent)", "picked_up event carries the method and the rider" | Delivered |
| 4.S5 | On the way | `departed_pickup_at` (Start trip) | Flutter "start the trip, then arrive at the customer"; QA `test:rider-jobs` › "board: the active delivery's status is derived from the stamps (accepted -> arrived_pickup -> picked_up -> on_the_way -> arrived_drop)" | Delivered |
| 4.S6 | Arrived at customer location | `arrived_drop_at` (+ customer "rider has arrived" push) | Flutter "start the trip, then arrive at the customer"; QA `test:rider-delivery` › "full flow: arrive -> pickup by code -> start trip -> arrive at the door -> deliver by code" | Delivered |
| 4.S7 | Delivered | `delivered` + `delivered_at` + method | QA `test:rider-delivery` › "full flow…"; PGlite `0081` › "picked_up -> delivered (no stamp sent)" | Delivered |
| 4.S8 | Failed delivery | `failed` + `failure_reason`, only through an approved exception | QA `test:delivery-exceptions` › "approve ${kind}: the delivery fails (kind + reason) and the order is cancelled by the deciding role"; PGlite `0081` › "picked_up -> failed without a reason is refused"; `0082` › "an approved failed_delivery lets a picked-up delivery fail" | Delivered |
| 4.S9 | Cancelled / reassigned, where authorised | `cancelled`; `reassigned`/`released` events when ops release a job | Flutter "a terminal status says what happened"; QA `test:rider-insights` › "reassigned-away outcome: the rider who LOST the job, not the one who took it"; PGlite `0081` › "driver A -> B", "...writes reassigned"; `0082` › "a delivered job cannot be released, even as a correction" | Delivered |
| 4.1 | Order ID | Card header code | Flutter `active_delivery_test.dart` › "the card: code, shop and drop with calls, instructions, items, cash, distance" | Delivered |
| 4.2 | Vendor details | Shop name, address, call-shop button | same | Delivered |
| 4.3 | Customer delivery details | Customer name and drop address | same (`Anita Verma`, drop line) | Delivered |
| 4.4 | Order quantity or package count | Item lines with quantities | same (`Paneer butter masala`, `× 4`) | Delivered |
| 4.5 | Pickup and drop-off addresses | Both stop lines | same | Delivered |
| 4.6 | Contact options | `call-shop`, `call-customer` (logged via `POST api/rider/deliveries/[orderId]/contact` → `logContactAttempt`) | Flutter same + "a call is placed even when logging it fails"; QA `test:rider-delivery` › "contact attempt: a contact_attempt event naming whom; only the rider holding the job" | Delivered |
| 4.7 | Delivery instructions | Instructions box, highlighted when the customer changed them | Flutter same + "instructions the customer changed are highlighted" | Delivered |
| 4.8 | Payment collection amount | Cash pill | Flutter same (`Collect ₹485`) | Delivered |
| 4.9 | Status history | Timeline sheet from `delivery_events` | Flutter "the timeline sheet lists the delivery events"; QA `test:rider-jobs` › "board: timeline and exceptions are read for the delivery" | Delivered |
| 4.10 | Delivery time and distance | Distance + ETA strip while heading to a stop (`_etaText`), routed or "approx." | Flutter `active_delivery_test.dart` › "a routed ETA from the routing server is not approx.", "no routing server: a straight line and an ETA marked approx." | Delivered |
| 4.— | No "delivered" before pickup, except an authorised admin correction | `guard_delivery_transition` (0081, re-declared 0082): delivered needs `old.status = picked_up`; corrections need `correction_reason` and are logged | PGlite `0081` › "assigned -> delivered is refused", "...the same with correction_reason succeeds", "service_role assigned -> delivered is refused"; `0082` › "assigned -> delivered is refused even with picked_up_at set"; QA `test:rider-delivery` › "deliver from assigned -> bad_state; pickup legs from picked_up -> bad_state" | Delivered |

## 5. Navigation & Location Tracking

Navigation `lib/core/navigation_launcher.dart`, map `lib/features/delivery/route_map.dart`,
routing `lib/core/routing.dart`; location `lib/core/location_service.dart`,
`POST api/rider/location` → `recordRiderFix` (`da/rider-status.ts`).

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 5.1 | Google Maps or another navigation service | Google Maps turn-by-turn intent, web fallback, any `geo:` app (Settings) | Flutter `active_delivery_test.dart` › "Google Maps turn-by-turn, then the web; other apps through geo:", "no Google Maps: the web directions" | Delivered |
| 5.2 | Navigation to the vendor | Navigate targets the shop before pickup | Flutter › "Navigate opens the shop in Google Maps by default" | Delivered |
| 5.3 | Navigation to the customer | Navigate targets the drop after pickup | Flutter › "\"Other app\" in settings: geo:" (drop coordinates, `on_the_way`), "no Google Maps: the web directions" | Delivered |
| 5.4 | Route and estimated arrival | In-app map with OSRM route line and ETA; straight line + haversine "approx." fallback | Flutter › "a routed ETA from the routing server is not approx.", "no routing server: a straight line and an ETA marked approx."; `routing_test.dart` › "parses the geometry (lng,lat pairs), distance and duration" | Delivered |
| 5.5 | Share location with dispatch during active deliveries | 10 s cadence on a delivery; the fix also moves the delivery position | Flutter `location_test.dart` › "on an active delivery: one per 10 s", "a live delivery on the board: 10 s; no delivery: back to 30 s"; QA `test:rider-status` › "a fix while online with a delivery in flight stamps presence and moves the delivery" | Delivered |
| 5.6 | Periodic updates while online, within permissions and battery | 30 s idle cadence, foreground service, heartbeat; nothing while offline | Flutter `location_test.dart` › "runs as a foreground service with the Deligro notification", "10 readings over 20 s idle: one post, the next after 30 s", "permission revoked mid-shift: reported, the service waits"; QA `test:rider-status` › "a fix while offline is acknowledged and nothing is kept" | Delivered |
| 5.7 | Recalculate the route when needed | Re-route when > 150 m off the line or every 2 min (`needsReroute`); turn-by-turn recalculation is the nav app's | Flutter `routing_test.dart` › "more than 150 m off the line", "every 2 minutes", "151 m from the line is off it; 149 m is not" | Delivered |
| 5.8 | Call customer or vendor through approved options | Direct call buttons (numbers only while the rider holds the job, `driver.call_customer` switch); number masking not contracted (spec) | Flutter `active_delivery_test.dart` › "the card: code, shop and drop with calls…"; QA `test:rider-jobs` › "board: with driver.call_customer off, neither the shop's nor the customer's number is sent" | Delivered |
| 5.9 | Stop active-delivery tracking on completion | Server answers `active:false`; service steps down to 30 s, or stops when offline | Flutter `location_test.dart` › "a finished delivery on the board counts as none", "online:false and active:false stops, even after an active answer", "an offline rider carrying an order shares at 10 s, and stops when it is over" | Delivered |
| 5.— | Location transparent, permission-based, operational only | First-run disclosure before any prompt (`lib/features/onboarding/location_disclosure_screen.dart`), re-readable from Settings; no fix kept while offline | Flutter `location_test.dart` › "says what, when, why, who and how to stop", "first time: the disclosure comes first; Not now stays offline", "needsDisclosure until the disclosure is accepted"; QA `test:rider-status` › "offline closes the shift and drops the position" | Delivered |

## 6. Pickup Verification

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 6.1 | Order details before pickup | Active delivery card at `accepted` / `arrived_pickup` | Flutter `active_delivery_test.dart` › "the card: code, shop and drop…", "the panel: code, QR, the shop can hand over, manual check" | Delivered |
| 6.2 | Confirm arrival at the vendor | Arrived button, suggested inside 150 m | Flutter › "arrive at the shop: a fresh v4 UUID and the latest fix", "inside 150 m of the stop the arrival button pulses and a banner suggests it, once" | Delivered |
| 6.3 | Pickup by OTP, QR, vendor confirmation or authorised manual check | Code entry (`code_entry.dart`); QR scan (`qr_scan_screen.dart`) of the code the vendor board renders (`PickupQr`, `src/components/vendor/vendor-orders-board.tsx`); vendor "Handed to rider" `POST api/vendor/orders/[id]/handover` → `vendorConfirmHandover`; manual via an approved `manual_pickup` exception | Flutter › "a wrong code: the error, and the boxes clear; the right one picks up", "a scanned QR fills the code and submits it with method qr", "Request manual check raises manual_pickup with the reason chosen"; QA `test:rider-delivery` › "codes: wrong pickup code -> bad_pickup_otp…, QR checks the same code", "vendor handover: picked_up by 'vendor', order on_the_way, customer and rider told; a second tap is ok", "manual pickup: refused without an approved manual_pickup, accepted with one" | Delivered |
| 6.4 | Record pickup date and time | `picked_up_at` stamped by the guard, `picked_up` event with method | PGlite `0081` › "picked_up_at and delivered_at stamped by the guard", "picked_up event carries the method and the rider" | Delivered |
| 6.5 | Report missing items, wrong package, vendor delay | Issue sheets (`issue_sheets.dart`) → `POST api/rider/exceptions`; reports file a linked high-priority ticket, vendor delay notes the timeline (P2-R11, `fileTicketForPickupReport`) | Flutter › "go offline / hand back only before the pickup" (lists `missing_items`, `wrong_package`, `vendor_delay`); QA `test:support` › "P2-R11: a shop-delay report files a linked high ticket and notes the timeline", "P2-R11: a missing-items report files a ticket without a note…"; `test:delivery-exceptions` › "reports: while the rider holds the job…" | Delivered |
| 6.6 | No accidental duplicate pickup | Conditional update + client action id (unique on `delivery_events`) | Flutter › "two taps in one frame send one step"; QA `test:rider-delivery` › "replay of each stamp step -> duplicate:true without a write", "23505 on client_action_id…"; PGlite `0081` › "replaying X with another stamp raises 23505" | Delivered |

## 7. Delivery Verification

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 7.1 | Confirm arrival at the customer | Arrived button at the drop, 150 m suggestion | Flutter `active_delivery_test.dart` › "start the trip, then arrive at the customer" | Delivered |
| 7.2 | Customer OTP | Delivery code, rate-limited guesses | Flutter › "a wrong delivery code says so"; QA `test:rider-delivery` › "codes: wrong pickup code -> bad_pickup_otp, wrong delivery code -> bad_otp…", "checksCode: the code-guess bucket is decided on the normalised method (null = code)" | Delivered |
| 7.3 | Proof of delivery where required | Proof photo (`proof_photo.dart`) → `POST api/rider/deliveries/[orderId]/proof` → `uploadDeliveryProof`; admin `pod_photo_rule` never / COD / always / exceptions | Flutter › "a photo-required delivery blocks the code until a photo is attached"; QA `test:rider-delivery` › "podPhotoRequired truth table: 4 rules x cod/prepaid x via exception", "proof upload: type, size, magic bytes, owner, state" | Delivered |
| 7.4 | Record delivery date and time | `delivered_at` + `delivered` event with method | PGlite `0081` › "picked_up_at and delivered_at stamped by the guard", "delivered event carries its method" | Delivered |
| 7.5 | Photo only when operationally necessary, with privacy safeguards | `pod_photo_rule` (default never); private `delivery-proofs` bucket, service role only; short-lived signed URLs to the rider, ops and that order's customer (`api/orders/[id]/proof`). Retention: `purgeExpiredProofPhotos` (`da/proof-retention.ts`) run by the dispatch sweep (`src/lib/dispatch/sweep.ts`; cron `api/cron/dispatch-sweep` reports `proofPhotosRemoved`) deletes the photo 90 days after the delivery ended — `delivered_at` (also for a delivered row later corrected to cancelled; a row corrected back to assigned / picked_up is live and never purged), `failed_at` for a failed one, `picked_up_at` for one cancelled before delivery — unless an exception or ticket on the order is open; a database without the stamp column still has the path cleared (PGRST204 fallback), clears `pod_photo_path`, stamps `pod_photo_removed_at`; viewers say "Photo removed after 90 days" (`src/components/orders/proof-of-delivery.tsx`, customer app tracker). Camera hint "Photograph the package at the door — not people." (`lib/features/delivery/proof_photo.dart`). Fixed D1 | QA `test:support` › "D1: a photo delivered more than 90 days ago is deleted, its path cleared and stamped; the audit row stays", "D1: an order with an open exception or an open support ticket keeps its photo; a resolved ticket does not", "D1: at most 100 a run, oldest first; a second run finishes the rest and a third does nothing (idempotent)", "D1: a storage failure clears nothing, so the next run tries again", "D1 (I1): a database whose 0082 lacks pod_photo_removed_at: the path is still cleared, once; the customer link reads 'no photo'", "D1 (M1): failed deliveries 90 days after failed_at, delivered-then-corrected and cancelled-before-delivery ones too; recent and held ones stay", "D1 (N1): a row corrected back into the flow (assigned / picked_up) keeps its photo, whatever its old delivered_at", "D1: the customer's proof link says the photo was removed after 90 days"; PGlite `migration-0083.mjs` › "the service role clears pod_photo_path and stamps pod_photo_removed_at on a delivered row (no guard refuses it)", "...the delivery_events audit rows are kept and none is added"; Flutter `proof_photo_test.dart` › "before the photo: the button and one line saying photograph the package, not people"; customer `rider_rating_test.dart` › "a photo removed under the 90-day rule says so plainly, with no button"; QA `test:rider-delivery` › "podPhotoRequired truth table…"; PGlite `0082` › "no storage.objects policy mentions delivery-proofs (service role only)" | Delivered |
| 7.6 | Record the reason when a delivery fails | `failed_delivery` request with reason → approval sets `failed` + `failure_reason` | QA `test:delivery-exceptions` › "approve ${kind}: the delivery fails (kind + reason)…"; PGlite `0081` › "failed event carries the reason and rider" | Delivered |
| 7.7 | Report unreachable customer or wrong address | `customer_unreachable` (needs a logged call and the admin wait), `wrong_address` | Flutter › "customer unreachable waits for a call and the wait, and says which", "the unreachable wait is counted on the server clock, on a phone 3 minutes fast"; QA `test:delivery-exceptions` › "raise: customer_unreachable needs a logged call after arriving (call_first), then the wait (wait_longer + minutesLeft)" | Delivered |
| 7.8 | Authorisation for completion without standard verification | `complete_without_code` request, manager/admin approval completes as `ops_approved` | Flutter › "ops_approved refused as bad_state reads \"Ops haven't approved this yet\""; QA `test:delivery-exceptions` › "approve complete_without_code: delivered with ops_approved, COD recorded once, customer told"; PGlite `0082` › "picked_up -> delivered (ops_approved) without approval is refused" | Delivered |

## 8. Rider Earnings & Payment

Earnings tab `lib/features/earnings/earnings_screen.dart` (route `/earnings`,
sub-routes `records`, `record`, `payouts`, `incentives`, `statement`);
`api/rider/earnings/{summary,records,payouts,incentives,statement}` →
`getEarningsSummary`, `listEarningRecords`, `listPayouts`,
`getIncentiveProgress`, `getStatement` (`da/rider-earnings.ts`); ledger 0083.
Under ruling P3-R11 the per-delivery rate card is dormant at ₹0.

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 8.1 | Today's earnings | Hero, period Today | Flutter `earnings_test.dart` › "every figure renders with its rupees", "the period switch moves between today, week, month and total" | Delivered |
| 8.2 | Weekly earnings | Period This week | Flutter › "the period switch moves…" | Delivered |
| 8.3 | Monthly earnings | Period This month | same | Delivered |
| 8.4 | Total earnings | Period All time | same; QA `test:rider-earnings` › "summary: a salaried rider's period figures are the signed sum of every non-reversed ledger entry" | Delivered |
| 8.5 | Earnings per delivery | Tile reads "Salaried — not paid per delivery" (P3-R11) | Flutter › "every figure renders with its rupees" (`tile-average`); QA `test:rider-earnings` › "salary model: a ₹0 delivery is not pay (isZeroDelivery) and a ₹0 ledger has no per-delivery average" | Delivered with owner override |
| 8.6 | Delivery incentives | `tile-incentives` | Flutter › "every figure renders…"; PGlite `0083` › "2nd delivery: the target-2 rule awards ₹50, the target-3 rule does not" | Delivered |
| 8.7 | Bonuses | `tile-bonuses` (admin `rider_adjustments` kind bonus) | Flutter › "every figure renders…"; QA `test:admin-riders` › "parseAdjustment: a bonus" | Delivered |
| 8.8 | Approved adjustments | `tile-adjustments` | Flutter › "every figure renders…"; QA `test:admin-riders` › "insertAdjustment: created_by is the admin, the amount is stored as parsed" | Delivered |
| 8.9 | Deductions | `tile-deductions` | Flutter › "every figure renders…"; QA `test:admin-riders` › "parseAdjustment: a deduction is stored positive…" | Delivered |
| 8.10 | Amount already paid | `tile-paid` (sum of payouts) | Flutter › "every figure renders…"; PGlite `0083` › "payout … reconciles: amount = attached earnings + awards + adjustments" | Delivered |
| 8.11 | Pending payout | `tile-pending` (can be negative) | Flutter › "a negative pending shows −₹120 in the deal colour and says what it means"; QA `test:rider-earnings` › "summary: pending can be negative…" | Delivered |
| 8.12 | Payout history | Payouts screen (`payouts_screen.dart`) | Flutter › "lists amount, method, reference, dates and how many records each settled", "no payouts yet"; QA `test:rider-earnings` › "data: payouts — newest first, with the number of rows each settled" | Delivered |
| 8.R1 | Record: order ID | Record detail (`record_detail_screen.dart`) | Flutter › "a paid delivery shows every field" | Delivered |
| 8.R2 | Record: delivery date | same | same | Delivered |
| 8.R3 | Record: base delivery fee | Shown on per-delivery records; salaried fleet has none (₹0 rows hidden as money, P3-R11) | Flutter › "a paid delivery shows every field" (Base fee); "a range of only ₹0 deliveries reads as empty" | Delivered with owner override |
| 8.R4 | Record: distance or other component | Distance + source (road / estimated), distance fee | Flutter › "a paid delivery shows every field", "an estimated distance says \"(estimated)\"" | Delivered with owner override |
| 8.R5 | Record: incentive or bonus | Incentive line on the record | Flutter › "a paid delivery shows every field"; QA `test:rider-earnings` › "records: award and deduction on the delivery record, every kind listed once" | Delivered |
| 8.R6 | Record: deductions | Deduction line | same | Delivered |
| 8.R7 | Record: final earning | Final amount | same | Delivered with owner override |
| 8.R8 | Record: payment status | Paid / pending chip | Flutter › "asks for the last 31 days and lists order code, date, amount and a paid/pending chip", "a pending record has no settlement fields" | Delivered |
| 8.R9 | Record: settlement date and reference | Settled on, Reference | Flutter › "a paid delivery shows every field" | Delivered |
| 8.S | Date-wise statement, view or download | Statement screen + PDF and CSV via the share sheet (`statement_screen.dart`, `lib/core/statement_export.dart`) | Flutter `earnings_test.dart` › "opens on this month and shows the rider, the range, the four totals and the rows", "Save PDF hands a PDF named for the rider and range to the share sheet", "Share CSV hands the CSV with the same name"; `statement_export_test.dart` › "bytes are a PDF and name the rider ID and range"; QA `test:rider-earnings` › "statement: earned counts every ledger entry and opening + earned − paid = closing for a salaried rider" | Delivered |

Row 8.R3/8.R4/8.R7 are marked as override because under the salary model these
per-delivery components are ₹0 and are not shown as money lines; the fields
exist and render whenever a record carries real money.

## 9. Incentives & Performance

Performance `lib/features/performance/performance_screen.dart` (route
`/more/performance`), incentives `lib/features/earnings/incentives_screen.dart`;
`GET api/rider/performance` → `getRiderPerformance`, `api/rider/ratings` →
`getRiderRatings` (`da/rider-insights.ts`); rules 0083, ratings/targets 0084.

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 9.1 | Daily delivery targets | Daily ring (admin default, else largest active rule) | Flutter `performance_test.dart` › "targets, times, rates and hours" (`ring-daily`); QA `test:rider-insights` › "targets: the admin's default, else the largest active rule, else none" | Delivered |
| 9.2 | Weekly delivery targets | Weekly ring | Flutter same (`ring-weekly`) | Delivered |
| 9.3 | Incentive rules and eligibility | Each rule in plain words: target, bonus, window, dates | Flutter `earnings_test.dart` › "shows the rule in plain words, the bar at 7 of 10, the window and the end date", "a weekly rule says this week; no window says all day; no end date says so" | Delivered |
| 9.4 | Bonus progress | Progress bar, Earned badge | Flutter › "an earned rule carries the Earned badge and a full bar", "progress never overshoots when more than the target is done"; QA `test:rider-earnings` › "incentive progress: today's and this week's counts, window, earned, rule dates" | Delivered |
| 9.5 | Completed deliveries against target | Rings "n of target" | Flutter `performance_test.dart` › "targets, times, rates and hours" | Delivered |
| 9.6 | Average delivery time | Accepted→delivered and picked up→delivered | same; QA `test:rider-insights` › "average times: delivered only, accepted -> delivered and picked up -> delivered" | Delivered |
| 9.7 | Acceptance rate | accepted ÷ offers | same; QA › "rates: zero denominators are null, never 0 % or 100 %" | Delivered |
| 9.8 | Failed delivery rate | failed ÷ finished | same | Delivered |
| 9.9 | Customer feedback and ratings | Rating card (average, count, comments without names); customers rate on web (`src/components/orders/rider-rating-card.tsx`) and the customer app; `api/orders/[id]/rider-rating` → `submitRiderRating` | Flutter `performance_test.dart` › "average, count and recent comments without names"; QA `test:rider-rating` › "data: a customer rates their own delivered order once"; `test:rider-insights` › "data: ratings - average, count, 20 a page by keyset, no customer, only this rider's"; customer Flutter `apps/customer/test/rider_rating_test.dart` › "the tracker shows the rider card on a delivered order that has a rider, apart from the food rating" | Delivered |
| 9.10 | Historical performance reports | 12-month chart and table | Flutter › "the chart draws one bar for each of the 12 months, oldest first", "the table has a row per month, newest first"; QA `test:rider-insights` › "months: the last twelve, newest first, across a year boundary" | Delivered |
| 9.— | Incentive calculations transparent and consistent with the rules | Rules shown verbatim; awards written by the 0083 trigger from the rule in force, unique per (rule, rider, period) | PGlite `0083` › "3rd delivery: the target-3 rule awards ₹100 once, triggered by the third", "a second award for (rule, rider, period) is refused by the unique key…", "14:59 IST: the second inside the window awards ₹70, counting 2" | Delivered |

## 10. Cash Collection & Reconciliation

Cash `lib/features/cash/cash_screen.dart` (route `/more/cash`, `collections`),
`deposit_sheet.dart`, `dispute_sheet.dart`; `api/rider/cash/{summary,collections,deposits,deposits/[id],disputes,managers}`
→ `getRiderCashSummary`, `listRiderCollections`, `submitDeposit`,
`withdrawDeposit`, `raiseCashDispute`, `listDepositManagers` (`da/rider-cash.ts`);
0085; manager side `/manager/cash`.

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 10.1 | Cash to collect | `tile-to-collect` | Flutter `cash_test.dart` › "shows every figure and says it is not earnings"; QA `test:rider-cash` › "data: the position — COD collected, handed over, awaiting, to collect…" | Delivered |
| 10.2 | Cash collected today | `tile-collected-today` | same; QA › "the IST day cut: 00:15 IST belongs to the new day, 23:45 IST to the old" | Delivered |
| 10.3 | Cash deposited | `tile-deposited-today`, deposits list | same; QA › "the summary: collected − confirmed handovers; today by IST day; submitted is shown, not subtracted" | Delivered |
| 10.4 | Cash pending deposit | `cash-pending` | same | Delivered |
| 10.5 | Order-wise collection history | Collections screen | Flutter › "cash beside paid-online orders, filterable", "a new date range asks again"; QA › "data: collections list cash and 'paid online' apart, newest first, paged, in an IST range" | Delivered |
| 10.6 | Digital payment confirmation | "Paid online" rows apart from cash | Flutter › "cash beside paid-online orders, filterable" | Delivered |
| 10.7 | Deposit submission details | Deposit sheet: amount, manager, cash/UPI, reference, receipt photo | Flutter › "a manager and a receipt photo travel with the deposit", "UPI without a reference blocks the send"; QA › "data: declaring a deposit — exceeds_pending shows the held cash…", "data: confirming (ops_decide_cash_deposit) writes the ONE cod_handovers row…" | Delivered |
| 10.8 | Reconciliation status | Per-day Settled / Pending / Disputed chips (rulings P5-R1, P5-R2) | Flutter › "days carry their status chip; a disputed day shows the note"; QA › "day statuses across three days with a LATE deposit…" | Delivered |
| 10.9 | Dispute reporting for incorrect amounts | Report a day's figure → cash dispute + linked `cash_reconciliation` support ticket (`cash_dispute_id`) + ops alert; resolving it closes the ticket and tells the rider (`cash`, `/more/cash`) | Flutter › "a day's figure can be reported; the message is required", "a second report for the same day is explained"; QA › "data: raising a dispute — a real day within 90 days, a message, an optional whole-rupee claim, one open per day", "I-5: raising a dispute files a cash_reconciliation ticket linked to it and alerts every manager and admin", "I-5: resolving a dispute tells the rider…" | Delivered |
| 10.— | Earnings kept apart from cash collected | Cash screen "not part of your earnings"; Earnings never shows cash | Flutter `cash_test.dart` › "shows every figure and says it is not earnings", "Home shows \"Cash in hand\" labelled Not your earnings"; `earnings_test.dart` › "earnings are never mixed with cash collected" | Delivered |

## 11. Notifications

Pushes `src/lib/notifications/order-events.ts` → `notifyRider`
(`src/lib/notifications/notify-user.ts`: push + `user_notifications` inbox row,
category preferences honoured); app inbox `lib/features/notifications/notifications_screen.dart`
(route `/notifications`), `GET api/rider/notifications` → `getInbox`; push taps
`lib/core/push_routes.dart`; ring `lib/core/ring.dart` + native RingService.

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 11.1 | New delivery assignments | Offer ring `notifyDriverPickupReady` (held) / heads-up from dispatch; `notifyDriverAssigned` on a manager assignment | QA `test:ring` › "the offer held for the rider rings held: true", "the ring and its ttl follow rider_offer_window_seconds"; Flutter `ring_test.dart` › "starts once under the server's ring id, for the time left" | Delivered |
| 11.2 | Assignment cancellations or reassignment | Cancel: `cancelDeliveryForOrder` (`src/lib/dispatch/rider-dispatch.ts`) → `notifyDriverOrderCancelled` (ring stopped, `cancellations` push + inbox); hand-assignment by a manager or admin: `assignRider` (`src/app/manager/actions.ts`) → `notifyOffereeOfHandAssignment` (offeree's ring stopped; told "Order given to another rider" when it went to someone else); release: `notifyDriverExceptionDecided`; an offer taken by another rider: ring stopped. Fixed D2 | QA `test:support` › "D2: a hand-assignment to another rider stops the offeree's ring and tells them (inbox + push, cancellations)", "D2: hand-assigning the offered rider only stops their offer ring; no offer out tells nobody", "D2: cancelling an order the rider carries cancels the delivery, stops their ring and pushes the cancellation", "D2: cancelling an order with a live offer removes the offer and tells the offered rider", "D2: a manager's hand-assignment reads the offeree before the claim and tells them after it"; `test:rider-jobs` › "accept: the previous offeree's ring is stopped when a different rider takes the order (and only then)" | Delivered |
| 11.3 | Pickup reminders | `remindPickups` (`da/rider-alerts.ts`) from the sweep | QA `test:support` › "pickup reminder: ready 15 min, rider not arrived -> one push, once" | Delivered |
| 11.4 | Customer location and delivery instructions | Instructions changed by the customer → `notifyRiderInstructionsChanged` + timeline note (`updateOrderInstructions`); the drop address cannot change after ordering (no address-edit route) | QA `test:support` › "Review Focus 3: instructions changed while the rider carries the order -> delivery_updates push + timeline note"; Flutter `active_delivery_test.dart` › "instructions the customer changed are highlighted" | Delivered |
| 11.5 | Delivery delays | `alertDelays` → rider and ops | QA `test:support` › "delay alert: picked up 40 min ago, past its ETA -> rider and ops told, once" | Delivered |
| 11.6 | Payout completed | `recordPayoutAction` (`src/app/admin/riders/[id]/money-actions.ts`) → after the payout commits, `deferNotify(announcePayoutRecorded)` (`da/admin-riders.ts`) reads the settled row back and calls `notifyRiderPayoutRecorded` ("Payout recorded: ₹X for work up to <day>", category `payouts`, url `/earnings/payouts`) through `notifyRider` (inbox + push, switch honoured); a failure never fails the payout. Fixed D3 | QA `test:support` › "D3: a recorded payout tells the rider - inbox row and push, the settled amount and the period it covers", "D3: with the rider's payouts switch off the payout is in the inbox, not pushed", "D3: an unreadable payout or a failing notifier never throws (the payout stands)", "D3: recording a payout announces it to the rider, after the payout committed, without blocking the action" | Delivered |
| 11.7 | Incentives earned | `notifyNewIncentiveAwards` inside `completeDelivery` (P3-R1), at-most-once (P3-R9) | QA `test:rider-earnings` › "data: notifyNewIncentiveAwards pushes each new award once, then never again" | Delivered |
| 11.8 | New announcements | `announcements` (0087), admin composer, publish fan-out and scheduled-start sweep (P7-R2); app pins live ones in the inbox | QA `test:support` › "announcements: a rider gets live rider + all; publishing to riders fans out once per rider", "fix 2: a scheduled announcement is pushed once after it starts; not before; never once ended"; Flutter `help_test.dart` › "groups by day, shows unread dots, pins live announcements and hides ended ones" | Delivered |
| 11.9 | Support ticket updates | Staff reply / status change pushes the rider | QA `test:support` › "staff replies and status changes push the rider (support); internal notes do not"; Flutter `help_test.dart` › "a ticket notification opens that ticket under Help" | Delivered |
| 11.10 | Required cash reconciliation | `sendCashReminders` from the sweep (over limit / held too long) | QA `test:rider-cash` › "data: reminders — over the limit or held too long, at most once in 6 hours, claimed atomically", "data: reminders respect the thresholds…" | Delivered |
| 11.— | Push and in-app notifications | Every rider push also writes an inbox row; inbox with unread badge | QA `test:support` › "notifyUsers: one insert, one push for everyone not muted", "inbox: own rows newest first, paged, unread count, mark read"; Flutter `help_test.dart` › "Mark all read clears the dots and the bell, and tells the server", "the bell and the More row show the count, 99+ when large" | Delivered |
| 11.— | Audible alerts for new assignments | Native ring (alarm stream, looped), sound/vibration switches; an offer held for the rider always rings | Flutter `ring_test.dart` › "an offer held for this rider rings even with both switches off", "the manifest declares the service, the extension and the permissions a ring needs", "the ring sound exists"; QA `test:ring` › "service plays on the alarm stream", "service loops the sound" | Delivered |

## 12. Rider Profile & Documents

Profile `lib/features/profile/profile_screen.dart` (route `/more/profile`,
`documents`, `documents/upload/:type`, `documents/view/:id`); `api/rider/profile`,
`api/rider/profile/change-requests`, `api/rider/documents`, `api/rider/documents/[id]/url`
→ `getRiderProfile`, `updateRiderProfileDirect`, `requestProfileChange`,
`uploadRiderDocument`, `riderDocumentUrl` (`da/rider-profile.ts`),
`da/rider-payout-accounts.ts` (server-only); 0081 (rider ID), 0086.

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 12.1 | Name and profile photo | Name edit (request once verified), photo upload | Flutter `profile_test.dart` › "a verified rider's name goes as a request: \"Send for approval\", then waits", "I3a: a new profile photo uploads and refreshes even when the page was left meanwhile"; QA `test:rider-profile` › "pure: profile patch — validated, not cast; non-ASCII intact (Review Focus 5)" | Delivered |
| 12.2 | Registered mobile number | Phone shown; change by OTP to the new number | Flutter › "the phone change sends a code to the NEW number, then the code with it", "a wrong code is explained and the sheet stays" | Delivered |
| 12.3 | Rider ID | `DR-0001` style ID (`rider_profiles.rider_code`, 0081 sequence) on Home, Profile and statements | Flutter `shell_test.dart` › "shows the rider name and rider ID"; `profile_test.dart` › "shows the rider ID, the licence in full and the account only masked"; PGlite `0081` › "first-registered driver is DR-0001", "a new driver gets DR-0003" | Delivered |
| 12.4 | Address | Address sheet, saves directly | Flutter › "the address saves directly, blank fields clear, and says Address saved", "a pincode with 5 digits is refused on the phone" | Delivered |
| 12.5 | Vehicle type | Vehicle request (type, owner, registration) | Flutter › "the vehicle request carries type, owner and a tidy registration" | Delivered |
| 12.6 | Vehicle registration | same | same; QA `test:rider-profile` › "pure: change requests — every field's shape" | Delivered |
| 12.7 | Driving licence | Licence number + expiry (request) and document | Flutter › "the licence request needs a real number and a date that has not passed", "a licence upload needs its number and expiry date" | Delivered |
| 12.8 | Identity and onboarding documents | Aadhaar, PAN, licence, RC, insurance, PUC, photo; required set by vehicle owner; private `rider-documents` bucket | Flutter › "lists the required documents with status chips, masked numbers and expiry", "on their own vehicle the rider is asked for RC, insurance and PUC too"; QA `test:rider-profile` › "data: a valid upload — path built by the server, Aadhaar masked before it leaves", "pure: documents complete — the matrix by vehicle owner" | Delivered |
| 12.9 | Document verification status | Status chips, verification card, admin review (`/admin/riders/[id]`) | Flutter › "the verification card says what is wrong in plain words", "the verification badge reads each state"; QA `test:admin-rider-profile` › "data: document review writes what ops_review_rider_document writes, pending only" | Delivered |
| 12.10 | Document expiry reminders | Daily cron `api/cron/rider-documents` → `sendDocumentExpiryReminders` (30 / 7 / 1 days); amber / red in the app. **Owner step:** that cron route must be scheduled (Vercel Cron, `pg_cron` + `pg_net` or any pinger, Bearer `CRON_SECRET`) — nothing in this repo schedules it, and unlike the dispatch sweep (which also runs after rider/vendor board polls via `maybeSweepDispatch`) no screen triggers it | QA `test:rider-profile` › "pure: reminder stages — 30, 7, 1, expired; each once; the most urgent only", "data: expiry reminders — each sent once, the most urgent only, expiry marked"; Flutter › "a document that runs out soon is amber; a far one is quiet", "an expired document is red" | Delivered |
| 12.11 | Emergency contact | Saves directly; Call button; feeds the SOS sheet | Flutter › "the emergency contact saves directly and validates the phone", "a saved emergency contact reaches the SOS sheet at once (its kept copy is renewed)" | Delivered |
| 12.12 | Bank account or payout details | Payout sheet (bank or UPI), masked, change is an approval request; contained table | Flutter › "shows the account on file masked and takes the new number hidden", "a good bank account goes as a request and then waits for Deligro"; QA `test:rider-profile` › "data: Review Focus 3 — a bank change is a request; the approved account is untouched" | Delivered |
| 12.13 | Profile and document update requests | `rider_profile_change_requests`; admin approves; open requests shown | Flutter › "an open request shows \"Waiting for Deligro\" and switches that Edit off", "earlier answers from Deligro are listed, with the reason"; QA `test:admin-rider-profile` › "data: Review Focus 3 — the Profile tab: account in full, change pending beside it; approve applies" | Delivered |
| 12.— | Sensitive data stored securely, visible only to authorised staff | `rider_payout_accounts` RLS on, no policies, privileges revoked; Aadhaar masked by trigger; licence number column-revoked from managers; documents via 10-minute signed URLs to the rider or admins | QA `test:rider-profile` › "pure: masking — Aadhaar keeps the last four only…", "data: Review Focus 2 — another rider's document id gives no URL and no signing request"; PGlite `migration-0086.mjs` (sensitive-column and containment assertions, 201 checks) | Delivered |

## 13. Help & Support

Help `lib/features/help/help_screen.dart` (route `/more/help`, `new`,
`tickets/:id`); `api/rider/support/tickets`, `…/[id]`, `…/[id]/messages` →
`createTicket`, `listMyTickets`, `getMyTicket`, `replyToMyTicket`
(`da/support.ts`); 0087 / shared `support_tickets`; admin desk `/admin/support`.

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 13.1 | Contact Deligro support | Call and WhatsApp rows (numbers from settings) | Flutter `help_test.dart` › "lists the tickets with their status, and Call and WhatsApp open the phone", "hides the call rows when Deligro has set no numbers, and says so" | Delivered |
| 13.2 | Raise a support ticket | New ticket screen (`new_ticket_screen.dart`) | Flutter › "Send stays off until a category and a message are there, then posts them with the order"; QA `test:support` › "createTicket: a rider's ticket with two photos, linked to their own order" | Delivered |
| 13.3 | Issue categories (the eight listed) | Categories in the document's order | Flutter › "the categories are in the document order"; QA `test:support` › "support rules: §13.3 categories, priorities, parsers" | Delivered |
| 13.4 | Attach details or images | Up to 4 photos, byte-sniffed; order link | Flutter › "a fifth photo is refused", "a non-photo file is refused, a photo can be removed"; QA › "createTicket refuses before uploading: a 5th photo, a fake JPEG, another rider's order…" | Delivered |
| 13.5 | Ticket status and responses | Thread screen (`ticket_thread_screen.dart`) | Flutter › "shows the rider and Deligro replies, and no internal notes", "a reply goes to the ticket and clears the box"; QA › "getMyTicket: the thread without internal notes; another rider's ticket is null and mints no URL (Review Focus 4)" | Delivered |
| 13.6 | Previous support requests | Ticket list on Help | Flutter › "lists the tickets with their status…"; QA › "listMyTickets: own only, newest activity first" | Delivered |
| 13.7 | Priority escalation for safety emergencies | Accident category routes to SOS / 112 first; emergency tickets ring ops and pin to the top | Flutter › "the accident category points to SOS and 112 first"; QA `test:support` › "createTicket with an emergency category goes through the SOS path: one ticket, ops rung", "listTicketsForStaff: emergencies pinned first, filters apply" | Delivered |

## 14. Delivery History

History `lib/features/history/history_screen.dart` (route `/history`,
`order/:id`), filters `history_filters.dart`, detail `history_detail_screen.dart`;
`api/rider/history`, `api/rider/history/[orderId]` → `getRiderHistory`,
`getRiderHistoryDetail` (`da/rider-insights.ts`).

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 14.1 | All previous deliveries | Every outcome, newest first, keyset paging | Flutter `history_test.dart` › "scrolling to the end loads the next page by cursor, no repeats"; QA `test:rider-insights` › "data: History lists every outcome, newest first, with the fields the app shows" | Delivered |
| 14.2 | Filter by date | Date-range chips | Flutter › "every range and outcome builds the right query", "the chips change the query and start over"; QA › "data: History filters - outcome and IST date range" | Delivered |
| 14.3 | Filter by status | Outcome chips incl. "Not delivered" (P4-R-APP1) | same; Flutter › "the Cancelled tile link lists every job not delivered, the same count" | Delivered |
| 14.4 | Order ID and vendor | Row: code, shop | Flutter › "a row shows code, shop, area, outcome, times and distance" | Delivered |
| 14.5 | Pickup and delivery timestamps | Row and detail times | same; Flutter › "a delivered job: times, distance, earning, proof photo, items, timeline" | Delivered |
| 14.6 | Delivery distance | Row and detail distance | same | Delivered |
| 14.7 | Earnings per completed delivery | Shown only when the ledger holds real money; never ₹0 under the salary model (P3-R11) | Flutter › "earning shows only when real; never for 0 or null"; QA `test:rider-insights` › "data: earning appears only when it is real money - never a ₹0 per-delivery row" | Delivered with owner override |
| 14.8 | Failure or cancellation reasons | Reason and who cancelled | Flutter › "failed, cancelled and reassigned rows show why", "a cancelled job shows the reason and who cancelled" | Delivered |
| 14.9 | Proof-of-delivery records | Proof (code / photo / ops-approved), signed photo (10 min) | Flutter › "tapping the photo opens it large", "proof without a photo: ops approved says so, no photo"; QA › "data: History detail - timeline, items, signed proof photo (10 minutes), and only for the rider's own order" | Delivered |

## 15. Safety & Emergency Features

Safety `lib/features/safety/safety_screen.dart` (route `/safety`, `report`),
SOS sheet `sos_sheet.dart` (also on the active-delivery header), queue
`lib/core/sos_queue.dart`; `POST api/rider/sos` → `raiseSos`
(`src/lib/data-access/sos.ts`); incidents are support tickets with safety
categories (0087).

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 15.1 | Emergency contact shortcut | Call the rider's emergency contact by name | Flutter `safety_test.dart` › "the emergency contact is called by name", "no emergency contact: the row is hidden and a link adds one" | Delivered |
| 15.2 | Report an unsafe situation | Report form (kind, note, photos, location) | Flutter › "has the same four actions and the five report forms", "a report goes with its kind, note, photos and location, then says ops were alerted" | Delivered |
| 15.3 | Report an accident or vehicle breakdown | Report forms | same | Delivered |
| 15.4 | Report harassment or threats | Report form | same | Delivered |
| 15.5 | Dispatch can contact the rider during active deliveries | Rider's number + Call on the manager board while on the job (`src/components/manager/manager-order-board.tsx`), admin rider page (`src/app/admin/riders/[id]/page.tsx`), exception queue | QA `test:delivery-exceptions` › "list: pending only, oldest first, with code, rider, shop, area, minutes waiting and a signed photo" (rider phone while active), "list: a job that is over shows no rider phone and is flagged inactive" | Delivered |
| 15.6 | Report suspicious orders or locations | Report form | Flutter › "has the same four actions and the five report forms" | Delivered |
| 15.7 | Record incidents for authorised review | Tickets with safety categories; SOS rings managers/admins; admin/manager emergency feed | QA `test:support` › "Review Focus 5: ten taps in a minute -> one ticket, later taps are location updates, ops rung once"; `test:admin-support` › "the emergency feed is managers' and admins' only", "every new page checks its own role…" | Delivered |
| 15.— | Never imply emergency services were contacted unless they were | "This calls 112 from your phone"; "ops have been alerted" only after the server confirms | Flutter `safety_test.dart` › "no sentence in any state claims emergency services were reached", "no string in the safety feature, its state or its queue claims emergency services were reached", "Alert Deligro says \"ops have been alerted\" only once the server confirmed"; QA `test:support` › "no SOS copy claims outside services were contacted" | Delivered |

## 16. App Settings

Settings `lib/features/settings/settings_screen.dart` (route `/more/settings`),
privacy `privacy_screen.dart` (`/more/privacy`), prefs `lib/state/prefs.dart`.

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 16.1 | Language: Hindi and English | Owner override: English only, no language setting, no Hindi in the app | Flutter `no_hindi_test.dart` › "no Hindi and no language switch in lib/ or test/"; `shell_test.dart` › "shows the app version and has no language setting" | Delivered with owner override |
| 16.2 | Notification preferences | Category switches (offers, cancellations, safety locked on), stored server-side (`PATCH api/rider/profile` `notificationPrefs`, rulings P7-R4/R5/R6) and honoured by `notifyRider` | Flutter `help_test.dart` › "offers, cancellations and safety are locked on; the others can be switched", "switching payouts off saves it server-side, every switch as a boolean"; QA `test:support` › "Review Focus 2: payouts switched off -> no push, the inbox entry is still written"; `test:rider-profile` › "data: notification prefs - merge keeps the other switches…" | Delivered |
| 16.3 | Sound and vibration | Two switches, test ring, channel settings | Flutter `settings_test.dart` › "switching them off is stored as ring_sound and ring_vibrate", "with sound off it still rings, so the phone only vibrates"; `ring_test.dart` › "the phone reads the same two switches the app writes" | Delivered |
| 16.4 | Navigation app preference | Google Maps / Other app | Flutter `settings_test.dart` › "choosing Other app is stored as nav_app and survives a restart" | Delivered |
| 16.5 | App version and update information | Version row, Check for updates, forced update blocks (`api/app-version`, rider track) | Flutter `shell_test.dart` › "Check for updates: a newer build opens the update sheet with notes and a download button", "forceUpdate blocks the app with a sheet that cannot be dismissed"; QA `test:app-version` | Delivered |
| 16.6 | Privacy policy and terms | Factual Privacy & data screen; policy/terms rows only when admin URLs are set; no legal text invented | Flutter `shell_test.dart` › "lists what the app holds, and hides policy and terms when no URL is set", "shows the policy row only when its URL is set", "shows both when both are set"; QA `test:rider-status` › "legal links degrade to null" | Delivered with owner override |
| 16.7 | Logout | Sign out (offline hand-off first; confirm while carrying an order) | Flutter `shell_test.dart` › "signs out: offline hand-off first, then the session ends and /login shows", "while carrying an order, a confirm dialog appears; Cancel keeps the session" | Delivered |
| 16.8 | Secure session management | Sign out of all devices (global scope); 401 signs out; per-user caches purged | Flutter › "sign out of all devices uses the global scope"; `auth_test.dart` › "me() 401 signs out and goes to /login", "rider A signs out, non-rider B signs in: B lands on /not-rider and A's name is never drawn" | Delivered |

## 17. Security & Reliability

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 17.1 | Secure login by OTP or another approved method | Phone OTP (`/api/auth/otp/*`) and mobile + password; only `role = driver` passes the gate (`lib/features/auth/login_screen.dart`, `lib/features/gate/`) | Flutter `auth_test.dart` › "a sent code moves to the code step and shows the test-mode code", "exchanges the server's tokenHash for a session", "me() 403 not_rider goes to /not-rider and offers Sign out"; QA `test:otp-limits`, `test:otp-attempts` | Delivered |
| 17.2 | Unique rider account and Rider ID | One profile per auth user; `rider_code` unique from a sequence | PGlite `0081` › "first-registered driver is DR-0001", "second-registered driver is DR-0002", "re-saving a driver…" | Delivered |
| 17.3 | Riders access only their assigned and permitted data | Every `/api/rider/*` route takes the rider id from the session (`requireRiderApi`); RLS on rider tables | PGlite `0081` › "${table}: driver 1 sees only own rows", "${table}: customer sees none"; QA `test:rider-delivery` › "not yours: another rider's delivery -> not_yours, nothing written"; `test:rider-insights` › "data: History detail … only for the rider's own order"; `test:support` › "getMyTicket … another rider's ticket is null…" | Delivered |
| 17.4 | Server validates status changes | `performDeliveryAction` state machine + `guard_delivery_transition` trigger (service role included) | QA `test:rider-delivery` › "every legal transition passes, in order", "deliver from assigned -> bad_state…"; PGlite `0081` › "service_role assigned -> delivered is refused" | Delivered |
| 17.5 | Audit trail of assignments and status changes | `delivery_events` written by triggers and the data layer only | PGlite `0081` › "events: accepted, picked_up, delivered — in order", "an offer logs offered against the offered rider", "insert into delivery_events is denied for driver"; QA `test:rider-delivery` › "the action's position is on its event; the action id is on the event and the row" | Delivered |
| 17.6 | No duplicate completion or duplicate earnings | Action id idempotency; earnings unique per (delivery, rider, attempt); awards unique | QA `test:rider-delivery` › "replay: deliver twice with the same action id -> one delivered event, one COD record, duplicate:true", "replay: two taps of Delivered racing -> both ok, exactly one transition"; PGlite `0083` › "...and a write after delivery adds no second row", "a second row for the same (delivery, rider, attempt) is refused by the unique key" | Delivered |
| 17.7 | Poor connectivity, safe retries | Offline action queue replayed in order, idempotent on the server | Flutter `action_queue_test.dart` › "a network failure queues the action and pending emits it", "flush sends in order per order and empties the queue", "a duplicate answer counts as applied", "flush and submit while a request is in flight never send one action twice" | Delivered |
| 17.8 | Keep active-delivery data through a disconnect | `ActiveDeliveryCache` (`lib/core/active_cache.dart`) | Flutter `action_queue_test.dart` › "saves, loads and clears the active delivery"; `active_delivery_test.dart` › "the delivery kept on the phone renders, with the offline banner"; `jobs_screen_test.dart` › "no signal mid-delivery: the copy on the phone is shown" | Delivered |
| 17.9 | Protect customer contact information | Customer and shop numbers only in the active delivery and only with `driver.call_customer`; History never carries phones | QA `test:rider-jobs` › "board: with driver.call_customer off, neither the shop's nor the customer's number is sent"; `test:rider-delivery` › "contact attempt: … only the rider holding the job" | Delivered |
| 17.10 | Location only for disclosed purposes | Disclosure first; shared only while online or carrying an order; dropped when offline | Flutter `location_test.dart` › "says what, when, why, who and how to stop", "an offline rider with no delivery is not started"; QA `test:rider-status` › "offline closes the shift and drops the position" | Delivered |

## 18. Developer Implementation Requirements

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| 18.1 | Integrate with the existing Deligro backend | Same Supabase + Next.js `/api/rider/*` routes; web `/driver` and the app share the data layer (`advanceDelivery` delegates to `performDeliveryAction`) | QA `test:rider-delivery` › "advanceDelivery (web portal) delegates: pickup then deliver, same error codes"; Flutter `boot_test.dart` › "ApiClient identifies itself as the rider app" | Delivered |
| 18.2 | Connect to order assignment and dispatch | Dispatch offers, sweep, accept/reject | QA `test:rider-dispatch`, `test:rider-jobs` › "sweep: a never-offered ready order is dispatched (excluding earlier rejecters)…" | Delivered |
| 18.3 | Sync status with the Vendor App and customer app | Same delivery statuses; vendor handover; customer "rider arrived" push; customer shop-delay line (P7-R1); rider rating on the tracker | QA `test:rider-delivery` › "vendor handover: picked_up by 'vendor', order on_the_way, customer and rider told…"; `test:support` › "P7-R1: the customer's shop-delay line — fixed words, only while the food is at the shop"; customer Flutter `rider_rating_test.dart` › "the tracker shows the rider card on a delivered order that has a rider, apart from the food rating" | Delivered |
| 18.4 | Earnings from verified delivery records | 0083 trigger writes earnings only when a delivery becomes `delivered`; reversals when corrected out | PGlite `0083` › "a failed delivery earns nothing", "a cancelled delivery earns nothing", "a manager marking delivered with their own JWT earns the rider (SECURITY DEFINER trigger)", "a replayed correction writes no second reversal" | Delivered |
| 18.5 | Real-time updates where supported | Jobs polls every 5 s, Home every 15 s, pushes and rings in the background (no Supabase realtime, by design) | Flutter `jobs_screen_test.dart` › "asks again every 5 seconds while visible", "asks at once when the app comes back to the front"; `dashboard_test.dart` › "asks again every 15 seconds while Home shows" | Delivered |
| 18.6 | Loading, empty, offline and error states | Every screen has them | Flutter `jobs_screen_test.dart` › "an offline rider sees the offline empty state with the switch", "a board that cannot load, with nothing to show, offers a retry"; `dashboard_test.dart` › "a brand-new rider sees zeros and dashes, no errors"; `history_test.dart` › "an empty state says which filter found nothing"; `cash_test.dart` › "a failed load says so and can retry"; `shell_test.dart` › "a network error on a refresh keeps the rider on /home with an offline banner (R15)" | Delivered |
| 18.7 | Affordable Android phones and limited connectivity | Built: offline queue, cached delivery, photo shrinking to ≤ 4 MB, poll cadence, 1.3× text layouts. **Missing:** the low-end AVD run (cold start, memory over 10 min, battery) — Phase 8 Task 4 | Flutter `action_queue_test.dart` (above); `profile_test.dart` › "a 7 MB photo is shrunk first and the shrunk copy is what is sent". No device-performance proof yet | **Defect D4** |
| 18.8 | Test GPS, notifications, navigation, OTP | Named tests per area | Flutter `location_test.dart` › "runs as a foreground service with the Deligro notification" (high accuracy), QA `test:rider-status` › "an implausible fix is refused"; `ring_test.dart`, QA `test:support` (notifications); `active_delivery_test.dart` › "Google Maps turn-by-turn, then the web; other apps through geo:"; `auth_test.dart` › "a sent code moves to the code step…", QA `test:rider-delivery` › "codes: wrong pickup code -> bad_pickup_otp…" | Delivered |
| 18.9 | Test cash reconciliation and payout calculations | Named tests | QA `test:rider-cash` › "day statuses across three days with a LATE deposit…"; `test:rider-earnings` › "statement reconciles: D2 across the 12 Nov payout"; `test:admin-riders` › "previewPayout: sums in whole paise"; PGlite `0083` › "payout … reconciles…" | Delivered |
| 18.10 | Test build before production | **Missing:** no signed release build for the client yet — Phase 8 Task 4 | — | **Defect D5** |

## Final deliverable and scope note

| # | Requirement | Delivered by | Proved by | Status |
|---|---|---|---|---|
| F.1 | Receive assignments, navigate, verify deliveries, track earnings, manage cash, view history, contact support | §3, §5, §6–7, §8, §10, §14, §13 above | The rows above | Delivered |
| F.2 | Individual riders only; no rider staff accounts or vendor staff handling | No staff/team features in `apps/rider`; rider accounts are still created by admins (Settings → Employees) | Flutter `shell_test.dart` › "Home, Jobs, Earnings, History and More, in that order" (no staff surface); `auth_test.dart` › "me() 403 not_rider goes to /not-rider and offers Sign out" | Delivered |

## QA run

`bash scripts/qa/rider-run-all.sh` (Git Bash) — results recorded in
`.superpowers/sdd/2026-10-21-rider-app-phase-8-release/task3-report.md`.
