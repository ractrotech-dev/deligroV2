# shared_preferences_android 2.5 calls its Kotlin API from Dart over JNI and
# ships no keep rules, so R8 strips SharedPreferencesApiRegistrar.getAll & co.
# The release app then hangs on the splash (main() awaits SharedPreferences).
-keep class io.flutter.plugins.sharedpreferences.** { *; }
# package:jni names these Kotlin types when it calls suspend funs (Continuation,
# intrinsics.CoroutineSingletons/IntrinsicsKt), so they must keep their names too.
-keep class kotlin.coroutines.** { *; }
-keep class kotlin.Result { *; }
-keep class kotlin.Result$Failure { *; }
-keep class kotlin.Unit { *; }
-keep class kotlin.enums.EnumEntries { *; }
-keep class kotlin.jvm.internal.DefaultConstructorMarker { *; }

# Razorpay checkout (razorpay_flutter) — from Razorpay's Android integration guide.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
-keepattributes *Annotation*
-dontwarn com.razorpay.**
-keep class com.razorpay.** {*;}
-optimizations !method/inlining/*
-keepclasseswithmembers class * {
  public void onPayment*(...);
}
