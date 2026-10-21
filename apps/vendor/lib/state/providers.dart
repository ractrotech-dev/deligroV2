import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';
import 'prefs.dart';

final supabaseProvider = Provider<SupabaseClient>((_) => Supabase.instance.client);

/// The shop a multi-shop owner last picked (null until they pick one). Sent to
/// the server as the `vendor_restaurant_slug` cookie; the server's answer
/// (`/api/vendor/me` → `activeSlug`) always wins.
class ActiveShopSlugNotifier extends Notifier<String?> {
  static const key = 'partner-shop';

  @override
  String? build() => ref.read(prefsProvider).getString(key);

  void set(String? slug) {
    state = slug;
    final prefs = ref.read(prefsProvider);
    slug == null ? prefs.remove(key) : prefs.setString(key, slug);
  }
}

final activeShopSlugProvider =
    NotifierProvider<ActiveShopSlugNotifier, String?>(ActiveShopSlugNotifier.new);

final apiProvider = Provider<ApiClient>(
  (ref) => ApiClient(
    ref.watch(supabaseProvider).auth,
    shopSlug: () => ref.read(activeShopSlugProvider),
  ),
);

final authStateProvider = StreamProvider<AuthState>(
  (ref) => ref.watch(supabaseProvider).auth.onAuthStateChange,
);

/// The signed-in user's id; null when signed out.
final userIdProvider = Provider<String?>((ref) {
  ref.watch(authStateProvider);
  return ref.watch(supabaseProvider).auth.currentUser?.id;
});
