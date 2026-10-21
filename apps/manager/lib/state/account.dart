import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/account.dart';
import 'providers.dart';
import 'session.dart';

/// Every manager power, labelled, with this person's state.
final permissionsProvider = FutureProvider.autoDispose<List<PermissionInfo>>((ref) {
  ref.watch(managerMeProvider);
  return ref.watch(managerRepoProvider).permissions();
});

final sessionsProvider = FutureProvider.autoDispose<List<SessionInfo>>(
  (ref) => ref.watch(managerRepoProvider).sessions(),
);

/// Push switches per alert kind. A toggle shows at once and rolls back if the
/// server refuses it. Rebuilt on every sign-in and empty while signed out, so
/// one person's switches are never shown to the next person on the phone.
class NotificationPrefsNotifier extends AsyncNotifier<List<AlertKindPref>> {
  @override
  Future<List<AlertKindPref>> build() async {
    if (!ref.watch(signedInProvider)) return const [];
    return ref.read(managerRepoProvider).notificationPrefs();
  }

  Future<void> toggle(String kind, bool push) async {
    final before = state.value;
    if (before == null) return;
    state = AsyncData([for (final p in before) p.kind == kind ? p.copyWith(push: push) : p]);
    try {
      await ref.read(managerRepoProvider).setNotificationPref(kind, push);
    } catch (e) {
      state = AsyncData(before);
      rethrow;
    }
  }
}

final notificationPrefsProvider = AsyncNotifierProvider.autoDispose<NotificationPrefsNotifier, List<AlertKindPref>>(
  NotificationPrefsNotifier.new,
);
