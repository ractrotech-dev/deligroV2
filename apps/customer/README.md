# Deligro — customer app (Flutter)

Native rebuild of the customer side of Deligro. It replaces the Capacitor
shell in `mobile/` for the customer role, installs as an **update** to it, and
talks to the same backend as the website. Vendor, rider and manager apps are
not part of this yet.

Machine setup: [`docs/FLUTTER_SETUP.md`](../../docs/FLUTTER_SETUP.md).

## Run and build

```powershell
cd apps/customer
copy env\example.json env\prod.json        # then fill in the two Supabase values
flutter pub get
flutter run --dart-define-from-file=env/prod.json
flutter build apk --release --dart-define-from-file=env/prod.json
```

`env/prod.json` is gitignored. It holds **public** values only: the Supabase
URL, the publishable (anon) key, the site URL and the OneSignal app id. Never
put the service-role key, Razorpay secret or OTP pepper in it. A build without
it shows a "no server configuration" screen instead of misbehaving.

### Release signing — read before the first release

The rules in `docs/FLUTTER_SETUP.md` → *Deligro-specific rules* apply:

- `applicationId` is `com.ractrotech.deligro`, the same as the Capacitor app, so
  this installs over it.
- Sign with the same keystore and the `customer` alias. Create
  `android/key.properties` (gitignored):
  ```
  storeFile=C:/Users/<you>/deligro-keys/deligro-release.jks
  storePassword=...
  keyAlias=customer
  keyPassword=...
  ```
  Without that file the release build is signed with debug keys. That's fine
  for testing on a phone, but such an APK **cannot** update the installed app.
- `version: 2.0.0+2` in `pubspec.yaml`. The installed app is versionCode 1.
  When you bump it, bump `Env.versionCode` in `lib/config/env.dart` too (it is
  what `/api/app-version` is asked about), and `mobile/roles.json`.
- After shipping, set the customer APK version and URL in Admin → Settings so
  installed apps are offered the update.

## How it talks to the backend

| What | How |
|---|---|
| Catalog, settings, banners, own orders, profile, favourites | Supabase directly, under RLS, with the publishable key and the user's JWT. Same tables and column lists as `src/lib/data-access/*`. |
| Login, placing and cancelling orders, tracking, coupons, addresses, reviews, refunds, payments, push registration | The website's `/api/*` routes (`lib/core/api.dart`). |

**Why the API calls send a cookie.** The `/api/*` routes read the session from
the `@supabase/ssr` cookie and ignore `Authorization` headers. The app rebuilds
that cookie from the SDK's session (`lib/core/session_cookie.dart`, checked
against `@supabase/ssr` itself) and refreshes the token *before* it expires, so
the server never has to rotate it. If the server does rotate it anyway, the app
takes the new session from `Set-Cookie`. A cleaner long-term fix is server-side
Bearer support in `src/lib/supabase/server.ts`. That is an auth-path change,
so it needs the `docs/SECURITY_AUDIT.md` pass.

**Never create orders through PostgREST.** RLS would allow the insert, but
pricing, fees, coupons and COD rules run only in `/api/orders`.

## Differences from the website

- **Maps** use OpenStreetMap (flutter_map), and reverse geocoding uses
  Nominatim. The website's Google key is restricted to browser referrers and
  won't work from an app. To use Google later, create an Android-restricted
  key.
- **Push** uses the OneSignal Flutter SDK, with the same `external_id = profile
  id` targeting. Tapping an order push opens that order in the app.
- Avatar upload and phone-number change are not built yet. The API routes for
  them exist.

## Layout

```
lib/
  config/    build-time env
  core/      API client, session cookie, pricing, formatting, push
  models/    Restaurant, Order, Tracking, Settings, Banner, taxonomy (generated)
  data/      repositories (one per backend area)
  state/     Riverpod providers, cart, delivery location, prefs
  theme/     colour tokens copied from src/app/globals.css
  widgets/   shared UI
  features/  one folder per screen area
```

`lib/models/taxonomy.dart` is generated from the website's
`src/lib/taxonomy.ts` and `FOOD_CATEGORIES`. Regenerate it rather than editing
it by hand.

## Tests

```powershell
flutter test
flutter analyze
```
