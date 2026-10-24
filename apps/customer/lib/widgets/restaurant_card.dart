import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/format.dart';
import '../core/geo.dart';
import '../models/restaurant.dart';
import '../state/location.dart';
import '../state/providers.dart';
import '../theme/app_theme.dart';
import 'common.dart';
import '../state/campaigns.dart';

/// Distance from the customer's delivery location, or null when the shop
/// isn't pinned — never a made-up number (see `distanceKm` on the web type).
double? distanceToShop(DeliveryLocation from, Restaurant r) {
  if (r.lat == null || r.lng == null) return null;
  return haversineKm(from.lat, from.lng, r.lat!, r.lng!);
}

class RestaurantCard extends ConsumerWidget {
  const RestaurantCard({super.key, required this.restaurant, this.compact = false});
  final Restaurant restaurant;

  /// Horizontal-rail size. These cards don't swipe: a sideways swipe on them
  /// belongs to the rail they sit in.
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = restaurant;
    final c = context.colors;
    final featuredId = ref.watch(livePlacementsProvider).value?.featuredFor(r.id);
    final km = distanceToShop(ref.watch(locationProvider), r);
    final meta = [
      etaBand(r.etaMin, r.etaMax),
      if (km != null) distance(km),
      if (r.cuisines.isNotEmpty) r.cuisines.take(2).join(', '),
    ].join(' · ');

    final card = Semantics(
      button: true,
      label: '${r.name}${featuredId != null ? ', featured' : ''}${r.open ? '' : ', closed'}',
      child: InkWell(
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: () {
          if (featuredId != null) ref.read(campaignTrackerProvider).click(featuredId);
          context.push('/restaurant/${r.slug}');
        },
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            AspectRatio(
              aspectRatio: compact ? 1.35 : 2.1,
              child: _CardMedia(restaurant: r, featured: featuredId != null, swipeable: !compact && r.open),
            ),
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
    return CampaignImpression(campaignId: featuredId, child: card);
  }
}

/// The card's picture. The first page is the restaurant; when the kitchen has
/// dishes with photos, swiping sideways shows them one by one, with their name
/// and price, the way Zomato and Swiggy do. Tapping anywhere still opens the
/// restaurant. Overlays (closed, offer, featured, busy) stay put; the offer
/// badge steps aside on dish pages so it doesn't sit on the dish's caption.
class _CardMedia extends ConsumerStatefulWidget {
  const _CardMedia({required this.restaurant, required this.featured, required this.swipeable});
  final Restaurant restaurant;
  final bool featured;
  final bool swipeable;

  @override
  ConsumerState<_CardMedia> createState() => _CardMediaState();
}

class _CardMediaState extends ConsumerState<_CardMedia> {
  final _pages = PageController();
  int _page = 0;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.restaurant;
    final c = context.colors;
    final dishes = widget.swipeable ? (ref.watch(dishPreviewProvider(r.id)).value ?? const <MenuItem>[]) : const <MenuItem>[];
    final onHero = _page == 0;

    final hero = NetImage(
      url: r.image,
      tint: r.accentTint,
      fallback: Icon(Icons.restaurant_rounded, size: 36, color: Colors.white.withValues(alpha: .8)),
    );

    return Stack(
      fit: StackFit.expand,
      children: [
        if (dishes.isEmpty)
          hero
        else
          PageView.builder(
            controller: _pages,
            itemCount: dishes.length + 1,
            onPageChanged: (i) => setState(() => _page = i),
            itemBuilder: (_, i) => i == 0 ? hero : _DishPage(item: dishes[i - 1], tint: r.accentTint),
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
        if (r.offer != null && r.open && onHero)
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
        // A paid placement says so (0160): honest labelling, always.
        if (widget.featured)
          Positioned(
            left: 8,
            top: 8,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: c.pop, borderRadius: BorderRadius.circular(8)),
              child: Text('Featured', style: TextStyle(color: c.popInk, fontWeight: FontWeight.w800, fontSize: 11)),
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
        if (dishes.isNotEmpty)
          Positioned(
            right: 10,
            bottom: 10,
            child: _Dots(count: dishes.length + 1, index: _page),
          ),
      ],
    );
  }
}

/// One dish: its photo with the name, veg mark and price over a dark fade.
class _DishPage extends StatelessWidget {
  const _DishPage({required this.item, required this.tint});
  final MenuItem item;
  final String? tint;

  @override
  Widget build(BuildContext context) {
    final price = item.variants.isNotEmpty ? item.fromPrice : item.effective;
    return Semantics(
      label: '${item.name}, ${rupees(price)}',
      child: Stack(
        fit: StackFit.expand,
        children: [
          NetImage(url: item.image, tint: tint, fallback: const SizedBox.shrink()),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0x00000000), Color(0x99000000)],
                stops: [.45, 1],
              ),
            ),
          ),
          Positioned(
            left: 10,
            right: 56,
            bottom: 8,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                VegMark(item.veg, size: 14),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(item.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 14)),
                ),
                const SizedBox(width: 8),
                Text(item.variants.isNotEmpty ? 'from ${rupees(price)}' : rupees(price),
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Dots extends StatelessWidget {
  const _Dots({required this.count, required this.index});
  final int count;
  final int index;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        decoration: BoxDecoration(color: Colors.black.withValues(alpha: .35), borderRadius: BorderRadius.circular(10)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < count; i++)
              AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                margin: const EdgeInsets.symmetric(horizontal: 2),
                width: i == index ? 12 : 5,
                height: 5,
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: i == index ? 1 : .6),
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
