import 'dart:async';

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
  final cache = ActiveDeliveryCache(
    ref.watch(prefsProvider),
    ownerUid: () {
      try {
        return ref.read(userIdProvider);
      } catch (_) {
        return null; // no session to ask: no check
      }
    },
  );
  ref.onDispose(cache.dispose);
  return cache;
});

/// Delivery steps waiting for the server (see core/action_queue.dart). Each
/// belongs to the user who tapped it and is sent only in their session.
final actionQueueProvider = Provider((ref) {
  // Who is signed in; with no auth client at all (a widget test) the queue
  // does not tell users apart.
  String? Function()? signedIn;
  try {
    ref.read(userIdProvider);
    signedIn = () => ref.read(userIdProvider);
  } catch (_) {
    signedIn = null;
  }
  final queue = ActionQueue(
    ref.watch(jobsRepoProvider),
    ref.watch(prefsProvider),
    ref.watch(activeCacheProvider),
    uid: signedIn,
  );
  ref.onDispose(queue.dispose);
  if (signedIn != null) {
    ref.listen<String?>(userIdProvider, (prev, next) {
      if (prev != next) unawaited(queue.userChanged());
    });
  }
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


/// The key a rider's own data is kept under: the signed-in user's id, '' when
/// nobody is signed in (or, in a widget test, when there is no auth client).
///
/// Every provider of one rider's data is a family on this key. Riverpod 3
/// keeps a provider's last value through a rebuild (while loading, and after
/// an error), so a provider that only watched the user id would show the
/// last rider's cash, inbox or earnings to the next one. A different key is a
/// different provider, with no value until its own answer arrives.
final riderKeyProvider = Provider<String>((ref) {
  try {
    return ref.watch(userIdProvider) ?? '';
  } catch (_) {
    return ''; // no auth client to ask (a widget test)
  }
});

/// The signed-in user's `/api/rider/me`, and only theirs: while a new user's
/// answer loads (or after it failed) [meProvider] still holds the previous
/// user's value, which this never passes on. Screens read this, not
/// `meProvider`'s value.
final currentMeProvider = Provider<RiderMe?>((ref) {
  final me = ref.watch(meProvider).value;
  if (me == null) return null;
  final String? uid;
  try {
    uid = ref.watch(userIdProvider);
  } catch (_) {
    return me; // no auth client to compare with (a widget test)
  }
  return me.id == uid ? me : null;
});

/// [currentMeProvider]'s answer, worked out now from [meProvider]: for code
/// that runs inside a listener of [meProvider], where a provider that depends
/// on it has not caught up yet.
RiderMe? readCurrentMe(Ref ref) {
  final me = ref.read(meProvider).value;
  if (me == null) return null;
  final String? uid;
  try {
    uid = ref.read(userIdProvider);
  } catch (_) {
    return me; // no auth client to compare with (a widget test)
  }
  return me.id == uid ? me : null;
}

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
