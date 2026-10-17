import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/format.dart';
import '../core/geo.dart';
import '../models/restaurant.dart';
import '../state/location.dart';
import '../theme/app_theme.dart';
import 'common.dart';

/// Distance from the customer's delivery location, or null when the shop
/// isn't pinned — never a made-up number (see `distanceKm` on the web type).
double? distanceToShop(DeliveryLocation from, Restaurant r) {
  if (r.lat == null || r.lng == null) return null;
  return haversineKm(from.lat, from.lng, r.lat!, r.lng!);
}

class RestaurantCard extends ConsumerWidget {
  const RestaurantCard({super.key, required this.restaurant, this.compact = false});
  final Restaurant restaurant;

  /// Horizontal-rail size.
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = restaurant;
    final c = context.colors;
    final km = distanceToShop(ref.watch(locationProvider), r);
    final meta = [
      etaBand(r.etaMin, r.etaMax),
      if (km != null) distance(km),
      if (r.cuisines.isNotEmpty) r.cuisines.take(2).join(', '),
    ].join(' · ');

    final image = AspectRatio(
      aspectRatio: compact ? 1.35 : 2.1,
      child: Stack(
        fit: StackFit.expand,
        children: [
          NetImage(
            url: r.image,
            tint: r.accentTint,
            fallback: Icon(Icons.restaurant_rounded, size: 36, color: Colors.white.withValues(alpha: .8)),
          ),
          if (!r.open)
            ClipRRect(
              borderRadius: BorderRadius.circular(radiusBlock),
              child: Container(
                color: Colors.black.withValues(alpha: .55),
                alignment: Alignment.center,
                child: const Text('Closed now',
                    style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 15)),
              ),
            ),
          if (r.offer != null && r.open)
            Positioned(
              left: 8,
              bottom: 8,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(color: c.deal, borderRadius: BorderRadius.circular(8)),
                child: Text(r.offer!,
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 12)),
              ),
            ),
          if (r.pace.busy && r.open)
            Positioned(
              right: 8,
              top: 8,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(color: c.pop, borderRadius: BorderRadius.circular(8)),
                child: Text('Busy', style: TextStyle(color: c.popInk, fontWeight: FontWeight.w800, fontSize: 11)),
              ),
            ),
        ],
      ),
    );

    return Semantics(
      button: true,
      label: '${r.name}${r.open ? '' : ', closed'}',
      child: InkWell(
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: () => context.push('/restaurant/${r.slug}'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            image,
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Text(r.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                ),
                const SizedBox(width: 6),
                RatingPill(rating: r.rating, count: r.ratingCount),
              ],
            ),
            const SizedBox(height: 2),
            Text(meta,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: c.muted, fontSize: 13)),
          ],
        ),
      ),
    );
  }
}
