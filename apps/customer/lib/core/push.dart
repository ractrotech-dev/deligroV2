import 'package:flutter/foundation.dart';
import 'package:go_router/go_router.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../config/env.dart';
import '../data/account_repository.dart';

/// Order pushes through OneSignal, targeted by `external_id = profile id`
/// (src/lib/notifications/onesignal.ts). A no-op when no app id is built in.
class PushService {
  PushService(this._auth, this._account, this._router);

  final GoTrueClient _auth;
  final AccountRepository _account;
  final GoRouter _router;
  String? _registeredFor;

  Future<void> start() async {
    if (Env.oneSignalAppId.isEmpty) return;
    try {
      OneSignal.initialize(Env.oneSignalAppId);
      OneSignal.Notifications.addClickListener((event) {
        final path = orderPathFrom(
          event.notification.launchUrl,
          event.notification.additionalData,
        );
        if (path != null) _router.push(path);
      });
      OneSignal.User.pushSubscription.addObserver((_) => _register());
      _auth.onAuthStateChange.listen((s) {
        if (s.event == AuthChangeEvent.signedOut) {
          _registeredFor = null;
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
      await _account.registerPush(id);
      _registeredFor = uid;
    } catch (e) {
      debugPrint('push register: $e');
    }
  }
}

/// Customer pushes carry `url: /orders/<id>` — absolute or relative. Only
/// order links are honoured, so a push can't steer the app anywhere else.
String? orderPathFrom(String? launchUrl, Map<String, dynamic>? data) {
  for (final raw in [launchUrl, data?['url'], data?['path']]) {
    if (raw is! String || raw.isEmpty) continue;
    final path = Uri.tryParse(raw)?.path ?? raw;
    final m = RegExp(r'^/orders/([0-9a-fA-F-]{8,})$').firstMatch(path);
    if (m != null) return '/orders/${m.group(1)}';
  }
  return null;
}
