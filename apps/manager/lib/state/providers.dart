import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';
import '../data/auth_repository.dart';
import '../data/manager_repository.dart';

final supabaseProvider = Provider<SupabaseClient>((_) => Supabase.instance.client);

final apiProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(supabaseProvider).auth));

final authStateProvider = StreamProvider<AuthState>(
  (ref) => ref.watch(supabaseProvider).auth.onAuthStateChange,
);

/// Whether a session exists. Its own provider so the router (and tests) can
/// depend on it without a live Supabase client.
final signedInProvider = Provider<bool>((ref) {
  ref.watch(authStateProvider);
  return ref.watch(supabaseProvider).auth.currentSession != null;
});

final authRepoProvider = Provider(
  (ref) => AuthRepository(ref.watch(supabaseProvider).auth, ref.watch(apiProvider)),
);

final managerRepoProvider = Provider((ref) => ManagerRepository(ref.watch(apiProvider)));
