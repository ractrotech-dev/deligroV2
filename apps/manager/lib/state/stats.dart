import 'package:flutter/material.dart' show DateTimeRange;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/stats.dart';
import '../widgets/zone_picker.dart';
import 'providers.dart';

/// The period on the statistics screen. Month by default; the zone comes from
/// the Home picker.
class StatsQueryNotifier extends Notifier<StatsQuery> {
  @override
  StatsQuery build() => const StatsQuery(period: Period.month);

  void setPeriod(Period p) => state = StatsQuery(period: p);
  void setCustom(DateTimeRange range) => state = StatsQuery(period: Period.custom, custom: range);
}

final statsQueryProvider = NotifierProvider<StatsQueryNotifier, StatsQuery>(StatsQueryNotifier.new);

/// The statistics for the chosen period and zone. No automatic retry: the
/// screen shows the error in words and a Retry button.
final statsProvider = FutureProvider.autoDispose<StatsData>(
  (ref) {
    final q = ref.watch(statsQueryProvider).withZone(ref.watch(activeZoneProvider)?.id);
    return ref.read(managerRepoProvider).stats(q);
  },
  retry: (_, _) => null,
);

/// The same statistics for one shop (`/stats?vendor=<id>`), same period and
/// zone as the screen's picker.
final vendorStatsProvider = FutureProvider.autoDispose.family<StatsData, String>(
  (ref, vendorId) {
    final q = ref.watch(statsQueryProvider).withZone(ref.watch(activeZoneProvider)?.id).withVendor(vendorId);
    return ref.read(managerRepoProvider).stats(q);
  },
  retry: (_, _) => null,
);

/// Whole-zone statistics, or one shop's.
FutureProvider<StatsData> statsFor(String? vendorId) => vendorId == null ? statsProvider : vendorStatsProvider(vendorId);
