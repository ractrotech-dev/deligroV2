import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../models/restaurant.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';
import '../../widgets/restaurant_card.dart';

/// Saved restaurants (app/(customer)/profile/favorites).
class FavoritesScreen extends ConsumerWidget {
  const FavoritesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(favoritesProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Favourites')),
      body: RefreshIndicator(
        onRefresh: () => refreshAll(ref, [favoritesProvider]),
        child: AsyncBody<List<Restaurant>>(
          value: async,
          onRetry: () => ref.invalidate(favoritesProvider),
          builder: (list) => list.isEmpty
              ? LayoutBuilder(
                  builder: (context, box) => SingleChildScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    child: ConstrainedBox(
                      constraints: BoxConstraints(minHeight: box.maxHeight),
                      child: EmptyState(
                        icon: Icons.favorite_border_rounded,
                        title: 'No favourites yet',
                        body: 'Tap the heart on any restaurant to save it here.',
                        action: 'Explore restaurants',
                        onAction: () => context.go('/'),
                      ),
                    ),
                  ),
                )
              : ListView.separated(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
                  itemCount: list.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 20),
                  itemBuilder: (_, i) => RestaurantCard(restaurant: list[i]),
                ),
        ),
      ),
    );
  }
}
