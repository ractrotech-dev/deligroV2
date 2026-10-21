import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/growth_repository.dart';
import '../models/growth.dart';
import 'providers.dart';

final growthRepoProvider = Provider((ref) => GrowthRepository(ref.watch(apiProvider)));

final offersProvider = FutureProvider.autoDispose<OffersState>((ref) {
  ref.watch(activeShopSlugProvider);
  return ref.watch(growthRepoProvider).offers();
});

final reviewsProvider = FutureProvider.autoDispose.family<ReviewsState, int>((ref, days) {
  ref.watch(activeShopSlugProvider);
  return ref.watch(growthRepoProvider).reviews(days: days);
});

final marketingProvider = FutureProvider.autoDispose<List<MarketingRequest>>((ref) {
  ref.watch(activeShopSlugProvider);
  return ref.watch(growthRepoProvider).marketing();
});

final ticketsProvider = FutureProvider.autoDispose<List<Ticket>>((ref) => ref.watch(growthRepoProvider).tickets());

final ticketProvider = FutureProvider.autoDispose.family<TicketThread, String>(
  (ref, id) => ref.watch(growthRepoProvider).ticket(id),
);

/// The inbox, refreshed every minute while the app is in front so the unread
/// badge stays honest without a push.
class InboxNotifier extends AsyncNotifier<Inbox> {
  static const interval = Duration(seconds: 60);
  Timer? _timer;

  @override
  Future<Inbox> build() {
    _timer?.cancel();
    _timer = Timer.periodic(interval, (_) {
      final life = WidgetsBinding.instance.lifecycleState;
      if (life == null || life == AppLifecycleState.resumed) refresh();
    });
    ref.onDispose(() => _timer?.cancel());
    return ref.read(growthRepoProvider).inbox();
  }

  Future<void> refresh() async {
    try {
      state = AsyncData(await ref.read(growthRepoProvider).inbox());
    } catch (e, st) {
      if (state.value == null) state = AsyncError(e, st);
    }
  }

  /// Marks one read locally at once, then on the server.
  Future<void> markRead(String id) async {
    final s = state.value;
    if (s != null) {
      final items = [for (final i in s.items) i.id == id ? i.asRead() : i];
      final wasUnread = s.items.any((i) => i.id == id && !i.read);
      state = AsyncData(
        Inbox(
          available: s.available,
          items: items,
          unread: wasUnread ? (s.unread - 1).clamp(0, 1 << 30) : s.unread,
          announcements: s.announcements,
          hasMore: s.hasMore,
        ),
      );
    }
    try {
      await ref.read(growthRepoProvider).markRead([id]);
    } catch (_) {
      // The next refresh shows the truth.
    }
  }

  Future<void> markAllRead() async {
    await ref.read(growthRepoProvider).markAllRead();
    await refresh();
  }
}

final inboxProvider = AsyncNotifierProvider<InboxNotifier, Inbox>(InboxNotifier.new);

/// Unread count for badges; 0 while loading or before 0064.
final unreadCountProvider = Provider<int>((ref) => ref.watch(inboxProvider).value?.unread ?? 0);
