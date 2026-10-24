import 'package:flutter/services.dart';

/// Posts a local notification drawn by the same renderer the pushes use, so a
/// card layout can be checked on a device without sending a real push.
class DeligroPushStyle {
  static const _channel = MethodChannel('deligro/push_style');

  static Future<void> showSample({
    required int id,
    required String title,
    required String body,
    required Map<String, dynamic> card,
  }) =>
      _channel.invokeMethod<void>('showSample', {'id': id, 'title': title, 'body': body, 'card': card});
}
