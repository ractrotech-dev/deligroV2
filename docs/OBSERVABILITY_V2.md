# Observability v2 — what changes, and why

The platform already has an in-house observability system (migration 0046:
`obs_events`, `obs_issues`, rollups, alerts, incidents; `src/lib/obs/*`; the
developer console at `/developer/observability`). v2 keeps all of it and fixes
the places where it falls short of the "Observability console" blueprint the
owner shared on 2026-10-24. No third-party tool (Sentry, PostHog…) is added.

## Audit (2026-10-24)

| Capability | Before v2 |
|---|---|
| Browser errors | `window` error + rejection only; 1 of 4 error screens reported; no 404s |
| Server errors | `onRequestError` → `captureError`; no actor |
| Database errors | only where a caller remembered `captureError` (~60 places) |
| Outside services | Renflair SMS and OneSignal only; not Razorpay |
| Cron failures | one of two cron routes wrapped; no coverage test |
| Grouping | atomic upsert in `obs_ingest` (good) but the fingerprint used a minified, line-numbered stack frame, so issues split on every deploy |
| People hit | not stored; counted in the app from at most 5,000 raw rows |
| Steps before an error | none |
| Page speed for real users | none |
| Sign-in records | none |
| Audit trail | `ops_audit_log` for manager/ops actions (good); some admin writes bypass it |
| Redaction | good (keys, tokens, emails, phones, cards, query values) |
| Environment | `VERCEL_ENV`, but fell back to `NODE_ENV`, so a local `next start` said "production" |
| Retention / roll-ups | written, but run only once `pg_cron` is switched on by hand |
| Alerts | rule engine with no notification; no new-issue / regression alert |
| Console | Overview, Issues, Incidents, Orders, Payments, Delivery, Notifications, API, Logs, Alerts, traces; developer role only |

## Phases

1. **Grouping you can trust** — fingerprint v2 (no stack frames: environment,
   kind, error type, cleaned message, route or source); people per issue
   (`obs_issue_people`, `obs_issues.users_affected`, counted inside the same
   atomic `obs_ingest`); a bad row is skipped, not the batch; the daily cap is a
   counter, not a `count(*)`; local runs are `development`; the logger's own
   buffer overflow is no longer an issue.
2. **Close the capture holes** — a watcher on the server Supabase clients for
   quiet database refusals (status 300 or ≥ 400, not "no rows", never the
   `obs_*` tables); every error screen reports; signed-in 404s; breadcrumbs
   (last 30 clicks, page changes, requests); browser noise filters (aborted and
   prefetch requests, sleeping laptops, extensions, ResizeObserver) and a
   once-a-minute reload for stale-deploy chunk errors; a cron wrapper with a
   coverage test; Razorpay failures; the signed-in person on server errors.
3. **Sign-ins** — OTP and password successes and failures, new device and new
   country per person, a Security tab.
4. **Alerts** — a notification to developers when an issue is new or comes
   back after being fixed (fires per issue, not per event).
5. **Page speed** — real-user page load and in-app move timings, with
   "typical" and "slowest 1 in 10", and the server's share; a Performance tab.
6. **Console** — people and steps on the issue page, Copy error with the steps
   and no names, Copy top 10.

## Rules kept from the blueprint

The logger never breaks or slows a request (writes happen in `after()`, every
catcher swallows its own errors) and never records its own failures; grouping
is atomic in the database; the fingerprint uses only what stays stable across
deploys; people are counted, not just occurrences; everything is redacted before
it is stored; every record says where it ran; noise is kept but out of the
headline numbers; only the service role writes, only developers read.

## Status (2026-10-24)

All six phases are built, tested and committed. Checks:
`scripts/qa/obs-ingest-sql.ts` (the SQL in an in-process Postgres),
`obs-fingerprint-v2.ts`, `obs-capture.ts`, `obs-cron-coverage.ts`, plus the
existing `obs-telemetry.ts` and `developer-panel.ts`.

The code works before the migrations are applied: the console shows the new
panels empty, and the new writes fail quietly.

## Owner steps

1. Apply, in order, in the Supabase SQL editor: `0169_obs_people_and_robust_ingest.sql`,
   `0170_obs_issue_alerts.sql`, `0171_obs_sign_ins.sql`, `0172_obs_page_speed.sql`.
2. Still pending from 0046: enable `pg_cron` and schedule `obs_rollup`,
   `obs_evaluate_alerts`, `obs_maintain_partitions` and `obs_retention`
   (the commented block at the end of 0046). Without it the charts and
   retention do not run.
3. For alert pushes to reach a developer, they must have signed in to the
   website once with notifications allowed (OneSignal links the device to
   their account).

## Not done (by choice)

- Breadcrumbs and page speed for the Flutter apps (the website only).
- Moving admin writes that bypass `ops_audit_log` onto audited RPCs.
- Per-person page speed and a Users tab; the 60-second figure reuse.
