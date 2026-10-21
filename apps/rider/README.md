# Deligro Rider (Flutter)

Native Rider app for Deligro. It replaces the Capacitor shell in `mobile/` for
the rider role (`com.ractrotech.deligro.rider`, installs as an update to it) and
talks to the website's `/api/rider/*` routes. Copied and adapted from
`apps/customer`, not shared through a package.

Machine setup: [`docs/FLUTTER_SETUP.md`](../../docs/FLUTTER_SETUP.md).

## Run and build

```powershell
cd apps/rider
copy env\example.json env\prod.json        # then fill in the Supabase values
flutter pub get
flutter run --dart-define-from-file=env/prod.json
flutter build apk --release --dart-define-from-file=env/prod.json
```

`env/prod.json` is gitignored and holds **public** values only (Supabase URL,
publishable key, site URL, OneSignal app id). A build without it shows a "no
server configuration" screen.

`pubspec.yaml` `version: x.y.z+<code>` must match `Env.versionCode`
(`lib/config/env.dart`), which is sent as `x-client: deligro-rider-flutter/<code>`
and to `/api/app-version?app=rider`.

## Brand assets

```powershell
node apps/rider/tool/brand.mjs        # from the repo root; uses the site's sharp
cd apps/rider
dart run flutter_launcher_icons
dart run flutter_native_splash:create
```

Release builds dropped WebP assets, so artwork is PNG/JPEG only. R8 needs the
keep rules in `android/app/proguard-rules.pro` (shared_preferences over JNI);
always smoke-test the **release** APK.
