import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/action_queue.dart';
import '../core/active_cache.dart';
import '../core/api.dart';
import '../data/auth_repository.dart';
import '../data/fixtures/fixture_backend.dart';
import '../data/jobs_repository.dart';
import '../data/rider_repository.dart';
import '../models/rider_me.dart';
import 'prefs.dart';

// ---------- Infrastructure ----------

final supabaseProvider = Provider<SupabaseClient>((_) => Supabase.instance.client);

final apiProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(supabaseProvider).auth));

final authRepoProvider = Provider(
  (ref) => AuthRepository(ref.watch(supabaseProvider), ref.watch(apiProvider)),
);
final riderRepoProvider = Provider((ref) => RiderRepository(ref.watch(apiProvider)));

/// The jobs routes, or in a debug build started with FIXTURES=true the in-memory
/// fixture backend. `fixturesEnabled` is a compile-time false in a release
/// build, so the fixture branch (and the fixture data) is not in the app.
final jobsRepoProvider = Provider<JobsRepository>((ref) {
  if (fixturesEnabled) return FixtureJobsRepository.create();
  return ApiJobsRepository(ref.watch(apiProvider));
});

/// The delivery the rider is carrying, kept for when the signal drops.
final activeCacheProvider = Provider((ref) {
  final cache = ActiveDeliveryCache(ref.watch(prefsProvider));
  ref.onDispose(cache.dispose);
  return cache;
});

/// Delivery steps waiting for the server (see core/action_queue.dart).
final actionQueueProvider = Provider((ref) {
  final queue = ActionQueue(
    ref.watch(jobsRepoProvider),
    ref.watch(prefsProvider),
    ref.watch(activeCacheProvider),
  );
  ref.onDispose(queue.dispose);
  return queue;
});

/// What is waiting in the action queue, for a "sending…" badge.
final pendingActionsProvider = StreamProvider<List<QueuedAction>>(
  (ref) => ref.watch(actionQueueProvider).pending,
);

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
