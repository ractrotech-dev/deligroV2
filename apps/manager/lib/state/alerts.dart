import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/alerts.dart';
import '../models/outcome.dart';
import 'inbox.dart';
import 'paged.dart';
import 'providers.dart';

typedef AlertList = Paged<Alert, AlertCounts>;

/// Alerts poll this often while the list is on screen.
const alertsRefresh = Duration(seconds: 15);

/// One status of the alerts list (zone folded in by the screen). Acting on
/// an alert takes it off this list at once and re-reads the counts.
class AlertListNotifier extends AsyncNotifier<AlertList> {
  AlertListNotifier(this.filters);
  final AlertFilters filters;

  static String _id(Alert a) => a.id;

  @override
  Future<AlertList> build() async {
    ref.watch(signedInProvider);
    final p = await ref.read(alertsRepoProvider).list(filters);
    return Paged.first(sortAlerts(p.items), p.nextCursor, p.counts);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await ref.read(alertsRepoProvider).list(filters, cursor: s.nextCursor);
      state = AsyncData((state.value ?? s).append(p.items, p.nextCursor, _id));
    } catch (_) {
      state = AsyncData((state.value ?? s).copyWith(loadingMore: false, loadMoreFailed: true));
    }
  }

  Future<void> refresh() async {
    final s = state.value;
    if (s == null) {
      ref.invalidateSelf();
      return;
    }
    try {
      final p = await ref.read(alertsRepoProvider).list(filters);
      state = AsyncData((state.value ?? s).refreshedWith(sortAlerts(p.items), p.nextCursor, p.counts, _id));
    } catch (_) {
      // A failed background refresh keeps what is on screen.
    }
  }

  /// Throws on a network or server fault so the caller can retry with the
  /// same [a] (same `clientActionId`).
  Future<Outcome<Alert>> act(String id, AlertAction a) async {
    final out = await ref.read(alertsRepoProvider).act(id, a);
    final s = state.value;
    if (out is Applied<Alert> && s != null) {
      final moved = out.value == null || out.value!.status != filters.status;
      if (moved) state = AsyncData(s.copyWith(items: [for (final x in s.items) if (x.id != id) x]));
    }
    await refresh();
    ref.invalidate(unreadCountProvider);
    return out;
  }
}

final alertListProvider = AsyncNotifierProvider.autoDispose.family<AlertListNotifier, AlertList, AlertFilters>(
  AlertListNotifier.new,
  retry: (_, _) => null,
);

/// One zone's thresholds (null = the platform default), one per kind.
final alertRulesProvider = FutureProvider.autoDispose.family<List<AlertRule>, String?>(
  (ref, zoneId) {
    ref.watch(signedInProvider);
    return ref.read(alertsRepoProvider).rules(zoneId: zoneId);
  },
  retry: (_, _) => null,
);

final alertDetailProvider = FutureProvider.autoDispose.family<AlertDetail, String>(
  (ref, id) {
    ref.watch(signedInProvider);
    return ref.read(alertsRepoProvider).detail(id);
  },
  retry: (_, _) => null,
);
