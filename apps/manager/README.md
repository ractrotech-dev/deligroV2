# Deligro Manager (Flutter)

The operations app for Deligro city managers: dashboard, orders, live
operations, vendors, riders, finance, marketing, support, reports and alerts,
within the zones and permissions an admin grants. It replaces the Capacitor
Manager shell (`mobile/`, versionCode 1) and installs as an **update** to it.

Design: [`docs/superpowers/specs/2026-10-21-manager-app-design.md`](../../docs/superpowers/specs/2026-10-21-manager-app-design.md).
Machine setup: [`docs/FLUTTER_SETUP.md`](../../docs/FLUTTER_SETUP.md).

## Run and build

```powershell
cd apps/manager
copy env\example.json env\prod.json        # then fill in the Supabase values
flutter pub get
flutter run --dart-define-from-file=env/prod.json
flutter build apk --release --dart-define-from-file=env/prod.json
```

On this PC (C: is nearly full) set `GRADLE_USER_HOME=F:\dev\gradle-home`,
`TEMP`/`TMP=F:\dev\tmp` and `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=F:\dev\tmp`
first.

`env/prod.json` is gitignored and holds **public** values only.

## Rules that matter

- `applicationId` is `com.ractrotech.deligro.manager`, the Capacitor Manager
  app's, and release builds must be signed with the `manager` alias of
  `deligro-release.jks` (`android/key.properties`, gitignored) or Android
  refuses the update. Without it the release falls back to debug keys.
- `pubspec.yaml` `version` and `lib/config/env.dart` `versionCode` move
  together; publish a new build on the `manager` track in Admin → Settings.
- Release R8 keep rules (`android/app/proguard-rules.pro`) are required:
  without them `shared_preferences` is stripped and the app hangs on the splash.
- Brand art is PNG/JPEG only — WebP did not render in release builds.
- Every call goes through `/api/manager/*` on the website; the server decides
  zones and permissions. The app hides what it may not show, but never
  decides access.
