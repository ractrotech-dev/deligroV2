import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';
import '../data/auth_repository.dart';
import '../data/rider_repository.dart';
import '../models/rider_me.dart';

// ---------- Infrastructure ----------

final supabaseProvider = Provider<SupabaseClient>((_) => Supabase.instance.client);

final apiProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(supabaseProvider).auth));

final authRepoProvider = Provider(
  (ref) => AuthRepository(ref.watch(supabaseProvider), ref.watch(apiProvider)),
);
final riderRepoProvider = Provider((ref) => RiderRepository(ref.watch(apiProvider)));

// ---------- Session ----------

final authStateProvider = StreamProvider<AuthState>(
  (ref) => ref.watch(supabaseProvider).auth.onAuthStateChange,
);

/// The signed-in user's id, or null. Rebuilds dependants on sign-in/out.
final userIdProvider = Provider<String?>((ref) {
  ref.watch(authStateProvider);
  return ref.watch(supabaseProvider).auth.currentUser?.id;
});


/// Who the signed-in rider is: `GET /api/rider/me`. The router's gate reads it
/// (403 → not-rider, 404 → needs-update, otherwise home); `ref.invalidate` it
/// to re-ask. Rebuilds when the signed-in user changes, and a 401 means the
/// session is no good, so it signs the app out (the router then shows login).
///
/// No automatic retry: Riverpod 3 would re-ask a failed provider on a backoff
/// timer, re-running a 401's sign-out and hiding the real answer (403, 404)
/// behind "loading". The gate screens have a Retry button instead.
final meProvider = FutureProvider<RiderMe>(retry: (_, _) => null, (ref) async {
  final uid = ref.watch(userIdProvider);
  if (uid == null) throw ApiException(401, 'unauthenticated');
  try {
    return await ref.watch(riderRepoProvider).me();
  } on ApiException catch (e) {
    if (e.unauthorized) await ref.read(authRepoProvider).signOut();
    rethrow;
  }
});
