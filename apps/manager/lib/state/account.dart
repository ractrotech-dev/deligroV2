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
/// server refuses it.
class NotificationPrefsNotifier extends AsyncNotifier<List<AlertKindPref>> {
  @override
  Future<List<AlertKindPref>> build() => ref.read(managerRepoProvider).notificationPrefs();

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

final notificationPrefsProvider =
    AsyncNotifierProvider<NotificationPrefsNotifier, List<AlertKindPref>>(NotificationPrefsNotifier.new);
