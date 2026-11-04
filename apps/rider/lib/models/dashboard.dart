/// `GET /api/rider/dashboard` (src/lib/data-access/rider-insights.ts): Home's
/// twelve figures. Counts are IST-day counts worked out by the server; money
/// comes from the recorded ledger and is null when the rider's
/// `driver.earnings` switch is off.
library;

import 'jobs.dart' show RiderDeliveryStatus;
import 'rider_me.dart';

int _int(Object? v) => v is num ? v.round() : (v is String ? int.tryParse(v) ?? 0 : 0);

double _dbl(Object? v) => v is num ? v.toDouble() : (v is String ? double.tryParse(v) ?? 0 : 0);

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;

Map<String, dynamic> _map(Object? v) =>
    v is Map ? Map<String, dynamic>.from(v) : const <String, dynamic>{};

/// Figures 1-6: what the rider did today.
class DashToday {
  const DashToday({
    this.deliveries = 0,
    this.pending = 0,
    this.accepted = 0,
    this.pickedUp = 0,
    this.completed = 0,
    this.cancelled = 0,
    this.failed = 0,
  });

  /// 1. Accepted today, any outcome.
  final int deliveries;

  /// 2. Offers waiting for the rider now.
  final int pending;

  /// 3. Accepted, not yet picked up.
  final int accepted;

  /// 4. Picked up, not yet delivered.
  final int pickedUp;

  /// 5. Delivered today.
  final int completed;

  /// 6. Ended cancelled, failed or reassigned away today.
  final int cancelled;

  /// The failed part of [cancelled] (figure 6's subtitle).
  final int failed;

  factory DashToday.fromJson(Map<String, dynamic> j) => DashToday(
        deliveries: _int(j['deliveries']),
        pending: _int(j['pending']),
        accepted: _int(j['accepted']),
        pickedUp: _int(j['pickedUp']),
        completed: _int(j['completed']),
        cancelled: _int(j['cancelled']),
        failed: _int(j['failed']),
      );
}

/// What is still to be paid, from the recorded ledger.
class DashMoney {
  const DashMoney({required this.pending});

  /// Signed: negative means the rider owes Deligro.
  final double pending;

  factory DashMoney.fromJson(Map<String, dynamic> j) => DashMoney(pending: _dbl(j['pending']));
}

/// Figure 11: the delivery the rider is carrying.
class DashCurrent {
  const DashCurrent({
    required this.orderId,
    required this.code,
    required this.status,
    required this.next,
  });

  final String orderId;
  final String code;

  /// Null for a status this app does not know (shown as "In progress").
  final RiderDeliveryStatus? status;
  final String next;

  factory DashCurrent.fromJson(Map<String, dynamic> j) {
    RiderDeliveryStatus? status;
    try {
      status = RiderDeliveryStatus.parse(j['status']);
    } on FormatException {
      status = null;
    }
    return DashCurrent(
      orderId: '${j['orderId']}',
      code: '${j['code'] ?? ''}',
      status: status,
      next: '${j['next'] ?? ''}',
    );
  }
}

/// Rain, a storm or heat in one of the rider's zones (0178), told on Home.
class WeatherNotice {
  const WeatherNotice({required this.level, required this.title, required this.body});

  factory WeatherNotice.fromJson(Map<String, dynamic> j) =>
      WeatherNotice(level: '${j['level'] ?? ''}', title: '${j['title'] ?? ''}', body: '${j['body'] ?? ''}');

  /// `rain`, `heavy_rain`, `storm` or `heat`.
  final String level;
  final String title;
  final String body;
}

class RiderDashboard {
  const RiderDashboard({
    this.today = const DashToday(),
    this.money,
    this.availability = RiderAvailabilityDto.offline,
    this.phase = 'offline',
    this.current,
    this.updatedAt,
    this.weather = const [],
  });

  final DashToday today;

  /// Null when the rider may not see money.
  final DashMoney? money;
  final RiderAvailabilityDto availability;
  final String phase;
  final DashCurrent? current;
  final DateTime? updatedAt;

  /// The rider's zones with weather now; empty from an older server.
  final List<WeatherNotice> weather;

  factory RiderDashboard.fromJson(Map<String, dynamic> j) => RiderDashboard(
        today: DashToday.fromJson(_map(j['today'])),
        money: j['money'] is Map ? DashMoney.fromJson(_map(j['money'])) : null,
        availability: j['availability'] is Map
            ? RiderAvailabilityDto.fromJson(_map(j['availability']))
            : RiderAvailabilityDto.offline,
        phase: '${j['phase'] ?? 'offline'}',
        current: j['current'] is Map ? DashCurrent.fromJson(_map(j['current'])) : null,
        updatedAt: _date(j['updatedAt']),
        weather: [
          for (final w in (j['weather'] is List ? j['weather'] as List : const []))
            if (w is Map) WeatherNotice.fromJson(_map(w)),
        ],
      );
}
