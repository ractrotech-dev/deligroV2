# Deligro — Flutter development environment

How to get a machine ready to build Android apps with Flutter, from nothing.
Follow it top to bottom on any new PC. It is written for **Windows 10/11**;
macOS/Linux notes are at the end.

Last verified: 2026-10-07 on Windows 11, Flutter stable, JDK 21, Android SDK 35/36.
A fresh test app built a 42 MB release APK with `flutter build apk --release`
in about 7.5 minutes (first build, including downloads).

---

## 0. Before you start

- About **15 GB** of free disk space. Install everything on a drive with room;
  the layout below uses `F:\dev`. Use `C:\dev` if C: has space. Keep the same
  layout on every machine so these steps stay copy-pasteable.
- You do **not** need administrator rights for anything below except step 6.
- **Do not install Android Studio** unless you want an emulator or its UI. The
  command-line setup below is enough to build APKs, and much smaller.

## 1. Folder layout

```
F:\dev\
  flutter\          Flutter SDK (git clone, stable branch)
  jdk-21\           JDK 21 (Eclipse Temurin, unzipped)
  android-sdk\      Android SDK (command-line tools + platforms)
```

## 2. Install the pieces (PowerShell)

```powershell
mkdir F:\dev; cd F:\dev

# Flutter SDK
git clone --depth 1 -b stable https://github.com/flutter/flutter.git flutter

# JDK 21
curl.exe -L -o jdk21.zip "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse"
Expand-Archive jdk21.zip _jdk; Move-Item (Get-ChildItem _jdk -Directory)[0].FullName jdk-21; Remove-Item _jdk, jdk21.zip -Recurse

# Android command-line tools (must end up in android-sdk\cmdline-tools\latest)
curl.exe -L -o cmd.zip "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
mkdir android-sdk\cmdline-tools
Expand-Archive cmd.zip _cmd; Move-Item _cmd\cmdline-tools android-sdk\cmdline-tools\latest; Remove-Item _cmd, cmd.zip -Recurse
```

If the Google link has moved, get the current "Command line tools only" Windows
zip from <https://developer.android.com/studio#command-line-tools-only>. The
folder structure above is what matters.

## 3. Environment variables (per user, no admin)

```powershell
[Environment]::SetEnvironmentVariable('JAVA_HOME',        'F:\dev\jdk-21',      'User')
[Environment]::SetEnvironmentVariable('ANDROID_HOME',     'F:\dev\android-sdk', 'User')
[Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', 'F:\dev\android-sdk', 'User')

$p = [Environment]::GetEnvironmentVariable('Path','User')
$p += ';F:\dev\flutter\bin;F:\dev\jdk-21\bin;F:\dev\android-sdk\cmdline-tools\latest\bin;F:\dev\android-sdk\platform-tools'
[Environment]::SetEnvironmentVariable('Path',$p,'User')
```

**Close and reopen your terminal and VS Code** so the new variables load.

## 4. Android SDK packages and licences

```powershell
sdkmanager --licenses            # answer y to each
sdkmanager "platform-tools" "platforms;android-36" "platforms;android-35" "build-tools;35.0.0"
```

Gradle may also install `build-tools;36.0.0` by itself during the first build.
That is normal, so do not stop it.

## 5. Point Flutter at them and check

```powershell
flutter config --android-sdk F:\dev\android-sdk --jdk-dir F:\dev\jdk-21 --no-analytics
flutter doctor --android-licenses
flutter doctor -v
```

`flutter doctor` should show a green tick for **Flutter**, **Android toolchain**
and **Network resources** (plus **VS Code** once step 7 is done). One line is
expected to stay red, and is fine for building APKs:

- *Visual Studio* — only needed to build Windows desktop apps. Ignore it.

Verified output on 2026-10-07: Flutter 3.47.6, Dart 3.13.5, Android SDK
platform 36 with build-tools 35.0.0, Temurin JDK 21.0.12.

## 6. Developer Mode (needs admin, once per machine)

Flutter plugins use symbolic links, and Windows blocks them by default.

1. Press **Win + I** → **System** → **For developers** (or **Privacy & security → For developers**).
2. Turn **Developer Mode** on.

Without it, `flutter pub get` fails with *"Building with plugins requires symlink support."*

## 7. VS Code

Install the extensions **Flutter** (also installs Dart). Then open the
command palette → *Flutter: Run Flutter Doctor* to confirm.

## 8. Run on a real phone

1. On the phone: **Settings → About phone** → tap *Build number* 7 times.
2. **Settings → Developer options → USB debugging** on.
3. Plug in by USB, accept the prompt on the phone.
4. `adb devices` should list it, then `flutter devices`, then `flutter run`.

---

## Building an APK

```powershell
cd <flutter app folder>
flutter pub get
flutter build apk --release            # one fat APK
flutter build apk --release --split-per-abi   # smaller, one per CPU type
```

Output: `build\app\outputs\flutter-apk\`.

The first build downloads Gradle and the Android build libraries (a few GB, 10+
minutes). Later builds are fast. Keep the internet on for that first one.

## Deligro-specific rules (read before the first release)

These come from how the current apps ship. Breaking them stops existing users
from updating.

1. **Keep the same application IDs.** The current Capacitor apps are
   `com.ractrotech.deligro` (customer), `.partner` (vendor), `.rider`,
   `.manager`. A Flutter app with a different ID installs as a *second* app
   instead of updating the old one.
2. **Sign with the same release keystore** (`deligro-release.jks`, one alias per
   role). A different key makes Android refuse the update. **Back the keystore
   up** in at least two places. Losing it means no installed app can ever be
   updated.
3. **`versionCode` must be higher than the installed app's.** Current values are
   in `mobile/roles.json` (customer 1, vendor 2, rider 2, manager 1).
4. **Never commit the keystore or its passwords.** Pass them through
   `android/key.properties` (add it to `.gitignore`) or environment variables.
5. **Backend is the same.** The apps talk to the live Supabase project and the
   site at `https://deligrodelivery.ractrotech.com`. See `SECURITY.md` and
   `docs/` for what the API enforces. Use the public anon key only. The
   service-role key never goes in a mobile app.
6. **Push notifications and order ringing** (vendor and rider) are native
   features in the Capacitor apps (`mobile/native/RingService.java`,
   `DeligroNotificationExtension.java`, OneSignal). A Flutter rebuild has to
   re-create these. This is the largest piece of native work.
7. **Use the live database carefully.** `.env.local` and any dev build point at
   production unless you create a separate Supabase project for development.

## Starting a new app

```powershell
flutter create --org com.ractrotech --project-name deligro_customer deligro_customer
```

Then change `applicationId` in `android/app/build.gradle(.kts)` to the existing
ID from rule 1 *before* the first release build.

## Common problems

| Symptom | Fix |
| --- | --- |
| `flutter` not recognised | Reopen the terminal after step 3. |
| *Building with plugins requires symlink support* | Step 6, Developer Mode. |
| *Android licenses not accepted* | `flutter doctor --android-licenses`, answer `y`. |
| *Unable to locate Android SDK* | `flutter config --android-sdk F:\dev\android-sdk` |
| Gradle: *Unsupported class file major version* | Wrong JDK. `java -version` must say 21; check `JAVA_HOME`. |
| `cmdline-tools component is missing` | The folder must be exactly `android-sdk\cmdline-tools\latest\bin`. |
| Build is very slow or runs out of disk | Free space on the drive holding `%USERPROFILE%\.gradle` (Gradle cache) and the project. |
| Phone not listed by `adb devices` | Re-plug, set USB mode to *File transfer*, accept the prompt, install the phone's USB driver. |

## Moving to another PC

Everything in this file is repeatable. Machine-specific things that do **not**
travel with the repo, so copy or re-create them:

- the release keystore and its passwords (store them in a password manager);
- `.env.local` files;
- your OneSignal app ID.

## macOS / Linux notes

- Same idea: Flutter from git, JDK 21, Android command-line tools in
  `$ANDROID_HOME/cmdline-tools/latest`, then `sdkmanager` and `flutter doctor`.
- Export `JAVA_HOME`, `ANDROID_HOME` and the `PATH` entries in your shell profile.
- iOS builds need a Mac with Xcode and a paid Apple Developer account. They are
  not covered here.
