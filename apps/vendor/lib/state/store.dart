import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/store_repository.dart';
import '../models/store.dart';
import 'providers.dart';

final storeRepoProvider = Provider((ref) => StoreRepository(ref.watch(apiProvider)));

/// The Store screen's state; reloaded when the vendor switches shop.
class StoreNotifier extends AsyncNotifier<StoreState> {
  @override
  Future<StoreState> build() {
    ref.watch(activeShopSlugProvider);
    return ref.read(storeRepoProvider).load();
  }

  Future<void> refresh() async {
    try {
      state = AsyncData(await ref.read(storeRepoProvider).load());
    } catch (e, st) {
      if (state.value == null) state = AsyncError(e, st);
    }
  }

  /// Applies a write's returned storefront without a second round trip.
  void adopt(StoreInfo store) {
    final s = state.value;
    if (s != null) state = AsyncData(s.withStore(store));
  }
}

final storeProvider = AsyncNotifierProvider.autoDispose<StoreNotifier, StoreState>(StoreNotifier.new);
