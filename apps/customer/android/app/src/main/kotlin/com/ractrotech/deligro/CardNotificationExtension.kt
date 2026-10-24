package com.ractrotech.deligro

import com.onesignal.notifications.INotificationReceivedEvent
import com.onesignal.notifications.INotificationServiceExtension
import com.ractrotech.deligro.pushstyle.PushStyle

/**
 * Registered in the manifest as com.onesignal.NotificationServiceExtension.
 * Pushes with a `card` are drawn by deligro_push_style; the rest show as normal.
 */
class CardNotificationExtension : INotificationServiceExtension {
    override fun onNotificationReceived(event: INotificationReceivedEvent) {
        PushStyle.extend(event)
    }
}
