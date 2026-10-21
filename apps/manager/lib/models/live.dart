import 'orders.dart';

/// `GET /api/manager/live` (Phase 3 plan, "API contract").

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;
int _int(Object? v) => v is num ? v.round() : 0;
double? _double(Object? v) => v is num ? v.toDouble() : null;
String? _str(Object? v) => v is String ? v : null;
Map<String, dynamic>? _map(Object? v) =>
    v is Map ? v.cast<String, dynamic>() : null;
List<Map<String, dynamic>> _maps(Object? v) => [
  for (final e in (v is List ? v : const []))
    if (e is Map) e.cast<String, dynamic>(),
];

enum RiderState {
  available,
  onDelivery,
  onBreak,
  stale,
  unknown;

  static RiderState parse(String? s) => switch (s) {
    'available' => available,
    'on_delivery' => onDelivery,
    'break' => onBreak,
    'stale' => stale,
    _ => unknown,
  };
}

enum SignalKind {
  riderInactive,
  deliveryFailed,
  deliveryDelayed,
  orderUnassigned,
  prepDelayed,

  /// A placed order the kitchen has not accepted in time.
  acceptDelayed,
  unknown;

  static SignalKind parse(String? s) => switch (s) {
    'rider_inactive' => riderInactive,
    'delivery_failed' => deliveryFailed,
    'delivery_delayed' => deliveryDelayed,
    'order_unassigned' => orderUnassigned,
    'prep_delayed' => prepDelayed,
    'accept_delayed' => acceptDelayed,
    _ => unknown,
  };
}

class GeoPoint {
  const GeoPoint(this.lat, this.lng);
  static GeoPoint? fromJson(Map<String, dynamic>? j) {
    final lat = _double(j?['lat']), lng = _double(j?['lng']);
    return lat == null || lng == null ? null : GeoPoint(lat, lng);
  }

  final double lat;
  final double lng;
}

class LiveRider {
  const LiveRider({
    required this.id,
    required this.name,
    this.code,
    required this.state,
    this.lat,
    this.lng,
    this.lastFixAt,
    this.lastFixAgeSeconds,
    this.stale = false,
    this.activeOrderIds = const [],
    this.phone,
  });
  factory LiveRider.fromJson(Map<String, dynamic> j) => LiveRider(
    id: _str(j['id']) ?? '',
    name: _str(j['name']) ?? '',
    // Phase 5 also sends `riderCode`; Phase 3's `code` wins when both exist.
    code: _str(j['code']) ?? _str(j['riderCode']),
    state: RiderState.parse(_str(j['state'])),
    lat: _double(j['lat']),
    lng: _double(j['lng']),
    lastFixAt: _date(j['lastFixAt']),
    lastFixAgeSeconds: j['lastFixAgeSeconds'] is num
        ? _int(j['lastFixAgeSeconds'])
        : null,
    stale: j['stale'] == true,
    activeOrderIds: [
      for (final s in (j['activeOrderIds'] as List?) ?? const [])
        if (s is String) s,
    ],
    phone: _str(j['phone']),
  );
  final String id;
  final String name;
  final String? code;
  final RiderState state;
  final double? lat;
  final double? lng;
  final DateTime? lastFixAt;
  final int? lastFixAgeSeconds;

  /// Last fix older than the snapshot's `staleSeconds` (§6.12).
  final bool stale;
  final List<String> activeOrderIds;

  /// Not in the pinned live contract; read if the server sends it (a rider on
  /// an active delivery, with `manager.call_customer`-style rules), and the
  /// rider card shows Call only then.
  final String? phone;

  bool get hasPoint => lat != null && lng != null;
}

/// An active order on the map: the list row plus its two points.
class LiveOrder {
  const LiveOrder({required this.item, this.pickupPoint, this.dropPoint});
  factory LiveOrder.fromJson(Map<String, dynamic> j) => LiveOrder(
    item: OrderListItem.fromJson(j),
    pickupPoint: GeoPoint.fromJson(_map(j['pickupPoint'])),
    dropPoint: GeoPoint.fromJson(_map(j['dropPoint'])),
  );
  final OrderListItem item;
  final GeoPoint? pickupPoint;
  final GeoPoint? dropPoint;
}

class LiveDelay {
  const LiveDelay({
    required this.orderId,
    required this.kind,
    required this.minutes,
  });
  factory LiveDelay.fromJson(Map<String, dynamic> j) => LiveDelay(
    orderId: _str(j['orderId']) ?? '',
    kind: DelayKind.parse(_str(j['kind'])),
    minutes: _int(j['minutes']),
  );
  final String orderId;
  final DelayKind kind;
  final int minutes;
}

class Signal {
  const Signal({
    required this.kind,
    this.orderId,
    this.riderId,
    this.minutes = 0,
    this.at,
  });
  factory Signal.fromJson(Map<String, dynamic> j) => Signal(
    kind: SignalKind.parse(_str(j['kind'])),
    orderId: _str(j['orderId']),
    riderId: _str(j['riderId']),
    minutes: _int(j['minutes']),
    at: _date(j['at']),
  );
  final SignalKind kind;
  final String? orderId;
  final String? riderId;
  final int minutes;
  final DateTime? at;
}

class LiveThresholds {
  const LiveThresholds({
    this.staleSeconds = 120,
    this.inactiveMinutes = 5,
    this.unassignedMinutes = 5,
    this.prepGraceMinutes = 5,
    this.pickupWaitMinutes = 10,
  });
  factory LiveThresholds.fromJson(Map<String, dynamic>? j) {
    int v(String k, int d) => j?[k] is num ? _int(j![k]) : d;
    return LiveThresholds(
      staleSeconds: v('staleSeconds', 120),
      inactiveMinutes: v('inactiveMinutes', 5),
      unassignedMinutes: v('unassignedMinutes', 5),
      prepGraceMinutes: v('prepGraceMinutes', 5),
      pickupWaitMinutes: v('pickupWaitMinutes', 10),
    );
  }
  final int staleSeconds;
  final int inactiveMinutes;
  final int unassignedMinutes;
  final int prepGraceMinutes;
  final int pickupWaitMinutes;
}

class LiveSnapshot {
  const LiveSnapshot({
    this.generatedAt,
    this.riders = const [],
    this.orders = const [],
    this.lanes = const {},
    this.unassigned = const [],
    this.delayed = const [],
    this.signals = const [],
    this.thresholds = const LiveThresholds(),
  });

  factory LiveSnapshot.fromJson(Map<String, dynamic> j) => LiveSnapshot(
    generatedAt: _date(j['generatedAt']),
    riders: [for (final m in _maps(j['riders'])) LiveRider.fromJson(m)],
    orders: [for (final m in _maps(j['orders'])) LiveOrder.fromJson(m)],
    lanes: {
      for (final e in (_map(j['lanes']) ?? const <String, dynamic>{}).entries)
        e.key: _int(e.value),
    },
    unassigned: [
      for (final s in (j['unassigned'] as List?) ?? const [])
        if (s is String) s,
    ],
    delayed: [for (final m in _maps(j['delayed'])) LiveDelay.fromJson(m)],
    signals: [for (final m in _maps(j['signals'])) Signal.fromJson(m)],
    thresholds: LiveThresholds.fromJson(_map(j['thresholds'])),
  );

  final DateTime? generatedAt;
  final List<LiveRider> riders;
  final List<LiveOrder> orders;

  /// Active-order counts by database status (`placed`, `kitchen`, `ready`,
  /// `on_the_way`).
  final Map<String, int> lanes;
  final List<String> unassigned;
  final List<LiveDelay> delayed;
  final List<Signal> signals;
  final LiveThresholds thresholds;

  LiveOrder? order(String id) {
    for (final o in orders) {
      if (o.item.id == id) return o;
    }
    return null;
  }

  LiveRider? rider(String id) {
    for (final r in riders) {
      if (r.id == id) return r;
    }
    return null;
  }
}
