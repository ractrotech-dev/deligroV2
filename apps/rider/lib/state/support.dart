import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/api.dart';
import '../data/fixtures/fixture_backend.dart';
import '../data/fixtures/fixture_support.dart';
import '../data/notifications_repository.dart';
import '../data/support_repository.dart';
import '../models/inbox.dart';
import '../models/support.dart';
import 'prefs.dart';
import 'providers.dart';

/// The help routes, or in a debug build started with FIXTURES=true the
/// in-memory fixture backend. `fixturesEnabled` is a compile-time false in a
/// release build, so the fixture branch (and its data) is not in the app.
final supportRepoProvider = Provider<SupportRepository>((ref) {
  if (fixturesEnabled) return FixtureSupportRepository.create();
  return ApiSupportRepository(ref.watch(apiProvider));
});

final notificationsRepoProvider = Provider<NotificationsRepository>((ref) {
  if (fixturesEnabled) return FixtureNotificationsRepository.create();
  return ApiNotificationsRepository(ref.watch(apiProvider));
});

const _contactKey = 'support_contact_v1';

/// Deligro's support numbers, kept on the phone so "Call Deligro support"
/// still works with no signal.
SupportContact savedSupportContact(SharedPreferences prefs) {
  try {
    final raw = prefs.getString(_contactKey);
    if (raw == null) return SupportContact.none;
    return SupportContact.fromJson(jsonDecode(raw));
  } catch (_) {
    return SupportContact.none;
  }
}

/// The Help page: tickets, numbers and the category list. Dropped when the
/// page is left, so coming back asks again.
final supportOverviewProvider = FutureProvider.autoDispose<SupportOverview>(
  retry: (_, _) => null,
  (ref) async {
    final overview = await ref.watch(supportRepoProvider).overview();
    if (overview.contact.hasPhone || overview.contact.hasWhatsapp) {
      try {
        await ref.read(prefsProvider).setString(_contactKey, jsonEncode(overview.contact.toJson()));
      } catch (_) {}
    }
    return overview;
  },
);

/// Deligro's numbers: the server's, else the copy from the last time.
final supportContactProvider = FutureProvider.autoDispose<SupportContact>(
  retry: (_, _) => null,
  (ref) async {
    try {
      return (await ref.watch(supportOverviewProvider.future)).contact;
    } on ApiException {
      return savedSupportContact(ref.read(prefsProvider));
    }
  },
);

final ticketThreadProvider = FutureProvider.autoDispose.family<TicketThread, String>(
  retry: (_, _) => null,
  (ref, id) => ref.watch(supportRepoProvider).thread(id),
);

final recentOrdersProvider = FutureProvider.autoDispose<List<RecentOrder>>(
  retry: (_, _) => null,
  (ref) => ref.watch(supportRepoProvider).recentOrders(),
);

/// The inbox as the screen shows it, with the page it can still load.
class InboxState {
  const InboxState({
    required this.items,
    required this.unread,
    this.hasMore = false,
    this.nextBefore,
    this.loadingMore = false,
  });

  final List<InboxItem> items;
  final int unread;
  final bool hasMore;
  final String? nextBefore;
  final bool loadingMore;

  InboxState copyWith({List<InboxItem>? items, int? unread, bool? hasMore, String? nextBefore, bool? loadingMore}) =>
      InboxState(
        items: items ?? this.items,
        unread: unread ?? this.unread,
        hasMore: hasMore ?? this.hasMore,
        nextBefore: nextBefore ?? this.nextBefore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class InboxNotifier extends AsyncNotifier<InboxState> {
  @override
  Future<InboxState> build() async {
    // Only a signed-in rider has an inbox; a new session asks again.
    ref.watch(userIdProvider);
    final page = await ref.watch(notificationsRepoProvider).inbox();
    return InboxState(items: page.items, unread: page.unread, hasMore: page.hasMore, nextBefore: page.nextBefore);
  }

  /// The next, older page.
  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true));
    try {
      final page = await ref.read(notificationsRepoProvider).inbox(before: s.nextBefore);
      final cur = state.value ?? s;
      state = AsyncData(InboxState(
        items: [...cur.items, ...page.items],
        unread: page.unread,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
      ));
    } catch (_) {
      state = AsyncData((state.value ?? s).copyWith(loadingMore: false));
    }
  }

  /// A tap on one: it reads as read at once, the server hears in the
  /// background (a failure only leaves it unread on the next load).
  Future<void> markRead(String id) async {
    final s = state.value;
    if (s == null) return;
    final item = s.items.where((e) => e.id == id).firstOrNull;
    if (item == null || item.read) return;
    state = AsyncData(s.copyWith(
      items: [for (final e in s.items) e.id == id ? e.asRead() : e],
      unread: (s.unread - 1).clamp(0, 1 << 30),
    ));
    try {
      await ref.read(notificationsRepoProvider).markRead([id]);
    } catch (_) {}
  }

  /// "Mark all read". Returns false when the server did not take it.
  Future<bool> markAllRead() async {
    final s = state.value;
    if (s == null) return true;
    state = AsyncData(s.copyWith(items: [for (final e in s.items) e.asRead()], unread: 0));
    try {
      await ref.read(notificationsRepoProvider).markAllRead();
      return true;
    } catch (_) {
      state = AsyncData(s);
      return false;
    }
  }
}

final inboxProvider = AsyncNotifierProvider<InboxNotifier, InboxState>(
  InboxNotifier.new,
  retry: (_, _) => null,
);

/// The red number on the bell and on More. Zero when the inbox cannot be read.
final unreadCountProvider = Provider<int>((ref) => ref.watch(inboxProvider).value?.unread ?? 0);

/// Live announcements, pinned at the top of the inbox.
final announcementsProvider = FutureProvider.autoDispose<List<Announcement>>(
  retry: (_, _) => null,
  (ref) => ref.watch(notificationsRepoProvider).announcements(),
);

const _prefsKey = 'notification_prefs_v1';

/// The rider's notification switches. Held on the phone as well, so Settings
/// shows them at once and with no signal; the server's copy (which the push
/// sender reads) is what a save has to reach.
class NotificationPrefsNotifier extends Notifier<NotificationPrefs> {
  @override
  NotificationPrefs build() {
    final saved = _readLocal();
    unawaited(_sync());
    return saved;
  }

  NotificationPrefs _readLocal() {
    try {
      final raw = ref.read(prefsProvider).getString(_prefsKey);
      return raw == null ? const NotificationPrefs() : NotificationPrefs.fromJson(jsonDecode(raw));
    } catch (_) {
      return const NotificationPrefs();
    }
  }

  Future<void> _writeLocal(NotificationPrefs p) async {
    try {
      await ref.read(prefsProvider).setString(_prefsKey, jsonEncode(p.toJson()));
    } catch (_) {}
  }

  Future<void> _sync() async {
    try {
      final server = await ref.read(notificationsRepoProvider).loadPrefs();
      if (server == null || !ref.mounted) return;
      state = server;
      await _writeLocal(server);
    } catch (_) {
      // Offline: the copy on the phone stands.
    }
  }

  /// Switches [key]. A locked category never changes. Returns false when the
  /// server did not take the change; the switch is put back.
  Future<bool> set(String key, bool on) async {
    if (isLockedCategory(key)) return false;
    final before = state;
    final next = before.set(key, on);
    if (identical(next, before)) return true;
    state = next;
    try {
      await ref.read(notificationsRepoProvider).savePrefs(next);
      await _writeLocal(next);
      return true;
    } catch (_) {
      if (ref.mounted) state = before;
      return false;
    }
  }
}

final notificationPrefsProvider =
    NotifierProvider<NotificationPrefsNotifier, NotificationPrefs>(NotificationPrefsNotifier.new);
