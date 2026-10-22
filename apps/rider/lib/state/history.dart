import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/money.dart';
import '../features/history/history_filters.dart';
import '../models/insights.dart';
import 'clock.dart';
import 'insights.dart';
import 'providers.dart';

/// History's list: the filter, the rows so far, and where the next page starts.
class HistoryListState {
  const HistoryListState({
    this.filter = const HistoryFilter(),
    this.items = const [],
    this.nextCursor,
    this.loading = false,
    this.loadingMore = false,
    this.loaded = false,
    this.error,
    this.moreError,
  });

  final HistoryFilter filter;
  final List<HistoryItem> items;
  final String? nextCursor;

  /// The first page of the current filter is on its way.
  final bool loading;
  final bool loadingMore;

  /// The first page of the current filter has arrived.
  final bool loaded;

  /// The first page failed (nothing to show).
  final Object? error;

  /// A later page failed (the rows so far stay).
  final Object? moreError;

  bool get hasMore => nextCursor != null;

  HistoryListState copyWith({
    HistoryFilter? filter,
    List<HistoryItem>? items,
    String? Function()? nextCursor,
    bool? loading,
    bool? loadingMore,
    bool? loaded,
    Object? Function()? error,
    Object? Function()? moreError,
  }) => HistoryListState(
    filter: filter ?? this.filter,
    items: items ?? this.items,
    nextCursor: nextCursor != null ? nextCursor() : this.nextCursor,
    loading: loading ?? this.loading,
    loadingMore: loadingMore ?? this.loadingMore,
    loaded: loaded ?? this.loaded,
    error: error != null ? error() : this.error,
    moreError: moreError != null ? moreError() : this.moreError,
  );
}

/// Pages through `GET /api/rider/history` by cursor, 20 a page. A new filter
/// starts over; an answer for an older filter is dropped.
class HistoryListNotifier extends Notifier<HistoryListState> {
  int _generation = 0;

  @override
  HistoryListState build() {
    // A different rider starts with a clean list.
    ref.listen(meProvider.select((m) => m.value?.id), (prev, next) {
      if (prev != null && prev != next) {
        _generation++;
        state = const HistoryListState();
      }
    });
    return const HistoryListState();
  }

  String get _today => istDayKey(ref.read(clockProvider)());

  /// Pages the "Not delivered" filter reads, at most, to fill a page: the
  /// server only filters by one outcome, so it asks for every job and drops
  /// the delivered ones here.
  static const _maxNotDeliveredReads = 8;

  /// One page for [f] from [cursor]. For "Not delivered", keeps reading until
  /// a page's worth is in hand (or the pages run out), so a day of mostly
  /// delivered jobs does not look empty.
  ///
  /// [gen] is the generation the caller started in: when another load has
  /// taken over between two reads, the loop stops there instead of reading on
  /// for an answer that will be thrown away. A failed read (a 429 too) throws
  /// to the caller, who shows "Try again".
  Future<HistoryPage> _fetch(HistoryFilter f, String? cursor, int gen) async {
    final q = f.query(_today);
    final repo = ref.read(insightsRepoProvider);
    if (!f.notDelivered) {
      return repo.history(
        from: q.from,
        to: q.to,
        outcome: q.outcome,
        cursor: cursor,
      );
    }
    final kept = <HistoryItem>[];
    String? next = cursor;
    for (var reads = 0; reads < _maxNotDeliveredReads; reads++) {
      final page = await repo.history(from: q.from, to: q.to, cursor: next);
      kept.addAll(
        page.items.where((i) => i.outcome != HistoryOutcome.delivered),
      );
      next = page.nextCursor;
      if (next == null || kept.length >= _pageSize || gen != _generation) {
        break;
      }
    }
    return HistoryPage(items: kept, nextCursor: next);
  }

  static const _pageSize = 20;

  /// Loads the first page of the current filter.
  Future<void> load() async {
    final gen = ++_generation;
    final f = state.filter;
    state = state.copyWith(
      loading: true,
      loadingMore: false,
      error: () => null,
      moreError: () => null,
    );
    try {
      final page = await _fetch(f, null, gen);
      if (gen != _generation) return;
      state = state.copyWith(
        items: page.items,
        nextCursor: () => page.nextCursor,
        loading: false,
        loaded: true,
      );
    } catch (e) {
      if (gen != _generation) return;
      state = state.copyWith(loading: false, error: () => e);
    }
  }

  /// Starts over with [filter] (no-op when it is the one already showing and
  /// its page has arrived).
  Future<void> setFilter(HistoryFilter filter, {bool force = false}) {
    if (!force && filter == state.filter && (state.loaded || state.loading)) {
      return Future.value();
    }
    state = HistoryListState(filter: filter);
    return load();
  }

  /// The next page, when there is one and none is already on its way. After a
  /// failed page nothing asks again by itself (scrolling would hammer the
  /// server every frame): only [retry], from the "Try again" button, does.
  Future<void> loadMore({bool retry = false}) async {
    final cursor = state.nextCursor;
    if (cursor == null || state.loading || state.loadingMore) return;
    if (state.moreError != null && !retry) return;
    final gen = _generation;
    state = state.copyWith(loadingMore: true, moreError: () => null);
    try {
      final page = await _fetch(state.filter, cursor, gen);
      if (gen != _generation) return;
      state = state.copyWith(
        items: [...state.items, ...page.items],
        nextCursor: () => page.nextCursor,
        loadingMore: false,
      );
    } catch (e) {
      if (gen != _generation) return;
      state = state.copyWith(loadingMore: false, moreError: () => e);
    }
  }
}

final historyListProvider =
    NotifierProvider<HistoryListNotifier, HistoryListState>(
      HistoryListNotifier.new,
    );

/// One finished delivery in full. Dropped when its screen is left, so the
/// 10-minute photo link is fetched fresh the next time.
final historyDetailProvider = FutureProvider.autoDispose
    .family<HistoryDetail, String>(
      retry: (_, _) => null,
      (ref, orderId) => ref.watch(insightsRepoProvider).historyDetail(orderId),
    );

/// Targets, times, rates, ratings and the monthly report for one rider. Keyed
/// by the rider's id (like the dashboard), so another rider never sees the
/// last one's numbers while theirs load or fail.
final performanceProvider = FutureProvider.autoDispose
    .family<RiderPerformance, String>(
      retry: (_, _) => null,
      (ref, riderId) => ref.watch(insightsRepoProvider).performance(),
    );
