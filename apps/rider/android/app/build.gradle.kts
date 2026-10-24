import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing comes from android/key.properties (gitignored) — the same
// deligro-release.jks / "rider" alias the Capacitor app was signed with, or
// Android refuses the update. See docs/FLUTTER_SETUP.md, "Deligro-specific rules".
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

// A release build with no key.properties stops here: a debug-signed APK can
// never update the live app, so it must not be made by accident. To make one
// on purpose (a test phone), pass the Gradle property allowDebugSigning:
//   flutter build apk --release --android-project-arg=allowDebugSigning=true
// (or set ORG_GRADLE_PROJECT_allowDebugSigning=true in the environment).
val allowDebugSigning = (findProperty("allowDebugSigning") as String?)
    ?.let { it.isEmpty() || it.equals("true", ignoreCase = true) } ?: false
gradle.taskGraph.whenReady {
    val release = allTasks.any { t ->
        t.project == project && t.name.endsWith("Release") &&
            (t.name.startsWith("assemble") || t.name.startsWith("bundle") || t.name.startsWith("package"))
    }
    if (release && !keystorePropertiesFile.exists() && !allowDebugSigning) {
        throw GradleException(
            "No android/key.properties: refusing to sign a release with the debug key. " +
                "Add key.properties, or pass -PallowDebugSigning=true " +
                "(flutter: --android-project-arg=allowDebugSigning=true) for a test build.",
        )
    }
}

android {
    namespace = "com.ractrotech.deligro.rider"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Must stay the Capacitor Rider app's ID so this installs as an update.
        applicationId = "com.ractrotech.deligro.rider"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            // Without key.properties the release build uses the debug key, and
            // only when allowDebugSigning is passed (see the check above): fine
            // for testing on a phone, but that APK cannot update the live app.
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = if (keystorePropertiesFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

// The ring's OneSignal extension (RingNotificationExtension.kt) compiles
// against the SDK directly; same version the vendored onesignal_flutter uses.
dependencies {
    implementation("com.onesignal:OneSignal:5.10.2")
    implementation("androidx.core:core-ktx:1.13.1")
}
