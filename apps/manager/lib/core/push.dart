import 'package:flutter/foundation.dart';
import 'package:go_router/go_router.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../config/env.dart';
import '../data/manager_repository.dart';
import 'entity_routes.dart';

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
  // Phase 5 pushes name what they are about: a payment waiting for approval,
  // a rider's cash deposit, a delivery exception.
  final type = data?['type'];
  final rawId = data?['id'];
  final id = rawId is String && RegExp(r'^[0-9a-zA-Z-]{6,}$').hasMatch(rawId) ? rawId : null;
  if (type == 'payment_request') return id == null ? '/more/approvals' : '/more/approvals?id=$id';
  if (type == 'cash_deposit') return '/more/cash';
  if (type == 'delivery_exception') return id == null ? '/live/exceptions' : '/live/exceptions?id=$id';
  // Phase 6: a settlement (waiting, paid, voided) and a refund to decide.
  if (type == 'settlement') return id == null ? '/finance/settlements' : '/finance/settlements/$id';
  if (type == 'refund') return '/finance/refunds';
  // Phase 8: an alert, a ticket, and an inbox row with its own link.
  if (type == 'alert') return id == null ? '/alerts' : '/alerts/$id';
  if (type == 'ticket') return id == null ? '/more/support' : '/more/tickets/$id';
  if (type == 'inbox') return safeAppPath(data?['url'] as String?) ?? '/inbox';
  // The server's alert pushes and inbox rows carry `alertId` and `url: /alerts/<id>`.
  final alertId = data?['alertId'];
  if (alertId is String && RegExp(r'^[0-9a-zA-Z-]{6,}$').hasMatch(alertId)) return '/alerts/$alertId';
  for (final raw in [data?['appPath'], launchUrl, data?['url'], data?['path']]) {
    if (raw is! String || raw.isEmpty) continue;
    final uri = Uri.tryParse(raw);
    final path = uri?.path ?? raw;
    // Live can open centred on one order (`/live?focus=<order id>`).
    final focus = uri?.queryParameters['focus'];
    if (path == '/live' && focus != null && RegExp(r'^[0-9a-fA-F-]{8,}$').hasMatch(focus)) {
      return '/live?focus=$focus';
    }
    final idParam = uri?.queryParameters['id'];
    final safeId = idParam != null && RegExp(r'^[0-9a-zA-Z-]{6,}$').hasMatch(idParam) ? idParam : null;
    if (path == '/more/approvals' || path == '/live/exceptions') {
      return safeId == null ? path : '$path?id=$safeId';
    }
    if (path == '/alerts' || path == '/inbox') return path;
    final alert = RegExp(r'^/alerts/([0-9a-zA-Z-]{6,})$').firstMatch(path);
    if (alert != null) return '/alerts/${alert.group(1)}';
    final order = RegExp(r'^/(?:admin/)?orders/([0-9a-fA-F-]{8,})$').firstMatch(path);
    if (order != null) return '/orders/${order.group(1)}';
    // A support ticket, from the admin console's link or this app's own.
    final ticket = RegExp(r'^/(?:(?:admin|manager)/(?:support|tickets)|more/tickets)/([0-9a-fA-F-]{8,})$').firstMatch(path);
    if (ticket != null) return '/more/tickets/${ticket.group(1)}';
    // The cash screen, from the website's link.
    if (path == '/manager/cash') return '/more/cash';
    if (path == '/manager' || path.startsWith('/manager/') || path.startsWith('/admin')) return '/';
    // Finance's own lists, and one settlement.
    if (RegExp(r'^/finance/(vendor-dues|rider-dues|issues|settlements|rider-payouts|refunds|reconciliation)$')
        .hasMatch(path)) {
      return path;
    }
    final settlement = RegExp(r'^/finance/settlements/([0-9a-zA-Z-]{6,})$').firstMatch(path);
    if (settlement != null) return '/finance/settlements/${settlement.group(1)}';
    final tab = RegExp(r'^/(orders|live|finance)(/[A-Za-z0-9_/-]*)?$').firstMatch(path);
    if (tab != null) return '/${tab.group(1)}';
    if (RegExp(r'^/more(/[A-Za-z0-9_/-]*)?$').hasMatch(path)) return path;
  }
  // A kind this build doesn't know yet, with no usable link, still lands
  // somewhere useful.
  if (type is String && type.isNotEmpty) return '/inbox';
  return null;
}

/// Where tapping an inbox row goes: its own app link, else its alert, else a
/// link written with the website's path mapped onto this app (rows older than
/// the server's app paths). Null when there is nowhere safe to go.
String? inboxPath({required String? url, required String? alertId, required Map<String, dynamic>? data}) {
  final own = safeAppPath(url);
  if (own != null) return own;
  if (alertId != null && alertId.isNotEmpty) return '/alerts/${Uri.encodeComponent(alertId)}';
  return inAppPathFrom(url, data);
}
