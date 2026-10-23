# Deligro Rider (Flutter)

Native Rider app for Deligro, version **2.0.0 (versionCode 3)**. It replaces the
Capacitor rider shell in `mobile/` (`com.ractrotech.deligro.rider`, versionCode 2)
and installs as an update to it. It talks to the website's `/api/rider/*` routes
and the live Supabase project. It was copied from `apps/customer` and adapted;
the two apps share no package. English only.

Machine setup: [`docs/FLUTTER_SETUP.md`](../../docs/FLUTTER_SETUP.md).
Owner steps (migrations, settings, signing, release): [`docs/rider-app-handover.md`](../../docs/rider-app-handover.md).

## The env file

The app reads its server settings at build time from `env/prod.json`:

```json
{
  "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
  "SUPABASE_ANON_KEY": "sb_publishable_...",
  "SITE_URL": "https://deligrodelivery.ractrotech.com",
  "ONESIGNAL_APP_ID": ""
}
```

- Copy `env/example.json` to `env/prod.json` and fill it in. The customer app's
  `apps/customer/env/prod.json` has the same values.
- It holds **public** values only: the publishable key, never the service-role key.
- `env/*.json` is gitignored (only `example.json` is committed).
- A build without it opens on a "no server configuration" screen.
- For a staging build, make `env/staging.json` with the staging project's values
  and pass that file instead.

## Run and build

From `apps/rider`, in PowerShell. On this PC, keep Gradle and temp files off C:
(see `docs/FLUTTER_SETUP.md`):

```powershell
$env:GRADLE_USER_HOME='F:\dev\gradle-home'; $env:PUB_CACHE='F:\dev\pub-cache'
$env:TEMP='F:\dev\tmp'; $env:TMP='F:\dev\tmp'; $env:JAVA_TOOL_OPTIONS='-Djava.io.tmpdir=F:\dev\tmp'

flutter pub get
flutter run --dart-define-from-file=env/prod.json                       # debug, on a phone or emulator
flutter build apk --release --dart-define-from-file=env/prod.json      # release, R8 on
```

The APK lands in `build/app/outputs/flutter-apk/app-release.apk`.

### Signing

Release signing reads `android/key.properties`, which is gitignored:

```properties
storeFile=C:/Users/<you>/deligro-keys/deligro-release.jks
storePassword=...
keyAlias=rider
keyPassword=...
```

- Use the **`rider` alias of `deligro-release.jks`**, the key the Capacitor rider
  app was signed with. With any other key Android refuses the update.
- Without `key.properties` the release build is signed with the debug key. That
  APK is fine for testing on a phone, but it cannot update the installed app.

### Versions

- `version: 2.0.0+3` in `pubspec.yaml` must match `Env.versionCode` (`lib/config/env.dart`).
  The app sends it as `x-client: deligro-rider-flutter/<code>` and asks
  `/api/app-version?app=rider` about it.
- Also bump the rider entry in `mobile/roles.json`. It is marked `"build": "flutter"`,
  so `mobile/scripts/build-apk.mjs` no longer builds a rider Capacitor shell.
- After shipping, raise `rider_apk_version_code` (and `min_version_code`, to force
  the update) and the download URL in Admin → Settings.

### Release pitfalls (from the customer app)

- R8 strips `shared_preferences` (it calls Kotlin over JNI) unless the keep rules in
  `android/app/proguard-rules.pro` are present. Without them the release app hangs
  on the splash. Keep that file.
- WebP assets did not render in a release build. Artwork is PNG or JPEG only.
- Always smoke-test the **release** APK on a phone or emulator. Tests and analyze
  passing is not enough.

## Fixtures (debug builds only)

The app can run over in-memory fixture data instead of the website, so screens
can be seen without a server or a rider account:

```powershell
flutter run -t tool/jobs_preview.dart --dart-define=FIXTURES=true
```

- `FIXTURES=true` works **only in debug and profile builds**. `fixturesEnabled`
  is `bool.fromEnvironment('FIXTURES') && !kReleaseMode`, and the fixture
  backends also refuse to start in release mode. A release build drops the
  fixture code completely.
- Each screen area has a preview entry point under `tool/`, with its options
  in the file's header:
  - `jobs_preview.dart`: offers, the active delivery and every status.
  - `insights_preview.dart`: Home, History and Performance.
  - `earnings_preview.dart`: Earnings.
  - `cash_preview.dart`: Cash.
  - `profile_preview.dart`: Profile and documents.
  - `support_preview.dart`: Help, notifications and Safety.
  - `settings_preview.dart`: Settings.
- Dark mode: add `--dart-define=PREVIEW_DARK=true`.

**Release check**: after each release build, confirm no fixture data is in the binary.
Every ABI should report 0 for a fixture string and at least 1 for a control string:

```bash
unzip -o build/app/outputs/flutter-apk/app-release.apk 'lib/*/libapp.so' -d /tmp/rider-apk
for so in /tmp/rider-apk/lib/*/libapp.so; do
  echo "$so fixture=$(grep -c -a 'Sharma Sweets' "$so") control=$(grep -c -a 'Request manual check' "$so")"
done
```

## Tests

```powershell
flutter analyze
flutter test
```

- Run them from `apps/rider`.
- `test/no_hindi_test.dart` fails on any Devanagari text or language switch.
  The rider app is English only.
- `test/text_scale_test.dart` opens every screen at 1.3× text on a 360×720
  surface, in light and dark, and fails on any overflow.
- The whole project's checks run from the repo root with `bash scripts/qa/rider-run-all.sh`.
  It covers the server QA scripts, the database proofs, and both Flutter apps'
  analyze and test.

## Brand assets

```powershell
node apps/rider/tool/brand.mjs        # from the repo root; uses the site's sharp
cd apps/rider
dart run flutter_launcher_icons
dart run flutter_native_splash:create
```

`node apps/rider/tool/ring_sound.mjs` regenerates the order-ring sound.
