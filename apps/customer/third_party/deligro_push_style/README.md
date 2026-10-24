# deligro_push_style

Android-only. Turns a push's `data.card` (see `src/lib/notifications/push-card.ts`)
into a custom notification layout: ETA tile, progress bar, delivery code tiles,
stat tiles, item lines, pickup/drop route. A push without `card` shows as a
normal notification.

Each app has one OneSignal `NotificationServiceExtension`. That class calls
`PushStyle.extend(event)`; the rider and partner apps do it after their ring
handling (`RingNotificationExtension`), the customer and manager apps have a
small extension of their own.

`DeligroPushStyle.showSample(...)` posts a local notification through the same
renderer, for checking a layout on a device without sending a push.
