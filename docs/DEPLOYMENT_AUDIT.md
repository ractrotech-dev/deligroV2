# Deployment audit — pre-flight checklist

Work top to bottom before promoting to production. Several guards added in the
0022 hardening pass **fail closed on purpose**: a missing variable now stops the
app rather than quietly disabling a security control. That is the intended
behaviour, but it means a deploy with an incomplete environment will break
loudly. Better here than silently in front of customers.

---

## 1. Environment variables

### Required — the app refuses to run without these

| Variable | Failure if missing | Why it's fatal |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Throws at boot | Demo mode makes `requireRole()` return a synthetic admin — `/admin` would be public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Throws at boot | as above |
| `SUPABASE_SERVICE_ROLE_KEY` | Throws on first admin/OTP operation | OTP, vendor admin and push all need it |
| `OTP_PEPPER` | Throws on first OTP request | OTP hashes are worthless without it. Generate per environment: `openssl rand -hex 32` |
| `RENFLAIR_API_KEY` | OTP request returns 503 | Without it no customer can sign in |

### Optional

| Variable | Notes |
|---|---|
| `CRON_SECRET` | At least 16 characters (`openssl rand -hex 32`). Authenticates `/api/cron/dispatch-sweep` and `/api/cron/rider-documents` as `Authorization: Bearer <secret>`. Unset or short → both routes answer 401 to everyone (fail closed): no off-hours re-offers, pickup reminders, delay alerts or scheduled announcement pushes, and no document expiry reminders. |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` (or `KV_REST_API_*`) | Not required. Rate limits default to Supabase Postgres (`0027_rate_limits.sql`). Redis is only an optional faster backend if you add it later. |

### Must be ABSENT (or empty) in production

| Variable | Why |
|---|---|
| `MFA_EXEMPT_EMAILS` | Dead since migration 0033 removed MFA — nothing reads it. Delete it wherever it is still set, so it is never mistaken for a live control |

- [ ] Every required variable is set on the **Production** environment
      specifically — not just Preview, not just Development.
- [ ] `MFA_EXEMPT_EMAILS` is unset everywhere (MFA is gone; the variable is dead).
- [ ] Each portal's sign-in page loads for a signed-out visitor and admits only
      its own role: `/admin/login`, `/vendor/login`, `/manager/login`,
      `/driver/login`, and `/login` for customers.
- [ ] No `NEXT_PUBLIC_` prefix on anything secret. Check with
      `grep -rn 'NEXT_PUBLIC_' src/ | grep -i 'secret\|service\|password'`.
- [ ] Preview deployments do **not** carry production keys. Preview URLs are
      guessable and unauthenticated.

---

## 2. Database migrations

- [ ] Every file in `supabase/migrations/` has been applied, in order, to the
      target project. Compare against the live schema — do not assume.
- [ ] **0022 specifically:** re-run its two verification queries (bottom of the
      file). The column-privilege one must return zero rows.
- [ ] The demo/QA accounts still exist and still have their roles:

```sql
select p.id, u.email, p.role
  from public.profiles p
  join auth.users u on u.id = p.id
 where u.email in ('admin@deligro.demo','vendor@deligro.demo','driver@deligro.demo');
-- Expect exactly three rows: admin, restaurant, driver.
-- If a role is wrong: update public.profiles set role='admin' where id='<uuid>';
```

- [ ] Storage buckets exist with the right visibility:
      `avatars` (public), `menu-images` (public), `vendor-logos` (public),
      `vendor-docs` (**private**), and from the rider migrations
      `delivery-proofs` (**private**, 5 MB, JPEG/PNG — also cash receipts),
      `rider-documents` (**private**, 10 MB, PDF/JPEG/PNG) and
      `support-attachments` (**private**, 5 MB, JPEG/PNG). None of the three
      has a storage policy; a public flag on any of them is a finding.
- [ ] **Rider migrations 0081–0087:** deploy the website first (Phase 1
      ruling R7: the old staff "mark delivered" path would be refused by
      0081's guard), then apply 0081 → 0087 in number order — with the
      sibling branches, by number: the Partner app's 0061–0064 fall before
      them and the Manager app's 0141+ after — then restart
      every app instance (each remembers "column missing" until restarted).
      **Re-run rule (ruling P8-R3):** if anything has to be re-run,
      re-apply EVERY migration from 0081 through the newest one applied, from
      all three branches, in number order — never the rider files alone.
      Later migrations narrow what the rider files open: Manager `0141`
      re-scopes the read policies on `rider_status`, `rider_shifts`,
      `rider_profiles`, `delivery_events` and `delivery_exceptions` to the
      manager's zones, `0142` re-declares `log_delivery_event` (actor and ops
      reason), and `0152` takes EXECUTE on `record_rider_payout` away from
      `authenticated` (its maker-checker). Re-running 0081–0087 on their own
      after those widens the five policies back to every manager, hands
      `record_rider_payout` back to any admin session and drops 0142's logger
      until the later files run again.
      Rollback blocks are in each header; run them newest
      first (they destroy ledger, document and ticket rows — export first).
      Proof before applying: `npm run test:rider-migrations` (PGlite, see
      `scripts/qa/sql/rider-migrations-sequence.mjs`).
- [ ] After 0081–0087, the `platform_settings` row has the rider columns and
      Admin → Settings → Riders saves: offer window (60–600 s), POD-photo rule
      (keep `never` while any rider still uses the web `/driver` portal,
      ruling P2-R5), unreachable wait (3–30 min), routing server (https),
      default targets, cash limit / hours, block on expired documents, the
      three alert thresholds, and the privacy policy / terms links (https).
      The support phone and WhatsApp numbers (`support_phone`,
      `support_whatsapp`, Admin → Settings) are set — the rider app's Help
      screen offers them (from `/api/rider/support/tickets`). The rate card stays at ₹0 (riders are salaried,
      ruling P3-R11).
- [ ] The rider APK steps — sign with the rider alias, upload, then raise
      `rider_apk_version_code` / `min_version_code` and the download URL —
      are in the rider handover doc (`docs/rider-app-handover.md`, Phase 8
      Task 4), after the website and migrations above.
- [ ] Schedule the two cron routes with the `CRON_SECRET` header:
      `/api/cron/rider-documents` once a day; `/api/cron/dispatch-sweep`
      every minute if the plan allows (Vercel Pro, `pg_cron` + `pg_net`, or an
      external pinger) — otherwise it runs only when a vendor or rider board
      is open. No `vercel.json` entry ships with either.

---

## 3. One-time actions after the 0022 hardening

These are not recurring — tick them once, on the first deploy that includes 0022.

- [ ] **Rotate every vendor login password.** They were stored in plaintext in a
      world-readable column. Admin → Vendors → Edit → *Generate new password*.
- [ ] **Rotate the Supabase service-role key and publishable key.**
- [ ] **Rotate `OTP_PEPPER`.** In-flight codes are invalidated; users just
      request a new one.
- [ ] **Notify vendors** that payout details (bank account, IFSC, PAN, GST) may
      have been exposed, so they can watch their accounts.
- [ ] Delete any stray `.env.local` outside the project directory.
- [ ] Existing OTP hashes are SHA-256 and will no longer verify against the new
      scrypt scheme. Codes are 5-minute-lived, so this self-clears; optionally
      `delete from public.otp_codes where consumed = false;` at cutover.

---

## 4. Build and dependencies

- [ ] `npm ci` succeeds (not just `npm install` — the lockfile must be honest).
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx eslint src` — no **errors**.
- [ ] `npm run build` succeeds.
- [ ] `npm audit --audit-level=high` clean.
- [ ] `xlsx` resolves to the SheetJS CDN tarball, not npm:
      `node -p "require('./node_modules/xlsx/package.json').version"` → `0.20.3`
      or later. `0.18.5` means the lockfile regressed to the abandoned,
      permanently-vulnerable npm build.
- [ ] Node version matches `.nvmrc` (24.x) on the deploy target.

---

## 5. Post-deploy smoke tests

Run against the deployed URL.

- [ ] **The three demo logins work:** `admin@deligro.demo`,
      `vendor@deligro.demo`, `driver@deligro.demo` each reach their portal.
- [ ] Customer phone-OTP login completes and an SMS actually arrives.
- [ ] Place a test order end to end; confirm the total matches the menu prices.
- [ ] Vendor kitchen board can advance a status but the order total is unchanged.
- [ ] Security headers present:
      `curl -sI https://<host>/ | grep -i 'content-security\|strict-transport\|x-frame\|x-content-type'`
- [ ] API responses are uncacheable:
      `curl -sI https://<host>/api/me | grep -i cache-control` → `no-store`
- [ ] **The C-1 regression check** — this must NOT return payout data:

```bash
curl -s "https://<project>.supabase.co/rest/v1/restaurants?approved=eq.true&select=name,bank_account_number,pan_number,owner_email" \
  -H "apikey: <publishable key>"
# Expect: 42501 "permission denied for column". Anything else means 0022
# did not apply, or a later migration re-granted the columns.
```

- [ ] Automated suites:

```bash
QA_PASSWORD='…' npm run test:idor
BASE_URL=https://<host> npm run test:e2e
```

---

## 6. Rollback

- [ ] The previous deployment is still promotable in Vercel.
- [ ] Note that 0024 **drops** `restaurants.temp_password`. Rolling the *app*
      back is safe; rolling the *migration* back is not, and should not be
      attempted — the column held plaintext credentials on a publicly readable
      row, and its absence is the fix. Older app builds that read it will error
      on that one admin screen.
- [ ] 0039 **adds** `vendor_login_credentials`, which holds vendor hand-off
      passwords in clear on purpose (see SECURITY.md). Rolling the app back is
      safe — nothing older reads the table. If you drop it, every stored vendor
      password is gone and each affected shop needs a fresh one issued; the
      logins themselves keep working, because Supabase Auth is the authority.

---

## Change log

| Date | Reviewer | Scope | Outcome |
|---|---|---|---|
| 2026-10-22 | Release walk (rider Phase 8) | Website changes of rider phases 1–7 | §1, §2, §4 and §6 walked for everything the rider project added; rows below. Nothing deployed or applied. |
| 2026-10-22 | Release walk | Environment | One variable newly relied on: `CRON_SECRET` (pre-existing for the dispatch sweep; Phase 6 adds the rider-documents cron). Fails closed. No new `NEXT_PUBLIC_` variable; no new secret. Added to §1. |
| 2026-10-22 | Release walk | Migrations 0081–0087 | Apply order, restart and re-run rule added to §2. In PGlite on a database built from 0001–0059: all seven apply in order, re-apply on the populated database with an unchanged catalog (2,149 objects), and every rollback block runs newest first back to the baseline — two documented residues: enum value `failed`, and 0087's `note` kind until its rows are deleted. Two fixes made on the way (0082 re-run kept later event kinds; 0086 rollback grants). |
| 2026-10-22 | Release walk | Settings columns | 18 new `platform_settings` columns across 0081–0087, all with defaults and CHECKs, all column-granted for reading; the admin form clamps and https-checks them. Added to §2 as a post-apply check. |
| 2026-10-22 | Release walk | Storage | Three private buckets (`delivery-proofs`, `rider-documents`, `support-attachments`) created by the migrations; added to §2's bucket check. |
| 2026-10-22 | Release walk | Cron / sweep | `/api/cron/dispatch-sweep` (re-offers, presence sweep, pickup reminders, delay alerts, scheduled announcement pushes) and `/api/cron/rider-documents` (daily expiry reminders and `expired` status). Neither is scheduled in the repo; scheduling is an owner step, added to §2. |
| 2026-10-22 | Release walk | Routes | About 45 new or changed route handlers (`/api/rider/**`, customer proof/rating/instructions, vendor handover, admin document viewer, two crons) and the rider admin/manager actions — authorization and rate limits walked in docs/SECURITY_AUDIT.md (release-walk rows). Every `/api` response, these included, is `no-store` (next.config.ts headers). |
| 2026-10-22 | Release walk | Post-deploy smoke additions | After deploy and migrate: a rider signs in on the Android app and `/api/rider/me` shows a `DR-` rider ID; go online → board loads; staff "mark delivered" still works (deploy order); one admin payout and one incentive-rule edit on staging (Phase 3 carry); the order/delivery disagreement check from Phase 1 (`select o.id from orders o join deliveries d on d.order_id = o.id where o.status = 'delivered' and d.status <> 'delivered'` returns nothing). |

---

## Sign-off

| Date | Deployer | Version / commit | Notes |
|---|---|---|---|
| | | | |
