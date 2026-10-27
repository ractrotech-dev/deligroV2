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
        final path = vendorPathFrom(event.notification.launchUrl, event.notification.additionalData);
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
        // Awaited: the server checks the subscription is logged in as this account
        // before it releases the id from anyone else (2026-10-28 audit).
        await OneSignal.login(uid);
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

/// Vendor order pushes carry the ring id `vendor:<orderId>` (lib/alerts/ring.ts);
/// others may carry `orderId`, or a web portal link (`/vendor`,
/// `/vendor/orders/<id>`). Order links are mapped to the app's own
/// `/orders/<id>`; a few other app screens are allowed by [_appPaths]; a push
/// can't steer the app anywhere else.
String? vendorPathFrom(String? launchUrl, Map<String, dynamic>? data) {
  final id = RegExp(r'^[0-9a-fA-F-]{8,}$');
  final ring = data?['ringId'];
  if (ring is String && ring.startsWith('vendor:') && id.hasMatch(ring.substring(7))) {
    return '/orders/${ring.substring(7)}';
  }
  final orderId = data?['orderId'];
  if (orderId is String && id.hasMatch(orderId)) {
    return '/orders/$orderId';
  }
  for (final raw in [launchUrl, data?['url'], data?['path']]) {
    if (raw is! String || raw.isEmpty) continue;
    final path = Uri.tryParse(raw)?.path ?? raw;
    final m = RegExp(r'^(?:/vendor)?/orders/([0-9a-fA-F-]{8,})$').firstMatch(path);
    if (m != null) return '/orders/${m.group(1)}';
    if (path == '/vendor' || path == '/vendor/') return '/orders';
    if (_appPaths.any((p) => p.hasMatch(path))) return path;
  }
  return null;
}

/// The app screens a non-order push may open (settlement paid, marketing and
/// ticket updates, a new review, an announcement). Nothing else is honoured.
final _appPaths = [
  RegExp(r'^/payments/[0-9a-fA-F-]{36}$'),
  RegExp(r'^/more/marketing/[0-9a-fA-F-]{36}$'),
  RegExp(r'^/more/support/[0-9a-fA-F-]{36}$'),
  RegExp(r'^/more/(reviews|notifications|offers|payments)$'),
];
