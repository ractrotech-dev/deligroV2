import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';
import '../data/account_repository.dart';
import '../data/catalog_repository.dart';
import '../data/checkout_repository.dart';
import '../data/order_repository.dart';
import '../models/address.dart';
import '../models/banner.dart';
import '../models/order.dart';
import '../models/restaurant.dart';
import '../models/settings.dart';
import 'campaigns.dart';

// ---------- Infrastructure ----------

final supabaseProvider = Provider<SupabaseClient>((_) => Supabase.instance.client);

final apiProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(supabaseProvider).auth));

final catalogRepoProvider =
    Provider((ref) => CatalogRepository(ref.watch(supabaseProvider)));
final orderRepoProvider = Provider(
  (ref) => OrderRepository(ref.watch(supabaseProvider), ref.watch(apiProvider)),
);
final checkoutRepoProvider = Provider((ref) => CheckoutRepository(ref.watch(apiProvider)));
final accountRepoProvider = Provider(
  (ref) => AccountRepository(ref.watch(supabaseProvider), ref.watch(apiProvider)),
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

final profileProvider = FutureProvider<Profile?>((ref) async {
  final uid = ref.watch(userIdProvider);
  if (uid == null) return null;
  return ref.watch(accountRepoProvider).profile();
});

// ---------- Catalog ----------

final settingsProvider = FutureProvider<PlatformSettings>(
  (ref) => ref.watch(catalogRepoProvider).settings(),
);

/// Listing surfaces (Home, Stores): no menus.
final restaurantsProvider = FutureProvider<List<Restaurant>>((ref) async {
  final placements = await ref.watch(livePlacementsProvider.future);
  return ref.watch(catalogRepoProvider).listRestaurants(placements: placements);
});

/// Search needs every dish, so it loads the full catalog once.
final searchCatalogProvider = FutureProvider<List<Restaurant>>((ref) async {
  final placements = await ref.watch(livePlacementsProvider.future);
  return ref.watch(catalogRepoProvider).listRestaurants(withMenu: true, placements: placements);
});

/// Dishes with photos for a restaurant card's swipe, by restaurant id. A failed
/// or empty answer is simply "nothing to swipe": the card stays a plain card.
final dishPreviewProvider = FutureProvider.family<List<MenuItem>, String>((ref, restaurantId) async {
  try {
    return await ref.watch(catalogRepoProvider).dishPreview(restaurantId);
  } catch (_) {
    return const [];
  }
});

final restaurantProvider = FutureProvider.family<Restaurant?, String>(
  (ref, slug) => ref.watch(catalogRepoProvider).restaurant(slug),
);

final homeBannersProvider = FutureProvider<List<PromoBanner>>((ref) async {
  final repo = ref.watch(catalogRepoProvider);
  final settings = await ref.watch(settingsProvider.future);
  final all = await repo.banners('home_hero');
  // Same gate as isBannerTargetEnabled: don't advertise switched-off services.
  return all.where((b) {
    if (b.targetType == 'grocery') return settings.featureGrocery;
    if (b.targetType == 'pick_drop') return settings.featurePickDrop;
    if (b.targetType == 'pharmacy') return settings.featurePharmacy;
    return true;
  }).toList();
});

final categoryImagesProvider = FutureProvider<Map<String, String>>(
  (ref) => ref.watch(catalogRepoProvider).categoryImages(),
);

// ---------- Customer data ----------

final activeOrderProvider = FutureProvider<Order?>((ref) async {
  if (ref.watch(userIdProvider) == null) return null;
  return ref.watch(orderRepoProvider).activeOrder();
});

final myOrdersProvider = FutureProvider<List<Order>>((ref) async {
  if (ref.watch(userIdProvider) == null) return const [];
  return ref.watch(orderRepoProvider).myOrders();
});

final orderProvider = FutureProvider.family<Order?, String>(
  (ref, id) => ref.watch(orderRepoProvider).byId(id),
);

final favoritesProvider = FutureProvider<List<Restaurant>>((ref) async {
  if (ref.watch(userIdProvider) == null) return const [];
  return ref.watch(accountRepoProvider).favorites();
});

final isFavoriteProvider = FutureProvider.family<bool, String>((ref, restaurantId) async {
  if (ref.watch(userIdProvider) == null) return false;
  return ref.watch(accountRepoProvider).isFavorite(restaurantId);
});

/// Saved addresses with the write operations the screens need. Every write
/// re-reads the list, since the server enforces the single-default rule.
class AddressesNotifier extends AsyncNotifier<List<SavedAddress>> {
  AccountRepository get _repo => ref.read(accountRepoProvider);

  @override
  Future<List<SavedAddress>> build() async {
    if (ref.watch(userIdProvider) == null) return const [];
    return _repo.addresses();
  }

  Future<SavedAddress> add({
    required String label,
    required String line,
    double? lat,
    double? lng,
    bool isDefault = false,
  }) async {
    final a = await _repo.addAddress(
      label: label,
      line: line,
      lat: lat,
      lng: lng,
      isDefault: isDefault,
    );
    ref.invalidateSelf();
    return a;
  }

  Future<void> setDefault(String id) async {
    await _repo.updateAddress(id, {'isDefault': true});
    ref.invalidateSelf();
  }

  Future<void> updatePin(String id, double lat, double lng) async {
    await _repo.updateAddress(id, {'lat': lat, 'lng': lng});
    ref.invalidateSelf();
  }

  Future<void> remove(String id) async {
    await _repo.deleteAddress(id);
    ref.invalidateSelf();
  }
}

final addressesProvider =
    AsyncNotifierProvider<AddressesNotifier, List<SavedAddress>>(AddressesNotifier.new);
