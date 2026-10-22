// Fixture dashboard, history and performance for the debug-only preview.
// Imported only from state/insights.dart behind `fixturesEnabled`, which is a
// compile-time false in a release build, so none of this is in the release app.
import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../models/dashboard.dart';
import '../../models/insights.dart';
import '../insights_repository.dart';

/// Which rider a fixture session is (`--dart-define=FIXTURE_INSIGHTS=`):
/// `busy` (a day of work and a delivery in hand), `empty` (a brand-new rider)
/// or `off` (the earnings switch is off, so no money).
const String fixtureInsightsScenario = String.fromEnvironment(
  'FIXTURE_INSIGHTS',
  defaultValue: 'busy',
);

/// [InsightsRepository] over in-memory JSON shaped like the server's.
class FixtureInsightsRepository implements InsightsRepository {
  FixtureInsightsRepository._(this._scenario, this._now);

  /// Throws in a release build, twice over: an assert for debug runs, and a
  /// plain check that is still there with asserts off.
  factory FixtureInsightsRepository.create({
    String scenario = fixtureInsightsScenario,
    DateTime? now,
    @visibleForTesting bool releaseMode = kReleaseMode,
  }) {
    assert(
      !kReleaseMode,
      'the fixture backend must never be built in a release build',
    );
    if (releaseMode) {
      throw StateError(
        'the fixture backend is not available in a release build',
      );
    }
    return FixtureInsightsRepository._(scenario, now ?? DateTime.now());
  }

  final String _scenario;
  final DateTime _now;

  @override
  Future<RiderDashboard> dashboard() async {
    final empty = _scenario == 'empty';
    return RiderDashboard.fromJson({
      'today': empty
          ? {
              'deliveries': 0,
              'pending': 0,
              'accepted': 0,
              'pickedUp': 0,
              'completed': 0,
              'cancelled': 0,
              'failed': 0,
            }
          : {
              'deliveries': 9,
              'pending': 2,
              'accepted': 1,
              'pickedUp': 1,
              'completed': 5,
              'cancelled': 2,
              'failed': 1,
            },
      'money': _scenario == 'off'
          ? null
          : empty
          ? {'today': 0, 'total': 0, 'pending': 0, 'incentivesThisWeek': 0}
          : {
              'today': 185,
              'total': 12450,
              'pending': 650,
              'incentivesThisWeek': 300,
            },
      'availability': {
        'isOnline': !empty,
        'breakUntil': null,
        'onlineSince': _now
            .subtract(const Duration(hours: 3))
            .toUtc()
            .toIso8601String(),
        'lastFixAt': _now.toUtc().toIso8601String(),
      },
      'phase': empty ? 'offline' : 'online',
      'current': empty
          ? null
          : {
              'orderId': 'f2000000-0000-4000-8000-000000000001',
              'code': '#FX6620',
              'status': 'on_the_way',
              'next': 'Reach the customer',
            },
      'nearestTarget': _scenario == 'off' || empty
          ? null
          : {'name': 'Weekly warrior', 'done': 32, 'target': 40, 'bonus': 500},
      'updatedAt': _now.toUtc().toIso8601String(),
    });
  }

  // ---- history ----

  static const _shops = [
    ('Annapurna Sweets', 'Sector 14'),
    ('Spice Route Kitchen', 'Model Town'),
    ('Fresh Basket Grocers', 'Civil Lines'),
    ('Dosa Corner', 'Green Park'),
    ('City Pharmacy', 'Old Market'),
  ];

  /// Forty-five finished jobs, newest first, spread over the last month.
  late final List<Map<String, dynamic>> _history = _scenario == 'empty'
      ? const []
      : _buildHistory();

  List<Map<String, dynamic>> _buildHistory() {
    final out = <Map<String, dynamic>>[];
    for (var i = 0; i < 45; i++) {
      final shop = _shops[i % _shops.length];
      final ended = _now.subtract(
        Duration(hours: 2 + i * 14, minutes: i * 7 % 50),
      );
      final accepted = ended.subtract(Duration(minutes: 28 + i % 9 * 4));
      final picked = accepted.add(Duration(minutes: 11 + i % 4));
      final outcome = i % 11 == 4
          ? 'failed'
          : i % 9 == 7
          ? 'cancelled'
          : i % 13 == 12
          ? 'reassigned'
          : 'delivered';
      final delivered = outcome == 'delivered';
      out.add({
        'orderId': 'f3000000-0000-4000-8000-${i.toString().padLeft(12, '0')}',
        'code': '#FX${6620 + i}',
        'shop': shop.$1,
        'dropArea': i % 6 == 5 ? null : shop.$2,
        'outcome': outcome,
        'acceptedAt': accepted.toUtc().toIso8601String(),
        'pickedUpAt': outcome == 'reassigned'
            ? null
            : picked.toUtc().toIso8601String(),
        'deliveredAt': delivered ? ended.toUtc().toIso8601String() : null,
        'endedAt': ended.toUtc().toIso8601String(),
        'distanceKm': 1.4 + (i % 7) * 0.9,
        // Riders are salaried: most rows carry no per-job money.
        'earning': _scenario == 'off' || !delivered || i % 5 != 0 ? null : 32,
        'reason': switch (outcome) {
          'failed' => 'Customer did not pick up the phone',
          'cancelled' => 'Customer cancelled the order',
          'reassigned' => 'Handed back to dispatch',
          _ => null,
        },
        'cancelledBy': outcome == 'cancelled' ? 'customer' : null,
        'proof': delivered ? (i % 3 == 0 ? 'photo' : 'code') : null,
        'itemCount': 1 + i % 4,
        'orderValue': 180 + i * 7,
      });
    }
    return out;
  }

  /// The IST day a row ended on, for the filters.
  String _dayOf(Map<String, dynamic> row) {
    final at = DateTime.parse(
      row['endedAt'] as String,
    ).toUtc().add(const Duration(hours: 5, minutes: 30));
    return '${at.year.toString().padLeft(4, '0')}-${at.month.toString().padLeft(2, '0')}-${at.day.toString().padLeft(2, '0')}';
  }

  @override
  Future<HistoryPage> history({
    String? from,
    String? to,
    String? outcome,
    String? cursor,
  }) async {
    final rows = [
      for (final r in _history)
        if ((from == null || _dayOf(r).compareTo(from) >= 0) &&
            (to == null || _dayOf(r).compareTo(to) <= 0) &&
            (outcome == null || r['outcome'] == outcome))
          r,
    ];
    final start = int.tryParse(cursor ?? '') ?? 0;
    final page = rows.skip(start).take(20).toList();
    final next = start + 20 < rows.length ? '${start + 20}' : null;
    return HistoryPage.fromJson({'items': page, 'nextCursor': next});
  }

  @override
  Future<HistoryDetail> historyDetail(String orderId) async {
    final row = _history.where((r) => r['orderId'] == orderId).firstOrNull;
    if (row == null) throw ApiException(404, 'not_found');
    final delivered = row['outcome'] == 'delivered';
    final ended = row['endedAt'] as String;
    return HistoryDetail.fromJson({
      ...row,
      'timeline': [
        {
          'kind': 'accepted',
          'method': null,
          'reason': null,
          'at': row['acceptedAt'],
        },
        if (row['pickedUpAt'] != null)
          {
            'kind': 'picked_up',
            'method': 'code',
            'reason': null,
            'at': row['pickedUpAt'],
          },
        if (delivered)
          {'kind': 'arrived_drop', 'method': null, 'reason': null, 'at': ended},
        {
          'kind': row['outcome'] == 'reassigned' ? 'released' : row['outcome'],
          'method': row['proof'],
          'reason': row['reason'],
          'at': ended,
        },
      ],
      // The preview has no server to sign a photo link.
      'proofPhotoUrl': null,
      'items': [
        {'name': 'Paneer butter masala', 'qty': 1},
        {'name': 'Butter naan', 'qty': 2},
        if ((row['itemCount'] as int) > 2) {'name': 'Sweet lassi', 'qty': 1},
      ],
    });
  }

  // ---- performance ----

  @override
  Future<RiderPerformance> performance() async {
    if (_scenario == 'empty') {
      return RiderPerformance.fromJson({
        'daily': {'target': 0, 'done': 0},
        'weekly': {'target': 0, 'done': 0},
        'avgAcceptToDeliverMin': null,
        'avgPickupToDeliverMin': null,
        'acceptanceRate': null,
        'failedRate': null,
        'onlineHoursThisWeek': 0,
        'rating': {'average': null, 'count': 0, 'recent': []},
        'months': [
          for (var i = 0; i < 12; i++)
            _month(
              i,
              delivered: 0,
              failed: 0,
              cancelled: 0,
              rate: null,
              avg: null,
              hours: 0,
            ),
        ],
      });
    }
    const delivered = [34, 41, 38, 52, 47, 60, 58, 66, 71, 64, 79, 33];
    return RiderPerformance.fromJson({
      'daily': {'target': 12, 'done': 5},
      'weekly': {'target': 60, 'done': 38},
      'avgAcceptToDeliverMin': 37,
      'avgPickupToDeliverMin': 24,
      'acceptanceRate': 86.5,
      'failedRate': 4,
      'onlineHoursThisWeek': 31.5,
      'rating': {
        'average': 4.6,
        'count': 128,
        'recent': [
          {
            'rating': 5,
            'comment': 'Quick and polite',
            'at': _now
                .subtract(const Duration(days: 1))
                .toUtc()
                .toIso8601String(),
          },
          {
            'rating': 4,
            'comment': null,
            'at': _now
                .subtract(const Duration(days: 2))
                .toUtc()
                .toIso8601String(),
          },
          {
            'rating': 5,
            'comment': 'Food was still hot',
            'at': _now
                .subtract(const Duration(days: 4))
                .toUtc()
                .toIso8601String(),
          },
        ],
      },
      'months': [
        for (var i = 0; i < 12; i++)
          _month(
            i,
            delivered: delivered[11 - i],
            failed: i % 4,
            cancelled: 1 + i % 3,
            rate: 80.0 + i % 9,
            avg: 33.0 + i % 6,
            hours: 120.0 + i * 3,
            earnings: _scenario == 'off' || i > 5 ? null : 2400.0 + i * 150,
          ),
      ],
    });
  }

  Map<String, dynamic> _month(
    int agoMonths, {
    required int delivered,
    required int failed,
    required int cancelled,
    required double? rate,
    required double? avg,
    required double hours,
    double? earnings,
  }) {
    final at = DateTime(_now.year, _now.month - agoMonths);
    return {
      'month':
          '${at.year.toString().padLeft(4, '0')}-${at.month.toString().padLeft(2, '0')}',
      'delivered': delivered,
      'failed': failed,
      'cancelled': cancelled,
      'acceptanceRate': rate,
      'avgDeliverMin': avg,
      'earnings': earnings,
      'onlineHours': hours,
    };
  }
}
