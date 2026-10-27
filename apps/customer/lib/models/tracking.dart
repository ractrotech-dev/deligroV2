import 'order.dart';

class LatLngPoint {
  const LatLngPoint(this.lat, this.lng);
  final double lat;
  final double lng;

  static LatLngPoint? tryParse(Object? v) {
    if (v is! Map) return null;
    final lat = v['lat'], lng = v['lng'];
    if (lat is! num || lng is! num) return null;
    return LatLngPoint(lat.toDouble(), lng.toDouble());
  }
}

class TrackingEta {
  const TrackingEta({
    required this.expectedAt,
    required this.minutesRemaining,
    required this.late,
    required this.lateByMinutes,
  });
  final DateTime? expectedAt;
  final int? minutesRemaining;
  final bool late;
  final int lateByMinutes;
}

class Rider {
  const Rider({required this.name, required this.id, required this.phone});
  final String name;
  final String? id;
  final String? phone;
}

/// The one sentence a customer sees about a shop delay (ruling P7-R1); the
/// website shows the same words (src/lib/orders/shop-delay.ts).
const kShopRunningLate = 'The shop is running late';

/// `GET /api/orders/:id/tracking` → `{tracking: OrderTrackingSnapshot}`
/// (src/lib/data-access/order-tracking.ts).
class TrackingSnapshot {
  const TrackingSnapshot({
    required this.status,
    required this.eta,
    required this.rider,
    required this.restaurant,
    required this.destination,
    required this.riderPosition,
    required this.riderPositionSource,
    this.riderArrived = false,
    this.shopRunningLate = false,
    this.weather,
  });

  final OrderStatus status;
  final TrackingEta? eta;
  final Rider? rider;
  final LatLngPoint? restaurant;
  final LatLngPoint? destination;
  final LatLngPoint? riderPosition;

  /// gps | estimated | none
  final String riderPositionSource;

  /// The rider tapped "Arrived" at the door and still holds the order
  /// (`deliveries.arrived_drop_at`). False on a payload from an older server.
  final bool riderArrived;

  /// The rider reported the shop is running late and the food is still at the
  /// shop (ruling P7-R1). The screen shows only [kShopRunningLate] — the
  /// server never sends the report's own words. False on an older server.
  final bool shopRunningLate;

  /// Rain or a storm in the shop's zone (0178): why the time went up; null when clear.
  final String? weather;

  factory TrackingSnapshot.fromJson(Map<String, dynamic> j) {
    final eta = j['eta'] as Map?;
    final rider = j['rider'] as Map?;
    return TrackingSnapshot(
      status: parseStatus('${j['status']}'.toLowerCase()),
      eta: eta == null
          ? null
          : TrackingEta(
              expectedAt: DateTime.tryParse('${eta['expectedAt']}'),
              minutesRemaining: (eta['minutesRemaining'] as num?)?.round(),
              late: eta['late'] == true,
              lateByMinutes: (eta['lateByMinutes'] as num?)?.round() ?? 0,
            ),
      rider: rider == null
          ? null
          : Rider(
              name: '${rider['name'] ?? 'Your rider'}',
              id: rider['id'] as String?,
              phone: rider['phone'] as String?,
            ),
      restaurant: LatLngPoint.tryParse(j['restaurant']),
      destination: LatLngPoint.tryParse(j['destination']),
      riderPosition: LatLngPoint.tryParse(j['riderPosition']),
      riderPositionSource: '${j['riderPositionSource'] ?? 'none'}',
      riderArrived: j['riderArrived'] == true,
      shopRunningLate: j['shopRunningLate'] == true,
      weather: j['weather'] is String && (j['weather'] as String).trim().isNotEmpty ? (j['weather'] as String).trim() : null,
    );
  }
}
