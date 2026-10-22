package com.ractrotech.deligro.rider

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Hosts the "deligro/ring" channel (lib/core/ring.dart), a port of the
 * Capacitor DeligroPushPlugin's ring methods:
 *   start / stop      - the open board rings for an offer it can see held
 *   setup             - what stands between this phone and a ring that wakes it
 *   openSettings      - the system screen that fixes one of those
 *   takeLaunchRoute   - the screen a tap on the ringing notification asked for
 */
class MainActivity : FlutterActivity() {
    /** Where the notification that opened the app wants it to go; read once. */
    private var launchRoute: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        launchRoute = intent?.getStringExtra(RingService.EXTRA_ROUTE)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(RingService.EXTRA_ROUTE)?.let { launchRoute = it }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "deligro/ring").setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    val ringId = call.argument<String>("ringId")
                    // sentAt 0: the board only starts rings for offers it can see
                    // held right now, so an earlier stop must not suppress it.
                    val ok = RingService.start(
                        this, ringId, call.argument("title"), call.argument("body"),
                        call.argument<Int>("timeoutSec") ?: 180, 0L,
                        call.argument<Boolean>("held") ?: true
                    )
                    result.success(ok)
                }
                "stop" -> {
                    RingService.stop(this, call.argument<String>("ringId") ?: "*", 0L)
                    result.success(true)
                }
                "setup" -> result.success(setup(this))
                "openSettings" -> {
                    openSettings(this, call.argument<String>("which") ?: "notifications")
                    result.success(true)
                }
                "takeLaunchRoute" -> {
                    val route = launchRoute
                    launchRoute = null
                    intent?.removeExtra(RingService.EXTRA_ROUTE)
                    result.success(route)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun setup(ctx: Context): Map<String, Any> {
        var fullScreen = true
        if (Build.VERSION.SDK_INT >= 34) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            fullScreen = nm?.canUseFullScreenIntent() == true
        }
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return mapOf(
            "notifications" to NotificationManagerCompat.from(ctx).areNotificationsEnabled(),
            "fullScreen" to fullScreen,
            "batteryUnrestricted" to (pm?.isIgnoringBatteryOptimizations(ctx.packageName) == true),
            "manufacturer" to Build.MANUFACTURER,
        )
    }

    private fun openSettings(ctx: Context, which: String) {
        val pkg = Uri.parse("package:${ctx.packageName}")
        if (which == "autostart") {
            openAutostart(ctx, pkg)
            return
        }
        val i = when {
            which == "channel" && Build.VERSION.SDK_INT >= 26 -> {
                // The channel may not exist yet if nothing has rung on this phone.
                (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.let { RingService.ensureChannel(it) }
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, RingService.CHANNEL)
            }
            which == "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
            which == "fullScreen" && Build.VERSION.SDK_INT >= 34 -> Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg)
            else -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            ctx.startActivity(i)
        } catch (e: Exception) {
            ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    /**
     * The maker's own Autostart screen, where one exists; otherwise the app's
     * details page. These activities are not public API and move between OS
     * versions, so each is tried in turn.
     */
    private fun openAutostart(ctx: Context, pkg: Uri) {
        val screens = arrayOf(
            arrayOf("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            arrayOf("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
            arrayOf("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
            arrayOf("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
            arrayOf("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
        )
        for (c in screens) {
            try {
                ctx.startActivity(Intent().setClassName(c[0], c[1]).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (ignored: Exception) {
                // not this maker / not this OS version
            }
        }
        ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
