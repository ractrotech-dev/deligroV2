import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';

// ---------- Infrastructure ----------

final supabaseProvider = Provider<SupabaseClient>((_) => Supabase.instance.client);

final apiProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(supabaseProvider).auth));

// ---------- Session ----------

final authStateProvider = StreamProvider<AuthState>(
  (ref) => ref.watch(supabaseProvider).auth.onAuthStateChange,
);

/// The signed-in user's id, or null. Rebuilds dependants on sign-in/out.
final userIdProvider = Provider<String?>((ref) {
  ref.watch(authStateProvider);
  return ref.watch(supabaseProvider).auth.currentUser?.id;
});
