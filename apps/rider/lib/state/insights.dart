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

/// Home's twelve figures for one rider. Keyed by the rider's id, so another
/// rider signing in on this phone gets a fresh provider with no value: the
/// last rider's figures can never show for them, while loading or after an
/// error. Invalidated every 15 s while Home shows, on resume and after an
/// action; a refresh keeps that same rider's last answer on screen.
final dashboardProvider = FutureProvider.family<RiderDashboard, String>(
  retry: (_, _) => null,
  (ref, riderId) => ref.watch(insightsRepoProvider).dashboard(),
);
