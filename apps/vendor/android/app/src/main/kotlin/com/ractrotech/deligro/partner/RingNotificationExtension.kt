package com.ractrotech.deligro.partner

import com.onesignal.notifications.INotificationReceivedEvent
import com.onesignal.notifications.INotificationServiceExtension

/**
 * Turns a ring payload (src/lib/alerts/ring.ts) into RingService start/stop,
 * even when the app is closed. Registered in the manifest as
 * com.onesignal.NotificationServiceExtension. A Kotlin port of
 * mobile/native/DeligroNotificationExtension.java; any push without "ring"
 * is left alone and shows as normal.
 */
class RingNotificationExtension : INotificationServiceExtension {
    override fun onNotificationReceived(event: INotificationReceivedEvent) {
        val n = event.notification
        val data = n.additionalData ?: return
        val ring = data.optString("ring", "")
        val ringId = data.optString("ringId", "")
        if (ringId.isEmpty()) return

        when (ring) {
            // Suppress OneSignal's notification only once the ring is really
            // going (RingService shows its own). If Android refused the
            // foreground start — common on budget phones in a restricted
            // battery bucket — the ordinary high-priority notification still
            // shows, which is far better than nothing.
            "start" -> if (RingService.start(
                    event.context, ringId, n.title, n.body,
                    data.optInt("timeoutSec", 180), data.optLong("sentAt", 0L)
                )
            ) {
                event.preventDefault()
            }
            "stop" -> {
                event.preventDefault()
                RingService.stop(event.context, ringId, data.optLong("sentAt", 0L))
            }
        }
    }
}
