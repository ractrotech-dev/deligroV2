import 'package:flutter/foundation.dart';
import 'package:go_router/go_router.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../config/env.dart';
import 'api.dart';
import 'push_routes.dart';
import 'ring.dart';

/// Opens the page a push's data points at. Rider routes only: a url that is
/// not one of this app's pages falls back to the category's page or the inbox.
void openPush(GoRouter router, Map<String, dynamic>? data) {
  final d = data ?? const <String, dynamic>{};
  final path = routeForNotification(
    category: d['category'] as String?,
    url: d['url'] as String?,
    data: d,
    exists: (p) => !router.configuration.findMatch(Uri.parse(p)).isError,
  );
  router.go(path);
}

/// Pushes through OneSignal, targeted by `external_id = profile id`
/// (src/lib/notifications/onesignal.ts). A no-op when no app id is built in.
///
/// A tap on a push opens the page its `data.category` / `data.url` name: jobs,
/// a ticket, earnings, cash, documents or the inbox (see push_routes.dart).
/// (New offers also ring the phone: that happens natively, before any of
/// this runs, in RingNotificationExtension.kt.)
class PushService {
  PushService(this._auth, this._api, this._router, this._ring);

  final GoTrueClient _auth;
  final ApiClient _api;
  final GoRouter _router;
  final RingChannel _ring;
  String? _registeredFor;

  Future<void> start() async {
    if (Env.oneSignalAppId.isEmpty) return;
    try {
      OneSignal.initialize(Env.oneSignalAppId);
      OneSignal.Notifications.addClickListener((event) => openPush(_router, event.notification.additionalData));
      OneSignal.User.pushSubscription.addObserver((_) => _register());
      _auth.onAuthStateChange.listen((s) {
        if (s.event == AuthChangeEvent.signedOut) {
          _registeredFor = null;
          // A shared phone must not keep ringing for the last rider's order.
          _ring.stop('*');
          OneSignal.logout();
        } else if (s.session != null) {
          _register();
        }
      });
      await _register();
    } catch (e) {
      debugPrint('push: $e');
    }
  }

  Future<void> _register() async {
    final uid = _auth.currentUser?.id;
    if (uid == null) return;
    try {
      if (_registeredFor != uid) {
        OneSignal.login(uid);
        await OneSignal.Notifications.requestPermission(true);
      }
      final id = OneSignal.User.pushSubscription.id;
      if (id == null || id.length < 8) return;
      await _api.post('/api/notifications/register', {'playerId': id});
      _registeredFor = uid;
    } catch (e) {
      debugPrint('push register: $e');
    }
  }
}
