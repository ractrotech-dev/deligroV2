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
      _readAt = DateTime.now();
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

  /// When switches were last read, for [refresh]'s "not too often".
  DateTime? _readAt;
  bool _refreshing = false;

  /// Asks the server again while the vendor keeps working: Deligro can switch a
  /// section off at any moment, and a tab must not stay up until the next launch.
  /// Unlike [reload] it never passes through "loading", so the router does not
  /// send them to the boot screen. A lost connection or a server fault changes
  /// nothing: what they had stands until the next time.
  ///
  /// [force]: the app came back to the front, or a route said a switch is off.
  /// Otherwise at most once every [refreshEvery].
  Future<void> refresh({bool force = false, DateTime Function() clock = DateTime.now}) async {
    if (_refreshing || !ref.read(signedInProvider)) return;
    if (state.isLoading || state.value == null) return;
    final now = clock();
    final last = _readAt;
    if (!force && last != null && now.difference(last) < refreshEvery) return;
    _refreshing = true;
    _readAt = now;
    final slug = ref.read(activeShopSlugProvider);
    try {
      final me = await ref.read(vendorRepoProvider).me();
      // Signed out or moved to another shop meanwhile: not this answer's business.
      if (!ref.mounted || !ref.read(signedInProvider) || ref.read(activeShopSlugProvider) != slug) return;
      state = AsyncData(me);
    } on ApiException catch (e) {
      if (!ref.mounted) return;
      if (e.unauthorized) {
        await ref.read(authRepoProvider).signOut();
      } else if (isNoShopError(e)) {
        state = AsyncError(e, StackTrace.current);
      }
    } catch (_) {
      // Nothing to say: it is asked again on the next resume.
    } finally {
      _refreshing = false;
    }
  }
}

/// The least time between two [VendorMeNotifier.refresh] reads on a tab change.
const refreshEvery = Duration(minutes: 1);

final vendorMeProvider = AsyncNotifierProvider<VendorMeNotifier, VendorMe?>(VendorMeNotifier.new);

/// True when the error means "this account runs no shop here", not a fault.
bool isNoShopError(Object? error) => error is ApiException && (error.status == 403 || error.status == 404);
