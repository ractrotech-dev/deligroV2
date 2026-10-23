# Deligro — food delivery for Bemetara

One Next.js app carrying five surfaces — customer, restaurant, driver, manager and
admin — on a Supabase backend with authorization enforced by Row Level Security.
Live: phone-OTP auth, Razorpay and cash payments, order dispatch and tracking,
vendor payouts, and an admin console.

The customer surface follows the original spec — warm minimalism, glassmorphic
persistent cart, time-aware dark mode, order tracking on a map.

> **Board updates are polled, not pushed.** Every "live" board re-runs its server
> render on a timer (4s admin/manager/driver, 8s vendor kitchen, 3s customer
> tracking). Supabase Realtime is not wired up — see `AUDIT_REPORT.md`, which
> covers the cost and the migration that would replace it.

## Run

```bash
pnpm install
pnpm dev        # http://localhost:3005
pnpm build      # production build
pnpm lint
```

Without Supabase keys the app runs as a **static demo** against mock data, with
enforcement off. Copy `.env.example` to `.env.local` and run the migrations in
`supabase/migrations/` to switch it on — steps in [`SECURITY.md`](SECURITY.md).

Open in a desktop browser and it renders inside a centered phone frame; on mobile it's
full-screen. Toggle light/dark from the header or Profile → Appearance (it also
auto-switches by local time: dark 19:00–06:00).

## Screens (all wired to navigation)

| Route | Screen |
|---|---|
| `/` | Home — asymmetric bento discovery (hero promo, live order, reorder, AI stub, categories, nearby-by-ETA) |
| `/search` | Search with keyword + cuisine/price/rating filters, empty state |
| `/restaurant/[slug]` | Restaurant menu, category tabs, add-to-cart |
| `/checkout` | Cash-on-Delivery checkout (address, timing, bill) |
| `/orders` | Active + past orders, track / reorder / rate |
| `/orders/[id]` | Live tracking — map, ETA, stage stepper, rider card |
| `/profile` | Profile, addresses, appearance, settings |

The **glass cart** is a persistent sheet (peek bar → expandable overlay), not a tab — the
"two-tap rule" from the UX doc. One-tap **reorder** pre-fills it from history.

## Design system

Tokens live in `src/app/globals.css` (`--bg --surface --ink --muted --accent --green
--blue --line`, light + dark). Type scale: Fraunces (display serif), Inter (sans),
JetBrains Mono (data). Orange is reserved for one job — the primary action and the live moment.

## Structure

Follows the Folder Structure doc, under `src/`:

```
src/
├─ app/(customer)/   # route group — all customer screens + shell layout
├─ components/       # ui/ bento/ glass/ layout/ shared/ + per-screen folders
├─ stores/          # zustand: cart-store, ui-store
├─ lib/             # data.ts (mock), utils/
└─ types/           # domain types
```

## Role portals — one app, role-based routing

The Driver, Restaurant, and Admin surfaces live in **this same Next.js app** (single
codebase, one login system, one API layer, one deploy — the budget-friendly path).
They render outside the customer phone-frame as responsive, mobile-first web dashboards
and reuse the same design tokens, `Button`, `cn`, `formatINR`, and domain types.

| Route | Surface |
|---|---|
| `/` | Customer app (browse, cart, checkout, tracking) |
| `/portals` | Launcher — links to all four surfaces (handy for demo/QA) |
| `/driver` | Driver — online toggle, available orders → **Accept** → pickup → **Mark delivered**, today's earnings |
| `/restaurant` | Restaurant — live orders board: **Accept/Reject** → **Food ready**; today's counts |
| `/restaurant/menu` | Restaurant — menu with live availability toggles |
| `/restaurant/earnings` | Restaurant — weekly revenue + payouts |
| `/admin` | Admin — KPIs, alerts (coupon abuse, failed-login spike), pending approvals |
| `/admin/orders` | Admin — all-orders table (audited) |
| `/admin/refunds` | Admin — refund queue with flagging + approve/deny |

> The vendor dashboard lives at `/vendor` (kept separate from the customer's
> `/restaurant/[slug]` browse pages so auth gating stays clean).

### Backend & authorization (Supabase)

Auth and the authorization model are wired to **Supabase** — see
[`SECURITY.md`](SECURITY.md). Role-based routing is only a UI convenience; the
real boundary is **server-side** and, above all, **Row Level Security** in the
database, so a forgotten check in app code still can't leak another user's data
(the IDOR class). The three checks — authenticated → role allowed → owns the
record — are enforced in `src/proxy.ts`, `requireRole()` in each portal layout,
and the RLS policies in `supabase/migrations/0001_init.sql`.

Without Supabase keys the app runs as a **static demo** (enforcement off). Add
keys to `.env.local` and run the migration to switch it on — steps in
[`SECURITY.md`](SECURITY.md).

## Not built yet

The items below were once listed here as "later phases". Supabase, OTP auth
(Renflair SMS), Razorpay payments and Google Maps have all since shipped; what
actually remains is:

- **Supabase Realtime.** Boards poll. The CSP already permits `wss://*.supabase.co`,
  so only the migration and the subscription are missing.
- **Hindi.** The UI is English-only, which is the wrong default for this city.
- **The AI ordering assistant.** Still a stub, still unscheduled.
- **Offline handling** beyond the tracking screen's staleness indicator.

`AUDIT_REPORT.md` (and the dashboard at `audit-report.html`) has the full list
with fixes, prioritized.

## Native apps and the Manager app build

Four native Flutter apps replace the old Capacitor shells: customer (`apps/customer`), Partner/vendor
(`apps/vendor`), rider (`apps/rider`) and manager (`apps/manager`). The Manager app is being built in ten
phases — **to continue that work, read [`docs/manager-app-resume.md`](docs/manager-app-resume.md) first**
(branches to push, exact next steps, rules, setup on a new computer, owner steps).

### APKs

Build outputs, not in git. Copies and `SHA256SUMS.txt` are in `F:\hub26\apk-handoff\` on the PC they were
built on. All are **test builds signed with the debug key** (no release keystore yet), so install them on a
phone that does not already have the old app (or uninstall that first).

| App | Version | File | Notes |
|---|---|---|---|
| Manager | 2.0.0+2 | `deligro-manager-2.0.0+2-main-phases1-8.apk` | `feat/manager-app`, Phases 1–8 |
| Manager (preview) | 2.0.0+2 | `deligro-manager-2.0.0+2-phase9-app-preview.apk` | `feat/manager-p9-app`, adds Insights screens |
| Rider | 2.0.0+3 | `deligro-rider-2.0.0+3.apk` | `feat/rider-app` |
| Partner (vendor) | 2.0.0+3 | `deligro-partner-2.0.0+3.apk` | `feat/vendor-app` |
| Customer | 2.0.0+2 | `deligro-customer-2.0.0+2.apk` | customer app |

Rebuild any of them: `cd apps/<app> && flutter build apk --release --dart-define-from-file=env/prod.json`
(copy `env/example.json` to `env/prod.json` first; it is git-ignored). Signed-in screens need the database
migrations applied — see the owner steps in the resume doc.
