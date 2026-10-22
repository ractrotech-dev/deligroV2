// Fixture dashboard, history and performance for the debug-only preview.
// Imported only from state/insights.dart behind `fixturesEnabled`, which is a
// compile-time false in a release build, so none of this is in the release app.
import 'package:flutter/foundation.dart';

import '../../models/dashboard.dart';
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
    assert(!kReleaseMode, 'the fixture backend must never be built in a release build');
    if (releaseMode) {
      throw StateError('the fixture backend is not available in a release build');
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
              : {'today': 185, 'total': 12450, 'pending': 650, 'incentivesThisWeek': 300},
      'availability': {
        'isOnline': !empty,
        'breakUntil': null,
        'onlineSince': _now.subtract(const Duration(hours: 3)).toUtc().toIso8601String(),
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
}
