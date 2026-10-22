import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/fixtures/fixture_backend.dart';
import '../data/fixtures/fixture_insights.dart';
import '../data/insights_repository.dart';
import '../models/dashboard.dart';
import 'providers.dart';

/// The insights routes, or in a debug build started with FIXTURES=true the
/// in-memory fixture backend. `fixturesEnabled` is a compile-time false in a
/// release build, so the fixture branch (and its data) is not in the app.
final insightsRepoProvider = Provider<InsightsRepository>((ref) {
  if (fixturesEnabled) return FixtureInsightsRepository.create();
  return ApiInsightsRepository(ref.watch(apiProvider));
});

/// Home's twelve figures. Invalidated every 15 s while Home shows, on resume
/// and after an action; a refresh keeps the last answer on screen. Kept for
/// the life of the signed-in rider (it starts afresh for the next one), so
/// Home has figures the moment it is shown again.
final dashboardProvider = FutureProvider<RiderDashboard>(
  retry: (_, _) => null,
  (ref) async {
    // Tied to the signed-in rider: asked once their id is known, again only
    // if it changes.
    await ref.watch(meProvider.selectAsync((m) => m.id));
    return ref.watch(insightsRepoProvider).dashboard();
  },
);
