import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/inbox.dart';
import 'paged.dart';
import 'providers.dart';

/// The bell re-asks this often while the app is in front.
const unreadRefresh = Duration(seconds: 30);

/// The bell's numbers. Refreshed in place, so the badge never blinks out
/// while it re-asks; empty while signed out.
class UnreadCountNotifier extends AsyncNotifier<UnreadCount> {
  @override
  Future<UnreadCount> build() async {
    if (!ref.watch(signedInProvider)) return const UnreadCount();
    return ref.read(inboxRepoProvider).unreadCount();
  }

  Future<void> refresh() async {
    final next = await AsyncValue.guard(() => ref.read(inboxRepoProvider).unreadCount());
    if (next.hasValue) state = next;
  }

  /// After marking items read, adopt the server's unread count.
  void setUnread(int unread) {
    final v = state.value;
    if (v != null) state = AsyncData(UnreadCount(unread: unread, openAlerts: v.openAlerts, criticalAlerts: v.criticalAlerts));
  }
}

final unreadCountProvider = AsyncNotifierProvider<UnreadCountNotifier, UnreadCount>(
  UnreadCountNotifier.new,
  retry: (_, _) => null,
);

typedef InboxList = Paged<InboxItem, int>;

/// The inbox, newest first. Opening an item marks it read here at once and
/// on the server.
class InboxNotifier extends AsyncNotifier<InboxList> {
  static String _id(InboxItem i) => i.id;

  @override
  Future<InboxList> build() async {
    ref.watch(signedInProvider);
    final p = await ref.read(inboxRepoProvider).list();
    return Paged.first(p.items, p.nextCursor, p.unread);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await ref.read(inboxRepoProvider).list(cursor: s.nextCursor);
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
      final p = await ref.read(inboxRepoProvider).list();
      state = AsyncData((state.value ?? s).refreshedWith(p.items, p.nextCursor, p.unread, _id));
    } catch (_) {
      // Keep what is on screen.
    }
  }

  /// Marks [ids] (or everything) read. Best effort: the row shows read at
  /// once; a failed call leaves it to the next refresh.
  Future<void> markRead({List<String>? ids, bool all = false}) async {
    final s = state.value;
    if (s != null) {
      final now = DateTime.now();
      state = AsyncData(s.copyWith(items: [
        for (final i in s.items) (all || (ids ?? const []).contains(i.id)) ? i.markedRead(now) : i,
      ]));
    }
    try {
      final unread = await ref.read(inboxRepoProvider).markRead(ids: ids, all: all);
      ref.read(unreadCountProvider.notifier).setUnread(unread);
      final s2 = state.value;
      if (s2 != null) state = AsyncData(s2.copyWith(counts: unread));
    } catch (_) {
      // The next refresh tells the truth.
    }
  }
}

final inboxProvider = AsyncNotifierProvider.autoDispose<InboxNotifier, InboxList>(
  InboxNotifier.new,
  retry: (_, _) => null,
);
