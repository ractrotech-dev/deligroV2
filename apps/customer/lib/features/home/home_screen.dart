import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../models/banner.dart';
import '../../models/order.dart';
import '../../models/restaurant.dart';
import '../../models/taxonomy.dart';
import '../../state/location.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/restaurant_card.dart';

/// Shop stars pulled toward the platform mean by how few people rated it
/// (bayesRating in src/lib/search/dishes.ts) — seeded shops carry 5.0 from
/// nobody, which must not outrank a 4.6 from two hundred.
double _bayes(Restaurant r) {
  final n = r.ratingCount < 0 ? 0 : r.ratingCount;
  return (20 * 4.0 + r.rating * n) / (20 + n);
}

/// Internal paths that are tab roots get `go`; everything else is a detail
/// page and gets `push`, so back returns to Home.
void _openRoute(BuildContext context, String route) {
  if (route.startsWith('https://')) {
    launchUrl(Uri.parse(route), mode: LaunchMode.externalApplication);
    return;
  }
  if (route.startsWith('/restaurant/') || route.startsWith('/orders/')) {
    context.push(route);
  } else {
    context.go(route);
  }
}

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final restaurants = ref.watch(restaurantsProvider);
    final settings = ref.watch(settingsProvider).value;
    final active = ref.watch(activeOrderProvider).value;
    final loc = ref.watch(locationProvider);

    Future<void> refresh() => refreshAll(ref, [
          restaurantsProvider,
          homeBannersProvider,
          activeOrderProvider,
          settingsProvider,
          categoryImagesProvider,
        ]);

    final list = restaurants.value;
    final slivers = <Widget>[
      const _HomeHeader(),
      const SliverPersistentHeader(pinned: true, delegate: _SearchBarDelegate()),
      if (settings != null && !settings.acceptingOrders)
        SliverToBoxAdapter(child: _MaintenanceBanner(message: settings.maintenanceMessage)),
      if (active != null && active.status.inFlight)
        SliverToBoxAdapter(child: _ActiveOrderStrip(order: active)),
      const SliverToBoxAdapter(child: SectionTitle('Categories')),
      const SliverToBoxAdapter(child: _CategoryStrip()),
      const SliverToBoxAdapter(child: _BannerSection()),
    ];

    if (list == null && restaurants.hasError) {
      slivers.add(SliverFillRemaining(
        hasScrollBody: false,
        child: ErrorRetry(
          error: restaurants.error!,
          onRetry: () => ref.invalidate(restaurantsProvider),
        ),
      ));
    } else if (list == null) {
      slivers.add(const SliverToBoxAdapter(child: _FeedSkeleton()));
    } else if (list.isEmpty) {
      slivers.add(const SliverFillRemaining(
        hasScrollBody: false,
        child: EmptyState(
          icon: Icons.storefront_outlined,
          title: 'No restaurants yet',
          body: 'We haven\'t onboarded a kitchen near you yet. Check back soon.',
        ),
      ));
    } else {
      final popular = [...list]..sort((a, b) => _bayes(b).compareTo(_bayes(a)));
      final nearby = [...list]
        ..sort((a, b) {
          if (a.open != b.open) return a.open ? -1 : 1;
          final eta = a.etaMin.compareTo(b.etaMin);
          if (eta != 0) return eta;
          final da = distanceToShop(loc, a);
          final db = distanceToShop(loc, b);
          if (da == null && db == null) return 0;
          if (da == null) return 1;
          if (db == null) return -1;
          return da.compareTo(db);
        });
      slivers.addAll([
        SliverToBoxAdapter(
          child: SectionTitle('Popular right now', trailing: _SeeAll(onTap: () => context.go('/search'))),
        ),
        SliverToBoxAdapter(child: _PopularRail(restaurants: popular.take(6).toList())),
        SliverToBoxAdapter(
          child: SectionTitle('Restaurants near you', trailing: _SeeAll(onTap: () => context.go('/search'))),
        ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          sliver: SliverList.separated(
            itemCount: nearby.length,
            separatorBuilder: (_, _) => const SizedBox(height: 20),
            itemBuilder: (_, i) => RestaurantCard(restaurant: nearby[i]),
          ),
        ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 28, 16, 24),
            child: Text(
              'Freshly made, delivered warm.',
              textAlign: TextAlign.center,
              style: TextStyle(color: context.colors.muted, fontSize: 12),
            ),
          ),
        ),
      ]);
    }

    // SafeArea so the pinned search field never slides under the status bar
    // once the location row has floated away.
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: refresh,
          edgeOffset: 64,
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: slivers,
          ),
        ),
      ),
    );
  }
}

// ---------- Header ----------

/// Location chip and profile button. Floats away on scroll and snaps back,
/// leaving the pinned search field — the web header's collapse.
class _HomeHeader extends ConsumerWidget {
  const _HomeHeader();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final loc = ref.watch(locationProvider);
    return SliverAppBar(
      floating: true,
      snap: true,
      toolbarHeight: 64,
      titleSpacing: 16,
      automaticallyImplyLeading: false,
      title: Semantics(
        button: true,
        label: 'Change delivery location, currently ${loc.label}',
        excludeSemantics: true,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => context.push('/location'),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: Row(
              children: [
                Container(
                  width: 30,
                  height: 30,
                  decoration: BoxDecoration(
                    color: c.blue.withValues(alpha: .12),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    loc.isFallback ? Icons.location_on_outlined : Icons.near_me_rounded,
                    size: 17,
                    color: c.blue,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        'DELIVER TO',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.9,
                          color: c.muted,
                        ),
                      ),
                      Row(
                        children: [
                          ConstrainedBox(
                            constraints: BoxConstraints(
                              maxWidth: MediaQuery.sizeOf(context).width * .4,
                            ),
                            child: Text(
                              loc.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 15.5,
                                fontWeight: FontWeight.w800,
                                letterSpacing: -0.2,
                                color: c.ink,
                              ),
                            ),
                          ),
                          if (loc.sublabel != null && loc.sublabel!.isNotEmpty)
                            Flexible(
                              child: Text(
                                ' · ${loc.sublabel}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                  color: c.muted,
                                ),
                              ),
                            ),
                          Icon(Icons.keyboard_arrow_down_rounded, size: 20, color: c.muted),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        Padding(
          padding: const EdgeInsets.only(right: 12),
          child: IconButton(
            tooltip: 'Profile',
            onPressed: () => context.go('/profile'),
            style: IconButton.styleFrom(
              backgroundColor: c.accentSoft,
              foregroundColor: c.accentInk,
              minimumSize: const Size(44, 44),
            ),
            icon: const Icon(Icons.person_rounded, size: 21),
          ),
        ),
      ],
    );
  }
}

/// The search field is a tap target into the Search tab — results live there.
class _SearchBarDelegate extends SliverPersistentHeaderDelegate {
  const _SearchBarDelegate();

  static const _height = 66.0;

  @override
  double get minExtent => _height;
  @override
  double get maxExtent => _height;

  @override
  bool shouldRebuild(covariant _SearchBarDelegate oldDelegate) => false;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    final c = context.colors;
    // A pinned header must paint its full extent, or the sliver geometry is
    // invalid ("layoutExtent exceeds paintExtent").
    return Container(
      height: _height,
      color: c.bg,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
      child: Semantics(
        button: true,
        label: 'Search for a dish, cuisine or restaurant',
        excludeSemantics: true,
        child: Material(
          color: c.surface,
          borderRadius: BorderRadius.circular(radiusBlock),
          child: InkWell(
            borderRadius: BorderRadius.circular(radiusBlock),
            onTap: () => context.go('/search'),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(radiusBlock),
                border: Border.all(color: c.line),
              ),
              child: Row(
                children: [
                  Icon(Icons.search_rounded, color: c.ink, size: 22),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Search for a dish, cuisine or restaurant',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: c.muted, fontSize: 15),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SeeAll extends StatelessWidget {
  const _SeeAll({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => TextButton(
        onPressed: onTap,
        style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [Text('See all'), Icon(Icons.chevron_right_rounded, size: 18)],
        ),
      );
}

// ---------- Strips ----------

class _MaintenanceBanner extends StatelessWidget {
  const _MaintenanceBanner({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: c.dealSoft,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.deal.withValues(alpha: .3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.warning_amber_rounded, size: 20, color: c.deal),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message.trim().isNotEmpty
                  ? message.trim()
                  : 'We\'re not taking orders right now. Please check back soon.',
              style: TextStyle(color: c.deal, fontWeight: FontWeight.w600, fontSize: 14),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActiveOrderStrip extends StatelessWidget {
  const _ActiveOrderStrip({required this.order});
  final Order order;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
      child: Semantics(
        button: true,
        label: 'Ongoing order from ${order.restaurantName}, ${order.status.label}',
        excludeSemantics: true,
        child: Material(
          color: c.surface,
          borderRadius: BorderRadius.circular(16),
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: () => context.push('/orders/${order.id}'),
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: c.line),
              ),
              child: Row(
                children: [
                  SizedBox(
                    width: 48,
                    height: 48,
                    child: NetImage(
                      url: order.restaurantImage,
                      tint: order.restaurantAccent ?? 'linear-gradient(135deg,#34e39a,#17b26a)',
                      radius: 12,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const _PulseDot(),
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                'Ongoing order · ${order.status.label}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: c.green,
                                  fontWeight: FontWeight.w700,
                                  fontSize: 13,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          order.restaurantName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15),
                        ),
                      ],
                    ),
                  ),
                  Icon(Icons.chevron_right_rounded, color: c.muted),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PulseDot extends StatefulWidget {
  const _PulseDot();

  @override
  State<_PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<_PulseDot> with SingleTickerProviderStateMixin {
  late final _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: Tween(begin: .35, end: 1.0).animate(_ctrl),
        child: Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: context.colors.green, shape: BoxShape.circle),
        ),
      );
}

class _CategoryStrip extends ConsumerWidget {
  const _CategoryStrip();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final overrides = ref.watch(categoryImagesProvider).value ?? const {};
    final c = context.colors;
    // Photo + gap + two label lines, so large system text doesn't clip.
    final labelLine = MediaQuery.textScalerOf(context).scale(12) * 1.2;
    return SizedBox(
      height: 70 + 6 + labelLine * 2 + 8,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: homeCategories.length,
        separatorBuilder: (_, _) => const SizedBox(width: 12),
        itemBuilder: (context, i) {
          final cat = homeCategories[i];
          return Semantics(
            button: true,
            label: cat.label,
            excludeSemantics: true,
            child: InkWell(
              borderRadius: BorderRadius.circular(radiusBlock),
              onTap: () => context.go('/search?category=${Uri.encodeComponent(cat.id)}'),
              child: SizedBox(
                width: 74,
                child: Column(
                  children: [
                    SizedBox(
                      width: 70,
                      height: 70,
                      child: NetImage(
                        url: overrides[cat.id] ?? cat.image,
                        tint: cat.tint,
                        radius: 35,
                        fallback: Text(cat.emoji, style: const TextStyle(fontSize: 30)),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      cat.label,
                      maxLines: 2,
                      textAlign: TextAlign.center,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.2,
                        fontWeight: FontWeight.w600,
                        color: c.ink,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _PopularRail extends StatelessWidget {
  const _PopularRail({required this.restaurants});
  final List<Restaurant> restaurants;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 236,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          itemCount: restaurants.length,
          separatorBuilder: (_, _) => const SizedBox(width: 14),
          itemBuilder: (_, i) => SizedBox(
            width: 210,
            child: Align(
              alignment: Alignment.topCenter,
              child: RestaurantCard(restaurant: restaurants[i], compact: true),
            ),
          ),
        ),
      );
}

// ---------- Banner carousel ----------

class _BannerSection extends ConsumerWidget {
  const _BannerSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final banners = ref.watch(homeBannersProvider).value ?? const <PromoBanner>[];
    if (banners.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: _BannerCarousel(banners: banners),
    );
  }
}

class _BannerCarousel extends StatefulWidget {
  const _BannerCarousel({required this.banners});
  final List<PromoBanner> banners;

  @override
  State<_BannerCarousel> createState() => _BannerCarouselState();
}

class _BannerCarouselState extends State<_BannerCarousel> {
  final _pages = PageController();
  Timer? _timer;
  int _index = 0;
  bool _held = false;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void didUpdateWidget(covariant _BannerCarousel old) {
    super.didUpdateWidget(old);
    if (old.banners.length != widget.banners.length) {
      _index = 0;
      if (_pages.hasClients) _pages.jumpToPage(0);
      _start();
    }
  }

  void _start() {
    _timer?.cancel();
    if (widget.banners.length <= 1) return;
    _timer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (_held || !_pages.hasClients || !mounted) return;
      final next = (_index + 1) % widget.banners.length;
      _pages.animateToPage(
        next,
        duration: const Duration(milliseconds: 420),
        curve: Curves.easeOutCubic,
      );
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final banners = widget.banners;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: SizedBox(
        height: 160,
        child: Listener(
          // Hold auto-advance while a finger is on the carousel.
          onPointerDown: (_) => _held = true,
          onPointerUp: (_) => _held = false,
          onPointerCancel: (_) => _held = false,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: Stack(
              children: [
                PageView.builder(
                  controller: _pages,
                  itemCount: banners.length,
                  onPageChanged: (i) => setState(() => _index = i),
                  itemBuilder: (context, i) => _BannerSlide(banner: banners[i]),
                ),
                if (banners.length > 1)
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 10,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        for (var i = 0; i < banners.length; i++)
                          AnimatedContainer(
                            duration: const Duration(milliseconds: 250),
                            margin: const EdgeInsets.symmetric(horizontal: 3),
                            width: i == _index ? 20 : 6,
                            height: 6,
                            decoration: BoxDecoration(
                              color: Colors.white.withValues(alpha: i == _index ? 1 : .6),
                              borderRadius: BorderRadius.circular(3),
                            ),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _BannerSlide extends StatelessWidget {
  const _BannerSlide({required this.banner});
  final PromoBanner banner;

  @override
  Widget build(BuildContext context) {
    final route = banner.route;
    final width = MediaQuery.sizeOf(context).width;
    return Semantics(
      button: route != null,
      label: banner.headline,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: route == null ? null : () => _openRoute(context, route),
        child: Stack(
          fit: StackFit.expand,
          children: [
            NetImage(url: banner.image, tint: banner.tint, radius: 0),
            // Scrim so the copy stays legible over any photo.
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [Color(0xD106080A), Color(0x8006080A), Color(0x1406080A)],
                  stops: [0, .45, 1],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 22),
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: width * .62),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      banner.headline,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 18,
                        height: 1.15,
                        fontWeight: FontWeight.w800,
                        letterSpacing: -0.3,
                      ),
                    ),
                    if (banner.description != null && banner.description!.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        banner.description!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: Colors.white.withValues(alpha: .82),
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                    if (route != null && banner.ctaLabel != null && banner.ctaLabel!.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(99),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              banner.ctaLabel!,
                              style: const TextStyle(
                                color: Color(0xFF0E1417),
                                fontWeight: FontWeight.w700,
                                fontSize: 13,
                              ),
                            ),
                            const SizedBox(width: 4),
                            const Icon(Icons.arrow_forward_rounded, size: 14, color: Color(0xFF0E1417)),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- Loading ----------

class _FeedSkeleton extends StatelessWidget {
  const _FeedSkeleton();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget box(double w, double h, [double r = radiusBlock]) => Container(
          width: w,
          height: h,
          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(r)),
        );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 22, 16, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          box(170, 20, 6),
          const SizedBox(height: 12),
          SizedBox(
            height: 200,
            child: ListView(
              scrollDirection: Axis.horizontal,
              physics: const NeverScrollableScrollPhysics(),
              children: [
                for (var i = 0; i < 3; i++)
                  Padding(
                    padding: const EdgeInsets.only(right: 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        box(210, 150),
                        const SizedBox(height: 10),
                        box(140, 14, 6),
                        const SizedBox(height: 6),
                        box(100, 12, 6),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          box(200, 20, 6),
          for (var i = 0; i < 3; i++) ...[
            const SizedBox(height: 16),
            AspectRatio(aspectRatio: 2.1, child: box(double.infinity, double.infinity)),
            const SizedBox(height: 10),
            box(180, 14, 6),
            const SizedBox(height: 6),
            box(120, 12, 6),
          ],
        ],
      ),
    );
  }
}
