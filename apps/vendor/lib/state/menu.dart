import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/menu_repository.dart';
import '../models/menu.dart';
import 'providers.dart';

final menuRepoProvider = Provider(
  (ref) => MenuRepository(ref.watch(apiProvider), ref.watch(supabaseProvider).storage),
);

/// The shop's menu; reloaded when the vendor switches shop.
class MenuNotifier extends AsyncNotifier<Menu> {
  @override
  Future<Menu> build() {
    ref.watch(activeShopSlugProvider);
    return ref.read(menuRepoProvider).load();
  }

  Future<void> refresh() async {
    try {
      state = AsyncData(await ref.read(menuRepoProvider).load());
    } catch (e, st) {
      if (state.value == null) state = AsyncError(e, st);
    }
  }
}

final menuProvider = AsyncNotifierProvider<MenuNotifier, Menu>(MenuNotifier.new);
