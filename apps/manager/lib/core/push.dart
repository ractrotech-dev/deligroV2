import 'package:flutter/foundation.dart';
import 'package:go_router/go_router.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../config/env.dart';
import '../data/manager_repository.dart';

/// Ops pushes through OneSignal, targeted by `external_id = profile id`
/// (src/lib/notifications/onesignal.ts). A no-op when no app id is built in.
class PushService {
  PushService(this._auth, this._repo, this._router);

  final GoTrueClient _auth;
  final ManagerRepository _repo;
  final GoRouter _router;
  String? _registeredFor;

  Future<void> start() async {
    if (Env.oneSignalAppId.isEmpty) return;
    try {
      OneSignal.initialize(Env.oneSignalAppId);
      OneSignal.Notifications.addClickListener((event) {
        final path = inAppPathFrom(event.notification.launchUrl, event.notification.additionalData);
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
      await _repo.registerPush(id);
      _registeredFor = uid;
    } catch (e) {
      debugPrint('push register: $e');
    }
  }
}

/// Ops pushes carry `url` — absolute (the website's page) or relative. The
/// website's `/manager…` and `/admin/orders/<id>` links map onto this app's
/// screens; anything else opens Home. Only in-app paths are ever pushed, so a
/// notification can't steer the app to an arbitrary place.
///
/// An order link (`/admin/orders/<id>`, `/orders/<id>`) opens that order.
/// Any other path deeper than a tab opens the tab itself rather than a route
/// that does not exist. Every `/more/<item>` route exists.
String? inAppPathFrom(String? launchUrl, Map<String, dynamic>? data) {
  for (final raw in [data?['appPath'], launchUrl, data?['url'], data?['path']]) {
    if (raw is! String || raw.isEmpty) continue;
    final uri = Uri.tryParse(raw);
    final path = uri?.path ?? raw;
    // Live can open centred on one order (`/live?focus=<order id>`).
    final focus = uri?.queryParameters['focus'];
    if (path == '/live' && focus != null && RegExp(r'^[0-9a-fA-F-]{8,}$').hasMatch(focus)) {
      return '/live?focus=$focus';
    }
    final order = RegExp(r'^/(?:admin/)?orders/([0-9a-fA-F-]{8,})$').firstMatch(path);
    if (order != null) return '/orders/${order.group(1)}';
    if (path == '/manager' || path.startsWith('/manager/') || path.startsWith('/admin')) return '/';
    final tab = RegExp(r'^/(orders|live|finance)(/[A-Za-z0-9_/-]*)?$').firstMatch(path);
    if (tab != null) return '/${tab.group(1)}';
    if (RegExp(r'^/more(/[A-Za-z0-9_/-]*)?$').hasMatch(path)) return path;
  }
  return null;
}
