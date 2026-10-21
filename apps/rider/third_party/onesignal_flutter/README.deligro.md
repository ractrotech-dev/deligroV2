# Vendored onesignal_flutter 5.7.1

Upstream: https://pub.dev/packages/onesignal_flutter (Modified MIT, see LICENSE).

The only change is in `android/build.gradle`. Upstream pins
`com.android.tools.build:gradle:7.0.0` in a `buildscript` block. Under Flutter
3.47's AGP 9 that second AGP gets its own classloader, and the Kotlin Gradle
plugin that Flutter applies to every plugin then fails with
"'kotlin-android' plugin requires one of the Android Gradle plugins". So the
block was removed, and the deprecated `lintOptions` became `lint`.

Used through `dependency_overrides` in the app's pubspec.yaml. When upstream
ships a build file that works on AGP 9, delete this folder and the override.
