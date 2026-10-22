import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/statement_export.dart';
import '../data/earnings_repository.dart';
import '../data/fixtures/fixture_backend.dart';
import '../data/fixtures/fixture_earnings.dart';
import '../models/earnings.dart';
import 'providers.dart';

/// The earnings routes, or in a debug build started with FIXTURES=true the
/// in-memory fixture backend. `fixturesEnabled` is a compile-time false in a
/// release build, so the fixture branch (and its data) is not in the app.
final earningsRepoProvider = Provider<EarningsRepository>((ref) {
  if (fixturesEnabled) return FixtureEarningsRepository.create();
  return ApiEarningsRepository(ref.watch(apiProvider));
});

/// The Earnings tab's figures. Dropped when the tab is left, so coming back
/// asks again.
final earningsSummaryProvider = FutureProvider.autoDispose<EarningsSummary>(
  retry: (_, _) => null,
  (ref) => ref.watch(earningsRepoProvider).summary(),
);

final payoutsProvider = FutureProvider.autoDispose<List<Payout>>(
  retry: (_, _) => null,
  (ref) => ref.watch(earningsRepoProvider).payouts(),
);

final incentivesProvider = FutureProvider.autoDispose<List<IncentiveProgress>>(
  retry: (_, _) => null,
  (ref) => ref.watch(earningsRepoProvider).incentives(),
);

/// Where a finished statement goes: the phone's share sheet.
final statementSharerProvider = Provider<StatementSharer>(
  (_) => const SystemStatementSharer(),
);
