package com.ractrotech.deligro.partner

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
 * Partner app's mobile/native/RingService.java, same behaviour:
 *
 *  - started by [RingNotificationExtension] when a push carries ring=start
 *    (src/lib/alerts/ring.ts), or by the open board through MainActivity's
 *    "deligro/ring" channel;
 *  - one timeout per ring id — two orders ring once and stop only when both
 *    are handled — and it stops on ring=stop or when the last timeout runs out;
 *  - plays on the ALARM stream, so a kitchen phone on silent still rings;
 *  - FCM does not order messages: a stop is remembered for a while and a
 *    start the server sent before it is ignored;
 *  - a ring nobody answered leaves a "missed order" notification behind.
 */
class RingService : Service() {
    private val active = HashMap<String, Runnable>()
    private val texts = HashMap<String, Array<String>>()
    private var lastStartId = 0
    private val handler = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var wake: PowerManager.WakeLock? = null

    companion object {
        const val CHANNEL = "deligro_ring"
        const val NOTIF_ID = 4711
        const val MISSED_ID = 4712
        // A channel's sound cannot change once created, so the siren needed a
        // new id; the old silent-default channel is deleted when this is made.
        const val MISSED_CHANNEL = "deligro_missed_siren"
        private const val OLD_MISSED_CHANNEL = "deligro_missed"
        private const val STOPPED_PREFS = "deligro_ring_stopped"
        /** Longer than any ring's timeout (ring.ts clamps to 600 s). */
        private const val STOPPED_TTL_MS = 15 * 60 * 1000L

        /**
         * True when the ring is handled: started, or deliberately not started
         * because this order was already stopped. False when Android refused —
         * the caller should then let the ordinary notification show.
         */
        fun start(ctx: Context, ringId: String?, title: String?, body: String?, timeoutSec: Int, sentAt: Long): Boolean {
            if (ringId.isNullOrEmpty()) return false
            if (stoppedAfter(ctx, ringId, sentAt)) return true
            val i = Intent(ctx, RingService::class.java).setAction("start")
                .putExtra("ringId", ringId).putExtra("title", title).putExtra("body", body)
                .putExtra("timeoutSec", timeoutSec).putExtra("sentAt", sentAt)
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
            ed.putString(ringId, "$sentAt|${now + STOPPED_TTL_MS}").apply()
        }

        private fun expiryOf(v: Any?): Long = try {
            v.toString().split("|")[1].toLong()
        } catch (e: Exception) {
            0L
        }

        /** True when this start was sent before a stop we already received. */
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
                val title = intent?.getStringExtra("title")?.takeIf { it.isNotEmpty() } ?: "Deligro Partner"
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
                active.remove(ringId)?.let { handler.removeCallbacks(it) }
                val timeout = Runnable {
                    postMissed(ringId)
                    remove(ringId)
                }
                active[ringId] = timeout
                texts[ringId] = arrayOf(title, body)
                handler.postDelayed(timeout, timeoutSec * 1000L)
                startSound()
            }
            "stop" -> {
                if (ringId == "*") {
                    for (r in active.values) handler.removeCallbacks(r)
                    active.clear()
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
        texts.remove(ringId)
        if (active.isEmpty()) finish()
    }

    /** Nobody answered: leave a plain notification so the order is not lost. */
    private fun postMissed(ringId: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val siren: Uri = Uri.parse("android.resource://$packageName/${R.raw.deligro_ring}")
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(MISSED_CHANNEL) == null) {
            val ch = NotificationChannel(MISSED_CHANNEL, "Orders still waiting", NotificationManager.IMPORTANCE_HIGH)
            ch.setSound(
                siren,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            nm.createNotificationChannel(ch)
            nm.deleteNotificationChannel(OLD_MISSED_CHANNEL)
        }
        val t = texts[ringId]
        val detail = if (t == null) "" else t[0] + (if (t[1].isEmpty()) "" else " — " + t[1])
        nm.notify(
            ringId, MISSED_ID,
            NotificationCompat.Builder(this, MISSED_CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_ring)
                .setContentTitle("ऑर्डर इंतज़ार में · Order still waiting")
                .setContentText(detail)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setSound(siren)
                .setAutoCancel(true)
                .setContentIntent(openApp())
                .build()
        )
    }

    private fun startSound() {
        if (player != null) return
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
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
        @Suppress("DEPRECATION")
        vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        if (Build.VERSION.SDK_INT >= 26) {
            vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 600), 0), attrs)
        }
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        if (pm != null && wake == null) {
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "deligro:ring").apply { acquire(10 * 60 * 1000L) }
        }
    }

    /**
     * Nothing left to ring for. The sound always stops; the service itself stops
     * only if no newer start is queued — stopping past one would kill it before
     * that start's startForeground() and crash the app.
     */
    private fun finish() {
        stopSound()
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
        vibrator?.cancel()
        vibrator = null
        wake?.let { if (it.isHeld) it.release() }
        wake = null
    }

    private fun openApp(): PendingIntent {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
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
        stopSound()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
