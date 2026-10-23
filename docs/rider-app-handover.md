# Deligro Rider app: handover

**For:** the owner. **Date:** 22 Oct 2026. **App:** Deligro Rider 2.0.0 (versionCode 3),
Android, English only.

This page covers:

1. What was built.
2. What you need to do to put it live, in order.
3. What to check on a test (staging) database first.
4. What the app does not do yet.
5. What the Partner-app and Manager-app sessions need to change.
6. Every decision Claude made on its own along the way.

Nothing here has been applied to the live database, deployed, pushed or signed. Those
steps are yours.

---

## 1. What shipped

### By client section

The full check is `docs/rider-app-requirements-coverage.md`. It has one row for every
numbered line of the client's document, with the screen or server rule that delivers
it and the test that proves it.

| § | Section | Lines | Delivered | Delivered your way (owner decision) | Open |
|---|---|---|---|---|---|
| 1 | Dashboard | 13 | 13 | — | — |
| 2 | Online / offline | 7 | 7 | — | — |
| 3 | New delivery requests | 12 | 11 | 3.7: no earning estimate, riders are salaried | — |
| 4 | Delivery management | 20 | 20 | — | — |
| 5 | Navigation and location | 10 | 10 | — | — |
| 6 | Pickup | 6 | 6 | — | — |
| 7 | Delivery verification | 8 | 8 | — | — |
| 8 | Earnings | 22 | 18 | 8.5 and three record fields: shown as salary, not per-delivery pay | — |
| 9 | Performance | 11 | 11 | — | — |
| 10 | Cash | 10 | 10 | — | — |
| 11 | Notifications | 12 | 12 | — | — |
| 12 | Profile and documents | 14 | 14 | — | — |
| 13 | Help | 7 | 7 | — | — |
| 14 | History | 9 | 8 | 14.7: no ₹0 per-delivery earning shown | — |
| 15 | Safety | 8 | 8 | — | — |
| 16 | Settings | 8 | 6 | 16.1: English only, no language setting. 16.6: privacy/terms links appear once you set them | — |
| 17 | Security | 10 | 10 | — | — |
| 18 | Developer requirements | 10 | 8 | — | 18.7 low-end device proof and 18.10 test build: done in this last step, see §7 |
| — | Final deliverable / scope | 2 | 2 | — | — |
| | **Total** | **199** | **189** | **8** | **2** |

**189 delivered, 8 delivered with an owner decision, 2 left.** The two left are 18.7
(proof on a low-end phone) and 18.10 (a signed test build). §7 below has the low-end
run and the release build. The final signing with the real key is yours (step 5 of §2).

### By phase

1. **Foundation.** Sign-in by phone code or password. A rider ID (`DR-0001`…). Online,
   offline and breaks. Only online riders get offers. Signing out takes the rider
   offline. Location is shared only while online or on a delivery, after a clear
   notice. A full audit trail of every delivery step. A server rule stops "delivered"
   before "picked up". There is also an in-app update check.
2. **Jobs.** Offers with a countdown, accept, and reject with a reason. Every delivery
   status. Pickup by code, QR, shop confirmation, or a manual check by ops. Delivery by
   code, with an optional door photo. Problem reports and requests that ops approve.
   Navigation in Google Maps or another app. An in-app map with ETA. Calling the
   customer and the shop. A loud order ring. Steps taken with no signal are sent later.
3. **Money.** The salary ledger: salary, bonus, incentive and deduction lines. Incentive
   rules and targets, and payouts recorded by admin. The Earnings tab and statements as
   PDF or CSV. The per-delivery rate card stays at ₹0 and hidden, because riders are on
   a fixed salary.
4. **Dashboard, history and performance.** The twelve-figure Home screen, History with
   filters and detail, and Performance with targets and ratings. Customers can rate the
   rider on the website and in the customer app.
5. **Cash.** Cash in hand, deposits with a receipt photo, manager confirmation,
   settled/disputed days, disputes and reminders.
6. **Profile and documents.** Profile, vehicle, licence, emergency contact and payout
   account. Document upload, admin verification, expiry reminders and change requests.
   Admin rider pages. Aadhaar is stored masked.
7. **Help, safety and notifications.** Support tickets, SOS and incident reports. A
   notification inbox and announcements. High-demand, pickup-reminder and delay alerts.
   Notification switches that the server honours.
8. **Release.**
   - The English copy was made plainer, and every screen was checked at large text size.
   - The migrations were proven in sequence.
   - The security and deployment checklists were walked.
   - The requirement coverage check was done, and the gaps it found were fixed: door-photo
     clean-up after 90 days, the "order given to another rider" notice, and the payout notice.
   - The release build, the low-end device run, and this document.

---

## 2. Putting it live, in this order

The full checklist is `docs/DEPLOYMENT_AUDIT.md` §1–§2. Here is the order.

**1. Deploy the website first.** Do this before any migration. Migration 0081 refuses
the old staff "mark delivered" path (ruling R7).

**2. Apply the migrations in number order**: staging first, then production.
- The rider files are `0081` → `0082` → `0083` → `0084` → `0085` → `0086` → `0087`.
- Apply them with the other branches, all in number order: the Partner app's
  `0061–0064` come before them, and the Manager app's `0141+` come after.
- **If anything has to be re-run (ruling P8-R3):** re-apply *every* migration from
  0081 to the newest one applied, from all branches, in number order. Never re-run
  the rider files alone. That would undo the Manager files' tighter rules.
- Each file's header has a rollback block. Run rollbacks newest first, and export the
  data first, because they delete ledger, document and ticket rows.
- You can prove them first on a copy with `npm run test:rider-migrations`.

**3. Restart every app instance.** Each one remembers "column missing" until it
restarts.

**4. Set the settings.** See the next part.

**5. Build and sign the APK with the `rider` alias.**
- Use `deligro-release.jks`, the key the old rider app was signed with. With any other
  key, phones refuse the update.
- `apps/rider/README.md` explains `key.properties` and the build command.
- The test build Claude made is signed with a debug key, so it can be installed for
  testing but cannot update riders' phones.

**6. Upload the APK, then raise the version** in Admin → Settings → App releases → Rider app:
- set `rider_apk_version_code` to **3**;
- set the download URL;
- raise `min_version_code` to 3 only when you want to force everyone onto the new app.

### Settings to set (Admin → Settings, before riders switch apps)

**Riders section:**
- **Proof-of-delivery photo:** keep it at **never** while any rider still uses the
  website `/driver` portal, which can't take photos (ruling P2-R5).
- **Unreachable wait**, in minutes (3–30). This is how long a rider must wait after
  calling an unreachable customer before they can report it.
- **Offer window**, in seconds (60–600).
- **Daily target** and **Weekly target**: the default delivery targets.
- **Cash limit** (₹) and **Cash held for** (hours): when a rider is told to deposit cash.
- **High demand at**, **Pickup reminder** and **Delay alert**: the three alert thresholds.
- **Block expired documents** (`block_dispatch_on_expired_docs`): when on, a rider with
  an expired document gets no offers.
- **Routing server:** leave it at the default unless you run your own.

**Support and brand section:**
- **Support phone** and **Support WhatsApp** (`support_phone`, `support_whatsapp`).
  The rider's Help screen offers them.
- **Privacy policy URL** and **Terms of service URL**. The app shows these links only
  once they are set. Claude did not write any legal text.

**Admin → Riders → Incentives:** add the incentive rules, for example "N deliveries in a
day earns ₹X".

**The rate card stays at ₹0.** Riders are on a fixed salary, so the per-delivery pay
fields stay at ₹0 and hidden (ruling P3-R11).

### Scheduled jobs (cron)

Set `CRON_SECRET` on the server: a random value of 16 characters or more
(`openssl rand -hex 32`). Then call these two routes with the header
`Authorization: Bearer <CRON_SECRET>`:

| Route | How often | What it does |
|---|---|---|
| `/api/cron/dispatch-sweep` | Every minute, if your plan allows (Vercel Pro, `pg_cron` + `pg_net`, or an outside pinger) | Re-offers orders and marks silent riders offline. Sends pickup reminders and delay alerts. Sends scheduled announcements. Removes door photos older than 90 days. |
| `/api/cron/rider-documents` | Once a day | Sends document-expiry reminders and marks expired documents |

Without the secret, both routes refuse every caller. Without a schedule, the sweep runs
only while a shop or rider has their board open, and expiry reminders never go out.

---

## 3. Checks to run on a staging database first

Do these on a staging Supabase project with every migration applied, before production.

1. **The IDOR suite.** This is a security test that tries to read other people's data,
   and it has **never been run**. It creates test accounts and orders in whatever
   project it points at, so **only point it at staging**:
   - put the staging project's keys in `.env.local`;
   - run `RIDER_QA_IDOR=1 QA_PASSWORD='<12+ chars>' bash scripts/qa/rider-run-all.sh`, or
     `QA_PASSWORD='…' npm run test:idor` on its own.
2. **Notification switches save.** In the app, signed in as a test rider, go to
   Notifications, turn one switch off and then back on. Each change must save without
   an error. Then check the database shows each change:
   `select notification_prefs from rider_profiles where driver_id = '<rider uuid>';`
   This is the one place that relies on PostgREST comparing two JSON values, and it has
   not been tried on a real database. If saving fails, tell Claude.
3. **Order and delivery agree.** This must return no rows:
   ```sql
   select o.id from orders o join deliveries d on d.order_id = o.id
    where o.status = 'delivered' and d.status <> 'delivered';
   ```
4. **One payout and one rule edit.** In Admin → Riders, record one payout for a test
   rider, and check that the rider gets the "Payout recorded" notice. Then edit one
   incentive rule and check the rider's Earnings tab shows the change.
5. **The smoke test** from DEPLOYMENT_AUDIT's change log. A rider signs in and
   `/api/rider/me` shows a `DR-` ID. Going online loads the Jobs board. Staff "mark
   delivered" still works.

---

## 4. Known limitations

- **No end-to-end run on a real migrated database yet.** No database with these
  migrations exists, and the live one must not be touched (ruling R2). So the database
  rules were proven in an in-memory Postgres, and the app was proven by tests and on an
  emulator with sample data. Staging (§3) is where the full flow runs for the first time.
- **After pickup, ops cannot hand a job to another rider.** They can only fail the
  delivery or cancel the order. A rider who must stop mid-trip calls ops (ruling P2-R9).
- **Moving a delivered order to another rider takes two steps.** Correct it out of
  "delivered" first, then complete it with the other rider (ruling P3-R7).
- **The APK is about 75–80 MB.** The QR scanner bundles Google's barcode model. Setting
  `dev.steenbakker.mobile_scanner.useUnbundled=true` in `android/gradle.properties`
  makes it smaller, but then it needs Play Services. Your call.
- **Play Store.** The app asks to ignore battery optimisation and runs a location and an
  alarm-sound foreground service. These are fine for an APK you share yourself, but
  Google Play would ask for a written reason for each.
- **The update check runs only when the app starts,** not when it comes back from the
  background.
- **SOS:** an alert queued with no signal is dropped if the rider's session is revoked
  before it sends. An alert older than 60 minutes waits for the rider to tap "Send now"
  (ruling P7-R3).
- **Statement PDF** is English only. A name typed in Hindi script may show as boxes
  (ruling P3-R3).
- **Maps** use the public OpenStreetMap tiles and the public OSRM route server, the same
  as the customer app. Both have fair-use limits.
- **The location notice** in the phone's status bar uses the app icon, which can show as
  a plain circle. A dedicated small icon would look better.
- **Please confirm** the wording on the Privacy & data screen about documents and how
  removal works (Phase 1 note).
- **Two cash rules need your OK (rulings P5-R1 and P5-R2).** A day reads "settled" once
  deposits cover everything collected up to that day. A disputed deposit marks its day
  "disputed" only while the day is unsettled.
- **Android only.** The iPhone folder exists but was never built or tested. iPhones also
  cannot ring continuously.

---

## 5. Handover items for the other sessions

These are changes the Partner (vendor) and Manager app sessions need to make in their
own branches. Each one is safe today if migrations are applied in number order.

### Partner app (feat/vendor-app)

1. **0063:** add `delivery_instructions` and `zone_id` to the locked columns in its
   `guard_order_update`. If 0063 runs after 0082, a shop could rewrite the customer's
   note to the rider.
2. **0064:** copy ruling P8-R1 into its `announcement_audience_of`. Add
   `and (uid = auth.uid() or public.is_admin() or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin'))`
   to the `where`. Otherwise, re-running 0064 lets any user look up another user's role.
3. **Vendor documents allow 10 MB** (`vendor-documents.ts`, `documents-manager.tsx` on
   feat/vendor-app), but
   the host refuses request bodies over about 4.5 MB. Lower the cap to 4 MB like the
   rider documents (ruling P6-R2).
4. **Announcement composer:** to use the shared push sweep, new announcements must set
   `push_mode` (`now`, `scheduled` or `none`). Rows left empty are never pushed by the
   sweep (ruling P7-R2).
5. **Merge note:** `support.ts`, `user-notifications.ts` and `notify-user.ts` exist on
   both branches. The rider version is a superset, so merge them by hand.

### Manager app (feat/manager-app)

1. **Ruling P8-R2 (now closed on the Manager branch):** its 0143 drops 0087's
   `support_tickets — manager rider read` and `support_messages — manager rider read`
   policies. Keep that when the branches merge. Without it, a manager of one zone can
   read every zone's rider SOS and tickets.
2. **0152:** add `revoke execute on function guard_manual_rider_handover` from anon and
   authenticated, as 0085 does.
3. **`ops_assign_rider`** should do what the website's hand-assign now does: stop the
   ring on the rider who was offered the order and send them "Order given to another
   rider".
4. **Payout approval (0152)** should call `announcePayoutRecorded`, so the rider is told
   a payout was made. Its deposit confirmation should also record the cash against the
   confirming manager (`to_user = p_actor`), as our 0085 does after the final-review fixes (ruling P8-R11).
5. **Take our 0081, 0082 and 0083 when merging.** The Manager branch's copy of 0081 still
   has the old backfill, which re-stamps rows when it is re-run.
6. **`my_rider_ratings`:** the Manager branch's 0150 alone leaves this view writable by
   riders. Our 0084 closes it. Keep that revoke.
7. **Aadhaar:** `uploadRiderDocument` and `ops_add_rider_document` store the full
   Aadhaar number. Our 0086 trigger masks it, but the Manager code should store only the
   masked number. Also keep our `rider-profile.ts` at merge (it masks Aadhaar and uploads
   atomically), and reconcile `eligibility.ts` with `riderIneligibility`.
8. **Announcement composer:** set `push_mode`, as in Partner item 4.
9. **Until 0151/0152 land,** cash-deposit handovers have no zone and no audit row, and
   any manager can decide any deposit. An SOS that gets linked to an order later keeps
   an empty zone (0143's trigger runs only on insert).
10. **Staff correction tools** must take an order out of "delivered" before giving it to
    another rider (ruling P3-R7).

---

## 6. Rulings Claude made

These are the calls Claude made where the plan was silent or wrong. Your own decisions
(English only; riders on a fixed salary) are not in this list.

### Phase 1: Foundation
- **R1:** "npm run typecheck" in the plans means `npx tsc --noEmit`, because that script does not exist.
- **R2:** No database with the new tables exists here. Database rules were proven in an in-memory Postgres, and new routes answer "migration pending" until you apply the migrations.
- **R3:** The rider ID can be empty before migration 0081, and the app then shows "—".
- **R4:** A break "until I resume" is stored with an end date of 31 Dec 9999 and shown as "Until you resume".
- **R5:** The app reads its server settings from a private `env/prod.json`, copied from the customer app and never committed.
- **R6:** Tests against the live site covered only start-up, sign-in and error screens. Full screen walkthroughs used debug-only sample data, which release builds refuse.
- **R7:** Deploy the website before migration 0081, or staff "mark delivered" is refused.
- **R8:** The security checklist for every migration was walked once, in the release phase, before anything is applied.
- **R9:** "Pickup needs the order to be ready" is checked as "the delivery is assigned to this rider", because the order changes status before the delivery does.
- **R10:** If a rider goes offline at the same moment as an offer arrives, that order can wait one offer window (up to 3 minutes) before it is offered again.
- **R11:** If sign-out can't reach the server, the app still signs the rider out on the phone.
- **R12:** Orders never offered to anyone are re-offered by the sweep and when a rider comes online.
- **R13:** The launcher icon is the customer app's art on black, so the two apps look different on one phone.
- **R14:** The splash uses the website's rider picture, because no electric-cycle art was supplied.
- **R15:** On a weak network, a signed-in rider stays on Home with an "offline" banner instead of being sent back to sign-in.
- **R16:** The Phase 1 fixes ran at the same time as Phase 2's first task, because they touched different files.
- **R17:** During a delivery, location is shared every 10 seconds even if the rider is offline. It stops only when the rider is neither online nor on a delivery.

### Phase 2: Jobs
- **P2-R1:** One shared "complete delivery" step handles both normal and ops-approved completions.
- **P2-R2:** Ring sound, vibration and the navigation app are read through one settings helper.
- **P2-R3:** A rider on a break can still see and take open orders. A break only stops new offers.
- **P2-R4:** Adding the QR-code package also tidied the package lock file, which was already out of date.
- **P2-R5:** Keep the door-photo rule at "never" while any rider still uses the website portal, which can't take photos.
- **P2-R6:** The customer-side changes were built alongside the exceptions work, because they touched different files.
- **P2-R7:** Only the customer's free-text note becomes the rider's delivery instructions. Flat, floor and entry code stay in the address.
- **P2-R8:** The app's jobs data layer was built alongside the server's exceptions work, using the planned response shape.
- **P2-R9:** A rider can ask to go offline only before pickup. After pickup they must finish the delivery, fail it or return it, or call ops.
- **P2-R10:** After a rider is released, the order goes back to dispatch at its real stage: ready, or still cooking.
- **P2-R11:** Pickup problem reports became support tickets in Phase 7. Until then they went to the ops exception queue.
- **P2-R12:** The phone-clock fix, the ring timing and the ring-sound memory fix were done together in one later task.

### Phase 3: Money
- **P3-R1:** Incentive notices are sent from the one completion step, so ops-approved deliveries count too.
- **P3-R2:** Earnings use the distance known at delivery time and record whether it was routed or estimated.
- **P3-R3:** The statement PDF is English only, with no Hindi font.
- **P3-R4:** If a delivery stops being "delivered", a reversing line is written automatically. Incentives already earned stay.
- **P3-R5:** The per-delivery rate-card settings are publicly readable, like the older rider pay settings.
- **P3-R6:** A payout that includes an earning also includes that earning's reversal.
- **P3-R7:** The rider on a delivered order can't be changed. To move it, correct it out of "delivered", then complete it with the other rider.
- **P3-R8:** A delivery with any earning line can't be deleted.
- **P3-R9:** Incentive notices are sent at most once. A rare missed notice is better than a duplicate.
- **P3-R10:** With the ₹0 rate card, offers show no earning estimate, not even for tips.
- **P3-R11 (salary model):**
  - The rate card stays at ₹0 and hidden.
  - ₹0 delivery lines still count toward targets, but they are not shown as money.
  - "Earnings per delivery" reads "Salaried — not paid per delivery".
- **SPEED-1, SPEED-2:** After you asked for speed, the server and app halves of Phases 4–7 were built in parallel copies of the code and merged one by one.
- **SPEED-3:** The per-phase final reviews were folded into one whole-project review at the end.

### Phase 4: Dashboard, history, performance
- **P4-R-APP1:** Tapping "Cancelled" on Home opens History filtered to "Not delivered" (cancelled, failed and reassigned), so the list matches the number.
- **P4-R-APP2:** Home's money tiles carry the salary caption, so ₹0 never looks like unpaid work.

### Phase 5: Cash
- **P5-R1:** A cash day reads "settled" once deposits so far cover everything collected up to that day. Needs your OK.
- **P5-R2:** A disputed deposit marks its day "disputed" only while that day is unsettled. An open cash dispute always does. Needs your OK.
- **P5-R3:** Deposit decisions use the Manager app's single-step design, so both apps follow one rule. A manager is refused, not warned, if a manual handover already exists that day.
- **P5-R-APP1:** Receipt photos must be JPEG or PNG, up to 4 MB. The type is checked from the file itself, not its name.

### Phase 6: Profile and documents
- **P6-R1:** A verified rider stays verified after uploading a new document. Only that document waits for review.
- **P6-R2:** Document uploads are capped at 4 MB, the hosting limit. Photos are shrunk in the app, and bigger PDFs are refused with a clear message.
- **P6-R3:** The server tells the app whether a rider was ever verified, so the "waiting for approval" wording is right.

### Phase 7: Help, safety, notifications
- **P7-R1:** Customers see a shop delay only as "The shop is running late", never the rider's own words.
- **P7-R2:** Each announcement records whether and when it was pushed. The sweep pushes only those marked "scheduled", and if in doubt it does not push.
- **P7-R3:** An SOS that waited more than 60 minutes for signal is not sent automatically. The rider taps "Send now" or "Discard". Queued alerts are cleared on sign-out.
- **P7-R4:** The app sends every notification switch's value each time it saves.
- **P7-R5:** Notification switches work even when profile editing is turned off.
- **P7-R6:** Saving notification switches keeps settings the app doesn't know about, for example ones from a newer version.

### Phase 8: Release
- **P8-R1:** The announcement-audience check answers only about the person asking, unless an admin or the server asks.
- **P8-R2:** The rider-ticket read rules for managers stay for now. The Manager app must replace them with zone-limited ones.
- **P8-R3:** If migrations must be re-run, re-run every one from 0081 to the newest, from all branches, in number order.
- **P8-R4:** Door photos are removed 90 days after the delivery ended (delivered, failed, or cancelled after pickup). They are kept while the order has an open problem report or support ticket, and a delivery brought back by a correction keeps its photo.
- **P8-R5:** Help-ticket category names come from the server, which the Partner app shares. The app's built-in list was matched to them.
- **P8-R6:** A step the app saved with no signal and sent later counts at the time the server received it, because phone clocks can't be trusted for pay or incentive days. A tap at 23:58 sent at 00:05 counts on the next day.
- **P8-R7:** Rider pushes go only to the signed-in rider's own account. When a rider signs in, their phone is removed from any other rider's account, and signing out removes it from theirs. This stops a shared phone getting the previous rider's pushes.
- **P8-R8:** The "expired documents" block lifts only when every required document has a verified, unexpired copy. A pending replacement or a rejection does not lift it.
- **P8-R9 (changes P6-R1):** Uploading a document moves only an unverified rider to "pending". A rejected rider stays rejected until staff act.
- **P8-R10:** Only the server, an admin or the owner can use the "correction" path that bypasses the delivery-step rules.
- **P8-R11:** A confirmed cash deposit is recorded against the manager who confirmed it.
- **P8-R12:** Once cash has been collected on a delivery, a correction that would move it to another rider is refused. Ops refund or re-collect instead.
- **SPEED-4:** After you asked to finish faster, the one final whole-project review was split across three reviewers working at the same time: database and security, business flows, and the app.

---

## 7. Release build and low-end phone run

*Filled in after the last branches merge (the copy/text-scale pass and the coverage
fixes). The final APK is built from that code.*

- Release APK (R8 on, debug-signed): _pending_
- Fixture data absent from `libapp.so`, every ABI: _pending_
- Low-end emulator `deligro_low`: Android 10 (API 29, Google APIs, x86_64), 2 GB RAM,
  720×1440.
- Cold start, splash to sign-in (3 runs, target under 4 s): _pending_
- 10-minute online session, memory every minute: _pending_
- Screenshots, light and dark: _pending_
- Overnight battery note: _pending_
