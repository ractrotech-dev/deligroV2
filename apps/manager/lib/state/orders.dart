import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/orders.dart';
import 'providers.dart';

/// How often the Orders list and an open order re-ask (design: 10 s).
const ordersRefresh = Duration(seconds: 10);

/// The rows loaded so far, the cursor for the next page, and the queue counts.
class OrderListState {
  const OrderListState({
    required this.items,
    this.nextCursor,
    this.counts = const QueueCounts(),
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  final List<OrderListItem> items;
  final String? nextCursor;
  final QueueCounts counts;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  OrderListState copyWith({
    List<OrderListItem>? items,
    Object? nextCursor = _keep,
    QueueCounts? counts,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) =>
      OrderListState(
        items: items ?? this.items,
        nextCursor: identical(nextCursor, _keep) ? this.nextCursor : nextCursor as String?,
        counts: counts ?? this.counts,
        loadingMore: loadingMore ?? this.loadingMore,
        loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
      );
}

const _keep = Object();

/// The Orders list for one set of filters (zone included — the screen folds
/// the zone picker in before asking). Keyset-paged (`loadMore`) and refreshed
/// in place (`refresh`), so a poll never blanks the screen or drops the pages
/// already scrolled. A new set of filters is a new list.
class OrderListNotifier extends AsyncNotifier<OrderListState> {
  OrderListNotifier(this.filters);
  final OrderFilters filters;

  @override
  Future<OrderListState> build() async {
    ref.watch(signedInProvider);
    final page = await ref.read(ordersRepoProvider).list(filters);
    return OrderListState(items: page.items, nextCursor: page.nextCursor, counts: page.counts);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final page = await ref.read(ordersRepoProvider).list(filters, cursor: s.nextCursor);
      final now = state.value ?? s;
      final seen = {for (final o in now.items) o.id};
      state = AsyncData(now.copyWith(
        items: [...now.items, ...page.items.where((o) => !seen.contains(o.id))],
        nextCursor: page.nextCursor,
        loadingMore: false,
      ));
    } catch (_) {
      final now = state.value ?? s;
      state = AsyncData(now.copyWith(loadingMore: false, loadMoreFailed: true));
    }
  }

  /// Re-asks for page one and merges it over what is loaded: fresh rows
  /// replace their old copies, new ones go on top, and rows from later pages
  /// stay (with their cursor) so the manager's scroll position survives.
  Future<void> refresh() async {
    final s = state.value;
    if (s == null) {
      // Nothing on screen to keep (the first load failed): start over.
      ref.invalidateSelf();
      return;
    }
    try {
      final page = await ref.read(ordersRepoProvider).list(filters);
      final now = state.value ?? s;
      final fresh = {for (final o in page.items) o.id};
      final loadedBeyond = now.items.length > page.items.length && now.nextCursor != page.nextCursor;
      state = AsyncData(now.copyWith(
        items: [
          ...page.items,
          if (loadedBeyond) ...now.items.skip(page.items.length).where((o) => !fresh.contains(o.id)),
        ],
        nextCursor: loadedBeyond ? now.nextCursor : page.nextCursor,
        counts: page.counts,
      ));
    } catch (_) {
      // A failed background refresh keeps the rows on screen.
    }
  }
}

final orderListProvider = AsyncNotifierProvider.autoDispose.family<OrderListNotifier, OrderListState, OrderFilters>(
  OrderListNotifier.new,
  retry: (_, _) => null,
);
