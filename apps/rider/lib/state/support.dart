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
import 'user_data.dart';

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

/// Keeps Deligro's numbers on the phone (they are Deligro's, not the rider's).
Future<void> saveSupportContact(SharedPreferences prefs, SupportContact contact) async {
  if (!contact.hasPhone && !contact.hasWhatsapp) return;
  try {
    await prefs.setString(_contactKey, jsonEncode(contact.toJson()));
  } catch (_) {}
}

/// The Help page: tickets, numbers and the category list. Dropped when the
/// page is left, so coming back asks again.
final supportOverviewProvider = FutureProvider.autoDispose.family<SupportOverview, String>(
  retry: (_, _) => null,
  (ref, riderKey) async {
    final overview = await ref.watch(supportRepoProvider).overview();
    await saveSupportContact(ref.read(prefsProvider), overview.contact);
    return overview;
  },
);

/// Deligro's numbers: the server's, else the copy from the last time.
final supportContactProvider = FutureProvider.autoDispose.family<SupportContact, String>(
  retry: (_, _) => null,
  (ref, riderKey) async {
    try {
      return (await ref.watch(supportOverviewProvider(riderKey).future)).contact;
    } on ApiException {
      return savedSupportContact(ref.read(prefsProvider));
    }
  },
);

/// One ticket's thread, for one rider: keyed by ([riderKeyProvider], ticket id).
final ticketThreadProvider = FutureProvider.autoDispose.family<TicketThread, ({String rider, String id})>(
  retry: (_, _) => null,
  (ref, key) => ref.watch(supportRepoProvider).thread(key.id),
);

/// The orders a ticket can be about: the delivery the rider is carrying now
/// first, then their recent ones.
final recentOrdersProvider = FutureProvider.autoDispose.family<List<RecentOrder>, String>(
  retry: (_, _) => null,
  (ref, riderKey) async {
    RecentOrder? active;
    try {
      final a = ref.read(activeCacheProvider).load();
      if (a != null) active = RecentOrder(orderId: a.orderId, code: a.code, shop: a.shop.name);
    } catch (_) {}
    final history = await ref.watch(supportRepoProvider).recentOrders();
    return [
      ?active,
      for (final o in history)
        if (o.orderId != active?.orderId) o,
    ];
  },
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

/// One rider's inbox (keyed by [riderKeyProvider]: another rider on this
/// phone gets a new inbox with no value, never this one's rows or count).
class InboxNotifier extends AsyncNotifier<InboxState> {
  InboxNotifier(this.riderKey);

  final String riderKey;

  @override
  Future<InboxState> build() async {
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

final inboxProvider = AsyncNotifierProvider.autoDispose.family<InboxNotifier, InboxState, String>(
  InboxNotifier.new,
  retry: (_, _) => null,
);

/// The red number on the bell and on More, for the signed-in rider. Zero when
/// their inbox cannot be read (or has not answered yet).
final unreadCountProvider = Provider.autoDispose<int>(
  (ref) => ref.watch(inboxProvider(ref.watch(riderKeyProvider))).value?.unread ?? 0,
);

/// Live announcements, pinned at the top of the inbox (one rider's: keyed by
/// [riderKeyProvider]).
final announcementsProvider = FutureProvider.autoDispose.family<List<Announcement>, String>(
  retry: (_, _) => null,
  (ref, riderKey) => ref.watch(notificationsRepoProvider).announcements(),
);

const _prefsKey = 'notification_prefs_v1';

/// The rider's notification switches. Held on the phone as well (under their
/// user id), so Settings shows them at once and with no signal; the server's
/// copy (which the push sender reads) is what a save has to reach. Another
/// rider signing in starts from their own, never the last rider's.
class NotificationPrefsNotifier extends Notifier<NotificationPrefs> {
  @override
  NotificationPrefs build() {
    final uid = _uid(watch: true);
    final saved = _readLocal(uid);
    unawaited(_sync(uid));
    return saved;
  }

  /// The signed-in user's id; null when there is no session to ask.
  String? _uid({bool watch = false}) {
    try {
      return watch ? ref.watch(userIdProvider) : ref.read(userIdProvider);
    } catch (_) {
      return null;
    }
  }

  NotificationPrefs _readLocal(String? uid) {
    try {
      final raw = readUserString(ref.read(prefsProvider), _prefsKey, uid);
      return raw == null ? const NotificationPrefs() : NotificationPrefs.fromJson(jsonDecode(raw));
    } catch (_) {
      return const NotificationPrefs();
    }
  }

  Future<void> _writeLocal(String? uid, NotificationPrefs p) async {
    try {
      await writeUserString(ref.read(prefsProvider), _prefsKey, uid, jsonEncode(p.toJson()));
    } catch (_) {}
  }

  Future<void> _sync(String? uid) async {
    try {
      final server = await ref.read(notificationsRepoProvider).loadPrefs();
      // Gone, or someone else is signed in by now: this answer is not theirs.
      if (server == null || !ref.mounted || _uid() != uid) return;
      state = server;
      await _writeLocal(uid, server);
    } catch (_) {
      // Offline: the copy on the phone stands.
    }
  }

  /// Switches [key]. A locked category never changes. Returns false when the
  /// server did not take the change; the switch is put back.
  Future<bool> set(String key, bool on) async {
    if (isLockedCategory(key)) return false;
    final uid = _uid();
    final before = state;
    final next = before.set(key, on);
    if (identical(next, before)) return true;
    state = next;
    try {
      await ref.read(notificationsRepoProvider).savePrefs(next);
      await _writeLocal(uid, next);
      return true;
    } catch (_) {
      if (ref.mounted && _uid() == uid) state = before;
      return false;
    }
  }
}

final notificationPrefsProvider =
    NotifierProvider<NotificationPrefsNotifier, NotificationPrefs>(NotificationPrefsNotifier.new);
