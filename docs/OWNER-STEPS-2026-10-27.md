# Owner steps — work done on 2026-10-27

Everything below is committed on `master` locally. Nothing has been pushed,
deployed or applied to the live database.

## 0. Fix the website address (urgent)

On 2026-10-27 `deligrodelivery.ractrotech.com` had no DNS address (Google DNS
returns the name with no A/CNAME target), so every app showed "No connection"
after sign-in. The server itself answers when reached by IP (216.198.79.65).
Check the DNS record for `deligrodelivery` at your domain provider / Vercel.

## 1. Push

Push `master` to both GitHub repos (`origin` and `deligroV2`) from the account
you use for Deligro — not `wbt-web-support`.

## 2. Apply the database updates

| Update | What it is for |
|---|---|
| `0179_guest_catalog_read_fix.sql` | **Urgent, apply first.** Right now nobody can browse the shops without signing in ("Browse as guest" shows "Couldn't load this"). This fixes it. |
| `0176_manager_menu_sheet_and_photo.sql` | Manager menu sheets, photo replace, no approving your own held dish |
| `0177_developer_platform_lock.sql` | Developer pause switch |
| `0178_zone_weather.sql` | Weather notices and longer delivery times in rain |

Same way as the earlier updates (Supabase SQL editor, or `supabase db push`).

## 3. Deploy the website

Deploy after step 2. This also ships the fix for duplicate order notifications.

## 4. Weather every 15 minutes

Weather is read automatically while shops and riders have their apps open. For
a steady reading, point any free pinger (cron-job.org, UptimeRobot) at
`https://<your site>/api/cron/weather` every 15 minutes with the header
`Authorization: Bearer <CRON_SECRET>` (the same secret the other cron routes use).

## 5. Switch on the new manager powers

Admin → Feature access, for `manager@deligro.demo` (or any manager):

- **Bulk menu upload** — upload a shop's whole menu from Excel/CSV.
- **Replace photos** — swap a wrong dish photo.
- **Weather notices** is on for every manager by default.

## 6. Install the new APKs

All four apps were rebuilt (new notification icon, plus the new features):
`apps/<app>/build/app/outputs/flutter-apk/app-release.apk`. Upload them to
the GitHub releases as before.

## 7. Back up the keys

`F:\hub26\keys` holds the signing key and passwords. Keep a copy somewhere
safe off this PC.
