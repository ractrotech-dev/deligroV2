package com.ractrotech.deligro.rider

import com.onesignal.notifications.INotificationReceivedEvent
import com.onesignal.notifications.INotificationServiceExtension
import com.ractrotech.deligro.pushstyle.PushStyle

/**
 * Turns a ring payload (src/lib/alerts/ring.ts: ring, ringId, timeoutSec,
 * sentAt) into RingService start/stop, even when the app is closed. Registered
 * in the manifest as com.onesignal.NotificationServiceExtension. A Kotlin port
 * of mobile/native/DeligroNotificationExtension.java; any push without "ring"
 * is left alone and shows as normal.
 *
 * An optional `held` (default true) says whether the order is held for this
 * rider. Held rings ignore the sound and vibration switches in Settings; a
 * sender that wants a quieter heads-up sends held=false.
 */
class RingNotificationExtension : INotificationServiceExtension {
    override fun onNotificationReceived(event: INotificationReceivedEvent) {
        val n = event.notification
        val data = n.additionalData ?: return
        val ring = data.optString("ring", "")
        val ringId = data.optString("ringId", "")
        // Not a ring: an ordinary push, drawn as a card when it carries one.
        if (ringId.isEmpty()) {
            PushStyle.extend(event)
            return
        }
        // Every Deligro app shares one OneSignal app, so a ring addressed to
        // another role can reach this phone (a kitchen's ring on a phone signed in
        // to the same account, or through a stale subscription id). Only this
        // app's own rings (`rider:<orderId>`, and the Settings test ring) are
        // rung; anyone else's is not for this app and is not shown at all.
        if (!ringId.startsWith("rider:") && !ringId.startsWith("test:")) {
            event.preventDefault()
            return
        }

        when (ring) {
            // Suppress OneSignal's notification only once the ring is really
            // going (RingService shows its own). If Android refused the
            // foreground start - common on budget phones in a restricted
            // battery bucket - the ordinary high-priority notification still
            // shows, which is far better than nothing.
            "start" -> if (RingService.start(
                    event.context, ringId, n.title, n.body,
                    data.optInt("timeoutSec", 180), data.optLong("sentAt", 0L),
                    data.optBoolean("held", true)
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
