import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api.dart';
import '../models/vendor_me.dart';
import 'providers.dart';

/// The signed-in vendor, or null when signed out.
///
/// Errors are kept, not swallowed: the router sends 403 / 404 to the
/// "no shop here" screen and anything else to the boot screen's Retry. A 401
/// means the session is gone, so it signs out — the router then shows login.
class VendorMeNotifier extends AsyncNotifier<VendorMe?> {
  @override
  Future<VendorMe?> build() async {
    if (!ref.watch(signedInProvider)) return null;
    // Re-read when the vendor switches shop.
    ref.watch(activeShopSlugProvider);
    try {
      final me = await ref.read(vendorRepoProvider).me();
      // The server's choice of shop wins over a stale or foreign saved slug.
      final saved = ref.read(activeShopSlugProvider);
      if (me.shops.length > 1 && saved != me.activeSlug) {
        Future.microtask(() => ref.read(activeShopSlugProvider.notifier).set(me.activeSlug));
      }
      return me;
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

final vendorMeProvider = AsyncNotifierProvider<VendorMeNotifier, VendorMe?>(VendorMeNotifier.new);

/// True when the error means "this account runs no shop here", not a fault.
bool isNoShopError(Object? error) =>
    error is ApiException && (error.status == 403 || error.status == 404);
