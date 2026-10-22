import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/support_ops.dart';
import 'paged.dart';
import 'providers.dart';

typedef TicketList = Paged<TicketListItem, TicketCounts>;

/// The support queue polls this often while it is on screen.
const supportQueueRefresh = Duration(seconds: 15);

/// The support queue for one set of filters (zone folded in by the screen).
/// Keyset-paged; a refresh merges by id so later pages never lose rows.
class TicketListNotifier extends AsyncNotifier<TicketList> {
  TicketListNotifier(this.filters);
  final TicketFilters filters;

  static String _id(TicketListItem t) => t.id;

  @override
  Future<TicketList> build() async {
    ref.watch(signedInProvider);
    final p = await ref.read(ticketsRepoProvider).list(filters);
    return Paged.first(p.items, p.nextCursor, p.counts);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await ref.read(ticketsRepoProvider).list(filters, cursor: s.nextCursor);
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
      final p = await ref.read(ticketsRepoProvider).list(filters);
      state = AsyncData((state.value ?? s).refreshedWith(p.items, p.nextCursor, p.counts, _id));
    } catch (_) {
      // A failed background refresh keeps what is on screen.
    }
  }
}

final ticketListProvider = AsyncNotifierProvider.autoDispose.family<TicketListNotifier, TicketList, TicketFilters>(
  TicketListNotifier.new,
  retry: (_, _) => null,
);

/// A metrics request: inclusive dates and an optional zone.
typedef MetricsQuery = ({DateTime from, DateTime to, String? zoneId});

final ticketMetricsProvider = FutureProvider.autoDispose.family<TicketMetrics, MetricsQuery>(
  (ref, q) {
    ref.watch(signedInProvider);
    return ref.read(ticketsRepoProvider).metrics(from: q.from, to: q.to, zoneId: q.zoneId);
  },
  retry: (_, _) => null,
);

/// Who a ticket in this zone can be assigned to.
final ticketAssigneesProvider = FutureProvider.autoDispose.family<AssigneeList, String?>(
  (ref, zoneId) {
    ref.watch(signedInProvider);
    return ref.read(ticketsRepoProvider).assignees(zoneId: zoneId);
  },
  retry: (_, _) => null,
);
