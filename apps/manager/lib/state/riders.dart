import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/outcome.dart';
import '../models/rider.dart';
import 'paged.dart';
import 'providers.dart';

typedef RiderList = Paged<RiderListItem, RiderCounts>;

/// The Riders list for one set of filters (zone folded in by the screen).
/// Keyset-paged; refreshed in place by pull-to-refresh and the 30 s poll.
class RiderListNotifier extends AsyncNotifier<RiderList> {
  RiderListNotifier(this.filters);
  final RiderFilters filters;

  static String _id(RiderListItem r) => r.id;

  @override
  Future<RiderList> build() async {
    ref.watch(signedInProvider);
    final p = await ref.read(ridersRepoProvider).list(filters);
    return Paged.first(p.items, p.nextCursor, p.counts);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await ref.read(ridersRepoProvider).list(filters, cursor: s.nextCursor);
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
      final p = await ref.read(ridersRepoProvider).list(filters);
      state = AsyncData((state.value ?? s).refreshedWith(p.items, p.nextCursor, p.counts, _id));
    } catch (_) {
      // A failed background refresh keeps what is on screen.
    }
  }
}

final riderListProvider = AsyncNotifierProvider.autoDispose.family<RiderListNotifier, RiderList, RiderFilters>(
  RiderListNotifier.new,
  retry: (_, _) => null,
);

/// One rider. `act` sends an audited decision and adopts the rider the
/// server returns; on a refusal (someone else moved them) it re-reads.
class RiderDetailNotifier extends AsyncNotifier<RiderDetail> {
  RiderDetailNotifier(this.riderId);
  final String riderId;

  @override
  Future<RiderDetail> build() async {
    ref.watch(signedInProvider);
    return ref.read(ridersRepoProvider).detail(riderId);
  }

  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final next = await AsyncValue.guard(() => ref.read(ridersRepoProvider).detail(riderId));
    if (next.hasValue) state = next;
  }

  /// Throws on a network or server fault so the caller can retry with the
  /// same action (same `clientActionId`).
  Future<Outcome<RiderDetail>> act(RiderAction a) async {
    final out = await ref.read(ridersRepoProvider).act(riderId, a);
    switch (out) {
      case Applied(:final value?):
        state = AsyncData(value);
      case Applied():
        await refresh();
      case Refused():
        await refresh();
    }
    return out;
  }
}

final riderDetailProvider = AsyncNotifierProvider.autoDispose.family<RiderDetailNotifier, RiderDetail, String>(
  RiderDetailNotifier.new,
  retry: (_, _) => null,
);

/// What the Deliveries tab asks for: one rider, an outcome and a date range.
class RiderHistoryQuery {
  const RiderHistoryQuery(this.riderId, {this.outcome, this.from, this.to});
  final String riderId;
  final RiderOutcome? outcome;
  final DateTime? from;
  final DateTime? to;

  @override
  bool operator ==(Object other) =>
      other is RiderHistoryQuery &&
      other.riderId == riderId &&
      other.outcome == outcome &&
      other.from == from &&
      other.to == to;

  @override
  int get hashCode => Object.hash(riderId, outcome, from, to);
}

typedef RiderHistory = Paged<RiderHistoryItem, HistoryTotals>;

class RiderHistoryNotifier extends AsyncNotifier<RiderHistory> {
  RiderHistoryNotifier(this.query);
  final RiderHistoryQuery query;

  static String _id(RiderHistoryItem h) => '${h.orderId}/${h.endedAt?.toIso8601String()}';

  Future<RiderHistoryPage> _page([String? cursor]) => ref
      .read(ridersRepoProvider)
      .history(query.riderId, from: query.from, to: query.to, outcome: query.outcome, cursor: cursor);

  @override
  Future<RiderHistory> build() async {
    ref.watch(signedInProvider);
    final p = await _page();
    return Paged.first(p.items, p.nextCursor, p.totals);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await _page(s.nextCursor);
      state = AsyncData((state.value ?? s).append(p.items, p.nextCursor, _id));
    } catch (_) {
      state = AsyncData((state.value ?? s).copyWith(loadingMore: false, loadMoreFailed: true));
    }
  }
}

final riderHistoryProvider =
    AsyncNotifierProvider.autoDispose.family<RiderHistoryNotifier, RiderHistory, RiderHistoryQuery>(
  RiderHistoryNotifier.new,
  retry: (_, _) => null,
);
