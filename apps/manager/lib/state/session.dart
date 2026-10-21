import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api.dart';
import '../models/manager_me.dart';
import 'providers.dart';

/// The signed-in manager, or null when signed out.
///
/// Errors are kept, not swallowed: the router sends 403 `forbidden` to the
/// "not a manager" screen and anything else to the boot screen's Retry. A 401
/// means the session is gone, so it signs out — the router then shows login.
class ManagerMeNotifier extends AsyncNotifier<ManagerMe?> {
  @override
  Future<ManagerMe?> build() async {
    if (!ref.watch(signedInProvider)) return null;
    try {
      return await ref.read(managerRepoProvider).me();
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await ref.read(authRepoProvider).signOut();
        return null;
      }
      rethrow;
    }
  }

  Future<void> reload() async {
    state = const AsyncLoading();
    ref.invalidateSelf();
    await future;
  }
}

final managerMeProvider = AsyncNotifierProvider<ManagerMeNotifier, ManagerMe?>(ManagerMeNotifier.new);

/// True when the error means "this account is not a manager", not a fault.
bool isNotManagerError(Object? error) =>
    error is ApiException && error.status == 403 && error.code == 'forbidden';

/// Any screen's API call that answers 401: the session is over everywhere.
Future<void> handleUnauthorized(WidgetRef ref, Object error) async {
  if (error is ApiException && error.unauthorized) {
    await ref.read(authRepoProvider).signOut();
  }
}
