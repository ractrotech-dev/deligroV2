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

  /// Re-asks for page one and merges it over what is loaded
  /// ([mergeRefreshedPage]): fresh rows replace their old copies, new ones go
  /// on top, rows pushed off page one by new arrivals stay, and rows from later
  /// pages stay (with their cursor) so the manager's scroll position survives.
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
      final complete = page.nextCursor == null;
      final items = mergeRefreshedPage(now.items, page.items, pageIsComplete: complete);
      final keptBeyond = items.length > page.items.length;
      state = AsyncData(now.copyWith(
        items: items,
        nextCursor: keptBeyond ? now.nextCursor : page.nextCursor,
        counts: page.counts,
      ));
    } catch (_) {
      // A failed background refresh keeps the rows on screen.
    }
  }
}

/// Page one, fetched again, merged over the rows already loaded — by id and
/// by the list's own order (newest first), never by position.
///
/// Every loaded row OLDER than the oldest row of the fresh page is kept: it
/// is either on a later page or was pushed there by new arrivals (positions
/// shift, ids do not). A loaded row inside the fresh page's window that the
/// fresh page no longer has has left the list (its status no longer matches
/// the filters) and is dropped rather than shown stale. A complete page (no
/// next cursor) is the whole list.
List<OrderListItem> mergeRefreshedPage(List<OrderListItem> loaded, List<OrderListItem> page, {required bool pageIsComplete}) {
  if (pageIsComplete || page.isEmpty) return page;
  final fresh = {for (final o in page) o.id};
  final boundary = page.last;
  bool olderThanBoundary(OrderListItem o) {
    final a = o.createdAt, b = boundary.createdAt;
    if (a == null || b == null) return false;
    final c = a.compareTo(b);
    return c < 0 || (c == 0 && o.id.compareTo(boundary.id) < 0);
  }

  return [...page, ...loaded.where((o) => !fresh.contains(o.id) && olderThanBoundary(o))];
}

final orderListProvider = AsyncNotifierProvider.autoDispose.family<OrderListNotifier, OrderListState, OrderFilters>(
  OrderListNotifier.new,
  retry: (_, _) => null,
);

/// One order, re-asked every 10 s while its screen is open. `act` sends an
/// intervention and adopts the order the server returns, so the screen shows
/// the result of the action rather than a guess at it.
class OrderDetailNotifier extends AsyncNotifier<OrderDetail> {
  OrderDetailNotifier(this.orderId);
  final String orderId;

  @override
  Future<OrderDetail> build() async {
    ref.watch(signedInProvider);
    return ref.read(ordersRepoProvider).detail(orderId);
  }

  /// Re-fetch in place; a failed background refresh keeps what is shown.
  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final next = await AsyncValue.guard(() => ref.read(ordersRepoProvider).detail(orderId));
    if (next.hasValue) state = next;
  }

  /// Throws [ApiException] on a network or server fault, so the caller can
  /// offer Retry with the same [action] (and so the same clientActionId).
  Future<ActionOutcome> act(OrderAction action) async {
    final out = await ref.read(ordersRepoProvider).act(orderId, action);
    switch (out) {
      case ActionDone(:final order?):
        state = AsyncData(order);
      case ActionDone():
        // Applied, but the server couldn't re-read the order: fetch it.
        await refresh();
      case ActionRefused():
        // The order moved under us (or the action no longer applies): show
        // where it actually is.
        await refresh();
    }
    return out;
  }
}

final orderDetailProvider = AsyncNotifierProvider.autoDispose.family<OrderDetailNotifier, OrderDetail, String>(
  OrderDetailNotifier.new,
  retry: (_, _) => null,
);
