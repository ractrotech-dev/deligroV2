/// Where a tap on a notification goes, for the OneSignal tap and for a row in
/// the inbox alike. Pure, so the table is tested bare.
///
/// The server sends `data.category` and `data.url` (src/lib/notifications/
/// notify-user.ts): the url is the route name on the server's side
/// (`/jobs/<orderId>`, `/help/tickets/<id>`, `/earnings/payouts`,
/// `/notifications`, ...). The app's own routes are not all spelled the same
/// (Help lives under More), so the url is translated; a url the app does not
/// know falls back to the category's page, then to the inbox.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/cash/cash_screen.dart' show cashPath;
import '../features/earnings/earnings_widgets.dart' show earningsPath;
import '../features/help/help_screen.dart' show helpPath;
import '../features/jobs/jobs_screen.dart' show jobsPath;
import '../features/profile/profile_screen.dart' show documentsPath;
import '../features/safety/safety_screen.dart' show safetyPath;

const notificationsPath = '/notifications';

const _jobs = jobsPath;

/// The screens that only say where the gate stands (login, loading, not a
/// rider, update needed). A push tapped while one of them is showing waits.
const gatePaths = {'/login', '/gate', '/not-rider', '/needs-update', '/update-required'};

/// What `data.outcome` says about a delivery that is over.
const _finishedOutcomes = {'delivered', 'failed', 'cancelled', 'reassigned'};

/// A push tapped while the app was not through the gate yet (closed, loading,
/// signed out): its target is held here, for the user who got it, and opened
/// once the gate says that user is a signed-in rider. Anyone else, and a
/// rider who turns out not to be one, never gets it.
class PendingPush {
  String? _path;
  String? _uid;

  bool get isHeld => _path != null;

  void hold(String path, String uid) {
    _path = path;
    _uid = uid;
  }

  /// The held path if it was held for [uid]; either way it is let go.
  String? take(String? uid) {
    final path = _path;
    final owner = _uid;
    clear();
    return path != null && uid != null && owner == uid ? path : null;
  }

  void clear() {
    _path = null;
    _uid = null;
  }
}

final pendingPushProvider = Provider<PendingPush>((_) => PendingPush());
const _help = helpPath;

/// The app route for a notification, or [notificationsPath] when nothing
/// better is known. [exists] says whether the router has a route for a path.
String routeForNotification({
  String? category,
  String? url,
  Map<String, dynamic> data = const {},
  bool Function(String path)? exists,
}) {
  bool has(String p) => exists == null || exists(p);

  final fromUrl = _fromUrl(url ?? (data['url'] is String ? data['url'] as String : null), has, data);
  if (fromUrl != null) return fromUrl;

  final ticketId = data['ticketId'];
  return switch (category) {
    'support' => ticketId is String && ticketId.isNotEmpty ? '$_help/tickets/$ticketId' : _help,
    'offers' || 'cancellations' || 'pickup_reminders' || 'delivery_updates' || 'high_demand' =>
      _finishedOrderPath(data, has) ?? _jobs,
    'payouts' || 'incentives' => earningsPath,
    'cash' => cashPath,
    'documents' => documentsPath,
    'safety' => safetyPath,
    _ => notificationsPath,
  };
}

/// `/history/order/<id>` for a push about a delivery that is over, when the
/// push says so (`data.finished` or `data.outcome`) and names the order; else
/// null. Nothing says so today, so a tap goes to Jobs; this is ready for the
/// day the server does.
String? _finishedOrderPath(Map<String, dynamic> data, bool Function(String) has) {
  final id = data['orderId'];
  final over = data['finished'] == true || _finishedOutcomes.contains(data['outcome']);
  if (!over || id is! String || id.isEmpty) return null;
  final path = '/history/order/$id';
  return has(path) ? path : null;
}

String? _fromUrl(
  String? raw,
  bool Function(String) has,
  Map<String, dynamic> data,
) {
  if (raw == null) return null;
  var path = raw.trim();
  if (path.isEmpty || !path.startsWith('/')) return null; // a web link is not a route
  final cut = path.indexOf(RegExp(r'[?#]'));
  if (cut >= 0) path = path.substring(0, cut);
  if (path.length > 1 && path.endsWith('/')) path = path.substring(0, path.length - 1);

  if (path == _jobs || path.startsWith('$_jobs/')) return _finishedOrderPath(data, has) ?? _jobs;
  if (path == '/home') return '/home';
  if (path == notificationsPath) return notificationsPath;
  if (path == safetyPath) return safetyPath;
  if (path == '/help' || path.startsWith('/help/')) return '$_help${path.substring('/help'.length)}';
  if (path == earningsPath || path.startsWith('$earningsPath/')) {
    return has(path) ? path : earningsPath;
  }
  // The server's names for screens that live under More in the app.
  if (path == '/cash' || path.startsWith('/cash/')) return cashPath;
  if (path == '/documents' || path.startsWith('/documents/')) return documentsPath;
  if (path.startsWith('/more/') && has(path)) return path;
  return null;
}
