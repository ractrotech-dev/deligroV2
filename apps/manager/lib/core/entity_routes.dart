/// Where an alert, an inbox item or an audit entry opens: the screen for the
/// thing it is about. Kinds with no screen of their own (a zone, an
/// incident, anything new) open the alert itself, or the Alerts list.
String routeForEntity(String type, String id, {Map<String, dynamic>? data, String? alertId}) {
  final enc = Uri.encodeComponent(id);
  final fallback = alertId == null || alertId.isEmpty ? '/alerts' : '/alerts/${Uri.encodeComponent(alertId)}';
  if (id.isEmpty) return fallback;
  return switch (type) {
    'order' => '/orders/$enc',
    // A delivery's alert carries its order when it can; otherwise the id is
    // the order's (the server keys delivery alerts by order for the app).
    'delivery' => '/orders/${Uri.encodeComponent(_str(data?['orderId']) ?? id)}',
    'restaurant' => '/more/vendors/$enc',
    'rider' => '/more/riders/$enc',
    'ticket' => '/more/tickets/$enc',
    'marketing_request' => '/more/marketing/requests/$enc',
    'settlement' => '/finance/settlements/$enc',
    'payment_request' => '/more/approvals?id=$enc',
    // The server keys a cash alert `<riderId>:<yyyy-mm-dd>`: open that rider's cash for that day.
    'cash_day' => _cashDayRoute(id) ?? '/more/cash',
    _ => fallback,
  };
}

String? _cashDayRoute(String id) {
  final m = RegExp(r'^([0-9a-fA-F-]{8,}):(\d{4}-\d{2}-\d{2})$').firstMatch(id);
  return m == null ? null : '/more/cash?rider=${m.group(1)}&day=${m.group(2)}';
}

String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

/// [url] if it is one of this app's own screens, else null. Inbox rows and
/// pushes carry relative links; nothing else (another site, a scheme, a
/// path climbing out with `..`) is ever followed.
String? safeAppPath(String? url) {
  if (url == null || url.isEmpty || !url.startsWith('/') || url.startsWith('//') || url.contains('..')) return null;
  final ok = RegExp(r'^/(orders|live|finance|more|alerts|inbox|stats)(/[A-Za-z0-9_:.\-]+)*/?(\?[A-Za-z0-9_=&.%\-]*)?$');
  return ok.hasMatch(url) ? url : null;
}
