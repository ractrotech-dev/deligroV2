package com.ractrotech.deligro.rider

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Rings until somebody deals with the order. A Kotlin port of the Capacitor
 * apps' mobile/native/RingService.java (and the Partner app's copy of it):
 *
 *  - started by [RingNotificationExtension] when a push carries ring=start
 *    (src/lib/alerts/ring.ts), or by the open board through MainActivity's
 *    "deligro/ring" channel;
 *  - one timeout per ring id (the push's own timeoutSec, 1..600 s) - two
 *    orders ring once and stop only when both are handled - and it stops on
 *    ring=stop or when the last timeout runs out;
 *  - plays on the ALARM stream, so a phone on silent still rings;
 *  - FCM does not order messages: a stop is remembered for a while and a
 *    start the server sent before it is ignored;
 *  - a ring nobody answered leaves an "order still waiting" notification;
 *  - the sound and vibration switches in Settings (prefs ring_sound and
 *    ring_vibrate, default on) quiet a ring, except while the offer is held
 *    for this rider (the `held` flag, true unless the sender says otherwise).
 *
 * lib/core/ring.dart carries the same rules in Dart and test/ring_test.dart
 * checks the two still name the same things.
 */
class RingService : Service() {
    /** What one ring is allowed to play. */
    private data class Mode(val sound: Boolean, val vibrate: Boolean)

    private val active = HashMap<String, Runnable>()
    private val modes = HashMap<String, Mode>()
    private val texts = HashMap<String, Array<String>>()
    private var lastStartId = 0
    private val handler = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var wake: PowerManager.WakeLock? = null

    private val attrs: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    companion object {
        const val CHANNEL = "deligro_ring"
        const val NOTIF_ID = 4711
        const val MISSED_ID = 4712
        const val MISSED_CHANNEL = "deligro_missed"
        private const val STOPPED_PREFS = "deligro_ring_stopped"

        /** The app's own switches: Flutter's shared_preferences file and key prefix. */
        private const val APP_PREFS = "FlutterSharedPreferences"
        private const val PREF_SOUND = "flutter.ring_sound"
        private const val PREF_VIBRATE = "flutter.ring_vibrate"

        /** Set on the notification's intent; MainActivity hands it to the app. */
        const val EXTRA_ROUTE = "deligro_route"
        const val ROUTE_JOBS = "/jobs"

        /** Longer than any ring's timeout (ring.ts clamps to 600 s). */
        private const val STOPPED_TTL_MS = 15 * 60 * 1000L

        private fun appPrefs(ctx: Context): SharedPreferences =
            ctx.applicationContext.getSharedPreferences(APP_PREFS, Context.MODE_PRIVATE)

        private fun soundOn(ctx: Context): Boolean = appPrefs(ctx).getBoolean(PREF_SOUND, true)

        private fun vibrateOn(ctx: Context): Boolean = appPrefs(ctx).getBoolean(PREF_VIBRATE, true)

        /**
         * True when the ring is handled: started, or deliberately not started
         * because this order was already stopped. False when Android refused,
         * or the rider silenced both sound and vibration for a ring that is not
         * held for them - the caller should then let the ordinary notification
         * show.
         */
        fun start(
            ctx: Context, ringId: String?, title: String?, body: String?,
            timeoutSec: Int, sentAt: Long, held: Boolean = true,
        ): Boolean {
            if (ringId.isNullOrEmpty()) return false
            if (stoppedAfter(ctx, ringId, sentAt)) return true
            if (!held && !soundOn(ctx) && !vibrateOn(ctx)) return false
            val i = Intent(ctx, RingService::class.java).setAction("start")
                .putExtra("ringId", ringId).putExtra("title", title).putExtra("body", body)
                .putExtra("timeoutSec", timeoutSec).putExtra("sentAt", sentAt).putExtra("held", held)
            return try {
                ContextCompat.startForegroundService(ctx, i) != null
            } catch (refused: Exception) {
                // ForegroundServiceStartNotAllowedException (Android 12+) and kin.
                false
            }
        }

        /** [sentAt]: the stop's server time, or 0 for a stop made on this phone. */
        fun stop(ctx: Context, ringId: String?, sentAt: Long) {
            if (!ringId.isNullOrEmpty() && ringId != "*") {
                if (sentAt > 0) rememberStopped(ctx, ringId, sentAt)
                (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(ringId, MISSED_ID)
            }
            try {
                ctx.startService(Intent(ctx, RingService::class.java).setAction("stop").putExtra("ringId", ringId))
            } catch (notRunning: IllegalStateException) {
                // Not ringing, and the app is in the background: nothing to stop.
            }
        }

        private fun stoppedPrefs(ctx: Context): SharedPreferences =
            ctx.applicationContext.getSharedPreferences(STOPPED_PREFS, Context.MODE_PRIVATE)

        /** Stored as "<stop sentAt>|<expiry on this phone's clock>"; expired entries are pruned. */
        private fun rememberStopped(ctx: Context, ringId: String, sentAt: Long) {
            val prefs = stoppedPrefs(ctx)
            val now = System.currentTimeMillis()
            val ed = prefs.edit()
            for ((k, v) in prefs.all) if (expiryOf(v) < now) ed.remove(k)
            // A stop never moves an older stop backwards.
            val known = try {
                prefs.getString(ringId, null)?.split("|")?.get(0)?.toLong() ?: 0L
            } catch (e: Exception) {
                0L
            }
            ed.putString(ringId, "${maxOf(sentAt, known)}|${now + STOPPED_TTL_MS}").apply()
        }

        private fun expiryOf(v: Any?): Long = try {
            v.toString().split("|")[1].toLong()
        } catch (e: Exception) {
            0L
        }

        /** True when this start was sent before (or with) a stop we already received. */
        private fun stoppedAfter(ctx: Context, ringId: String, startSentAt: Long): Boolean {
            if (startSentAt <= 0) return false
            val v = stoppedPrefs(ctx).getString(ringId, null) ?: return false
            if (expiryOf(v) < System.currentTimeMillis()) return false
            return try {
                v.split("|")[0].toLong() >= startSentAt
            } catch (e: Exception) {
                false
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        val action = intent?.action ?: ""
        val ringId = intent?.getStringExtra("ringId") ?: ""

        when (action) {
            "start" -> {
                val title = intent?.getStringExtra("title")?.takeIf { it.isNotEmpty() } ?: "Deligro Rider"
                val body = intent?.getStringExtra("body") ?: ""
                // Always first: this command came through startForegroundService,
                // and returning without startForeground() crashes the app.
                val n = build(title, body)
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
                } else {
                    startForeground(NOTIF_ID, n)
                }
                if (ringId.isEmpty() || stoppedAfter(this, ringId, intent?.getLongExtra("sentAt", 0L) ?: 0L)) {
                    if (active.isEmpty()) finish()
                    return START_NOT_STICKY
                }
                val timeoutSec = (intent?.getIntExtra("timeoutSec", 180) ?: 180).coerceIn(1, 600)
                val held = intent?.getBooleanExtra("held", true) ?: true
                active.remove(ringId)?.let { handler.removeCallbacks(it) }
                val timeout = Runnable {
                    postMissed(ringId)
                    remove(ringId)
                }
                active[ringId] = timeout
                modes[ringId] = Mode(sound = held || soundOn(this), vibrate = held || vibrateOn(this))
                texts[ringId] = arrayOf(title, body)
                handler.postDelayed(timeout, timeoutSec * 1000L)
                applyOutput()
            }
            "stop" -> {
                if (ringId == "*") {
                    for (r in active.values) handler.removeCallbacks(r)
                    active.clear()
                    modes.clear()
                    texts.clear()
                    finish()
                } else {
                    remove(ringId)
                }
            }
            else -> if (active.isEmpty()) finish()
        }
        return START_NOT_STICKY
    }

    private fun remove(ringId: String) {
        active.remove(ringId)?.let { handler.removeCallbacks(it) }
        modes.remove(ringId)
        texts.remove(ringId)
        if (active.isEmpty()) finish() else applyOutput()
    }

    /** Nobody answered: leave a plain notification so the order is not lost. */
    private fun postMissed(ringId: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(MISSED_CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(MISSED_CHANNEL, "Orders still waiting", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        val t = texts[ringId]
        val detail = if (t == null) "" else t[0] + (if (t[1].isEmpty()) "" else " - " + t[1])
        nm.notify(
            ringId, MISSED_ID,
            NotificationCompat.Builder(this, MISSED_CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_ring)
                .setContentTitle("Order still waiting")
                .setContentText(detail)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(openApp())
                .build()
        )
    }

    /** Plays and vibrates for as long as at least one ring is allowed to. */
    private fun applyOutput() {
        val wantSound = modes.values.any { it.sound }
        val wantVibrate = modes.values.any { it.vibrate }
        if (wantSound) startSound() else stopSound()
        if (wantVibrate) startVibration() else stopVibration()
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        if (pm != null && wake == null) {
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "deligro:ring").apply { acquire(10 * 60 * 1000L) }
        }
    }

    private fun startSound() {
        if (player != null) return
        try {
            val uri: Uri = Uri.parse("android.resource://$packageName/${R.raw.deligro_ring}")
            player = MediaPlayer().apply {
                setAudioAttributes(attrs)
                try {
                    setDataSource(this@RingService, uri)
                } catch (missing: Exception) {
                    setDataSource(this@RingService, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
                }
                isLooping = true
                prepare()
                start()
            }
        } catch (e: Exception) {
            player = null // vibration and the notification still go ahead
        }
    }

    private fun startVibration() {
        if (vibrator != null) return
        @Suppress("DEPRECATION")
        vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        if (Build.VERSION.SDK_INT >= 26) {
            vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 600), 0), attrs)
        }
    }

    /**
     * Nothing left to ring for. The sound always stops; the service itself stops
     * only if no newer start is queued - stopping past one would kill it before
     * that start's startForeground() and crash the app.
     */
    private fun finish() {
        stopEverything()
        if (stopSelfResult(lastStartId)) {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun stopSound() {
        player?.let {
            try {
                it.stop()
            } catch (ignored: Exception) {
            }
            it.release()
        }
        player = null
    }

    private fun stopVibration() {
        vibrator?.cancel()
        vibrator = null
    }

    private fun stopEverything() {
        stopSound()
        stopVibration()
        wake?.let { if (it.isHeld) it.release() }
        wake = null
    }

    private fun openApp(): PendingIntent {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        launch.putExtra(EXTRA_ROUTE, ROUTE_JOBS)
        return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun build(title: String, body: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            val ch = NotificationChannel(CHANNEL, "New orders (ringing)", NotificationManager.IMPORTANCE_HIGH)
            ch.setSound(null, null) // MediaPlayer plays the ring
            ch.enableVibration(false) // and the Vibrator vibrates
            ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            ch.setBypassDnd(true)
            nm.createNotificationChannel(ch)
        }
        val open = openApp()
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ring)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .build()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        stopEverything()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
