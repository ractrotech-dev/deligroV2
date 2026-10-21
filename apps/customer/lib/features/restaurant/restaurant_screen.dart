import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/restaurant.dart';
import '../../state/cart.dart';
import '../../state/location.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/cart_widgets.dart';
import '../../widgets/common.dart';
import '../../widgets/restaurant_card.dart';
import 'item_sheet.dart';

const _heroHeight = 230.0;
const _tabsHeight = 56.0;
const _searchHeight = 64.0;

class RestaurantScreen extends ConsumerWidget {
  const RestaurantScreen({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(restaurantProvider(slug));
    final r = value.value;
    if (r == null && value.hasError) {
      return Scaffold(
        appBar: AppBar(),
        body: ErrorRetry(error: value.error!, onRetry: () => ref.invalidate(restaurantProvider(slug))),
      );
    }
    if (r == null && value.isLoading) {
      return Scaffold(appBar: AppBar(), body: const _MenuSkeleton());
    }
    if (r == null) {
      return Scaffold(
        appBar: AppBar(),
        body: EmptyState(
          icon: Icons.storefront_outlined,
          title: 'We couldn\'t find that restaurant',
          body: 'It may have moved or stopped listing on Deligro.',
          action: 'Back to home',
          onAction: () => context.go('/'),
        ),
      );
    }
    return Scaffold(
      body: _RestaurantBody(restaurant: r),
      bottomNavigationBar: const CartBar(),
    );
  }
}

class _RestaurantBody extends ConsumerStatefulWidget {
  const _RestaurantBody({required this.restaurant});
  final Restaurant restaurant;

  @override
  ConsumerState<_RestaurantBody> createState() => _RestaurantBodyState();
}

class _RestaurantBodyState extends ConsumerState<_RestaurantBody> {
  final _scroll = ScrollController();
  final _menuSearch = TextEditingController();
  final _searchFocus = FocusNode();
  final Map<String, GlobalKey> _sectionKeys = {};
  final Map<String, GlobalKey> _tabKeys = {};
  bool _searching = false;
  String _active = '';
  bool _jumping = false;

  Restaurant get r => widget.restaurant;

  /// Restaurant.categories skips the 'Popular' fallback that uncategorised
  /// dishes carry, so without this they would be on no tab at all.
  List<String> get _cats {
    final base = r.categories;
    if (base.contains('Popular') || !r.menu.any((m) => m.category == 'Popular')) return base;
    return ['Popular', ...base];
  }

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_syncActiveTab);
    _menuSearch.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _scroll.dispose();
    _menuSearch.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  /// Height of everything pinned above the menu: collapsed app bar + tabs.
  double get _pinned =>
      kToolbarHeight + MediaQuery.paddingOf(context).top + _tabsHeight + (_searching ? _searchHeight : 0);

  double? _offsetOf(GlobalKey key) {
    final box = key.currentContext?.findRenderObject();
    if (box == null || !box.attached) return null;
    final viewport = RenderAbstractViewport.maybeOf(box);
    if (viewport == null) return null;
    return viewport.getOffsetToReveal(box, 0).offset - _pinned;
  }

  void _syncActiveTab() {
    if (_jumping || _searching || !_scroll.hasClients) return;
    String? current;
    final cats = _cats;
    for (final c in cats) {
      final key = _sectionKeys[c];
      if (key == null) continue;
      final at = _offsetOf(key);
      if (at != null && at <= _scroll.offset + 8) current = c;
    }
    current ??= cats.isEmpty ? '' : cats.first;
    if (current != _active) {
      setState(() => _active = current!);
      // Centre the chip in its own row only. Scrollable.ensureVisible would also
      // scroll the page to "reveal" the pinned row, snapping the menu to the top.
      final tab = _tabKeys[current]?.currentContext;
      final chip = tab?.findRenderObject();
      if (tab != null && chip != null) {
        Scrollable.of(tab).position.ensureVisible(chip, alignment: .5, duration: const Duration(milliseconds: 220));
      }
    }
  }

  Future<void> _jumpTo(String category) async {
    final key = _sectionKeys[category];
    if (key == null) return;
    final at = _offsetOf(key);
    if (at == null || !_scroll.hasClients) return;
    setState(() => _active = category);
    _jumping = true;
    await _scroll.animateTo(
      at.clamp(0, _scroll.position.maxScrollExtent),
      duration: const Duration(milliseconds: 380),
      curve: Curves.easeOutCubic,
    );
    _jumping = false;
  }

  void _toggleSearch() {
    setState(() {
      _searching = !_searching;
      if (!_searching) _menuSearch.clear();
    });
    if (_searching) _searchFocus.requestFocus();
  }

  List<MenuItem> _itemsFor(String category) => category == 'Popular'
      ? r.menu.where((m) => m.popular || m.category == 'Popular').toList()
      : r.menu.where((m) => m.category == category).toList();

  @override
  Widget build(BuildContext context) {
    final cats = _cats;
    if (_active.isEmpty && cats.isNotEmpty) _active = cats.first;
    final tokens = _menuSearch.text.toLowerCase().split(RegExp(r'\s+')).where((t) => t.isNotEmpty).toList();
    final query = tokens.isNotEmpty;

    final slivers = <Widget>[
      _Hero(restaurant: r),
      SliverToBoxAdapter(child: _Info(restaurant: r)),
      if (r.menu.isNotEmpty)
        SliverPersistentHeader(
          pinned: true,
          delegate: _TabsDelegate(
            extent: _tabsHeight + (_searching ? _searchHeight : 0),
            child: _MenuTabs(
              categories: cats,
              active: _active,
              tabKeys: _tabKeys,
              searching: _searching,
              onTap: _jumpTo,
              onToggleSearch: _toggleSearch,
              search: _searching
                  ? Padding(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                      child: TextField(
                        controller: _menuSearch,
                        focusNode: _searchFocus,
                        textInputAction: TextInputAction.search,
                        decoration: InputDecoration(
                          isDense: true,
                          hintText: 'Search ${r.name}\'s menu',
                          prefixIcon: const Icon(Icons.search_rounded),
                          suffixIcon: IconButton(
                            tooltip: 'Close menu search',
                            onPressed: _toggleSearch,
                            icon: const Icon(Icons.close_rounded),
                          ),
                        ),
                      ),
                    )
                  : null,
            ),
          ),
        ),
    ];

    if (r.menu.isEmpty) {
      slivers.add(const SliverToBoxAdapter(
        child: EmptyState(
          icon: Icons.menu_book_outlined,
          title: 'No dishes listed yet',
          body: 'This kitchen hasn\'t put its menu up. Check back soon.',
        ),
      ));
    } else if (query) {
      final results = r.menu.where((m) {
        final hay = '${m.name} ${m.description} ${m.category}'.toLowerCase();
        return tokens.every(hay.contains);
      }).toList();
      slivers.add(SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
          child: Text(
            '${results.length} ${results.length == 1 ? 'dish' : 'dishes'}',
            style: Theme.of(context).textTheme.titleLarge,
          ),
        ),
      ));
      slivers.add(results.isEmpty
          ? SliverToBoxAdapter(
              child: EmptyState(
                icon: Icons.search_off_rounded,
                title: 'Nothing on this menu matches',
                body: 'No dish here is called "${_menuSearch.text.trim()}". Try a shorter word.',
              ),
            )
          : SliverList.separated(
              itemCount: results.length,
              separatorBuilder: (_, _) => const _RowDivider(),
              itemBuilder: (_, i) => _MenuRow(restaurant: r, item: results[i]),
            ));
    } else {
      // One non-lazy column, so every section has a laid-out position the
      // tabs can scroll to.
      slivers.add(SliverToBoxAdapter(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final cat in cats)
              _Section(
                key: _sectionKeys.putIfAbsent(cat, GlobalKey.new),
                title: cat,
                note: cat == 'Popular' ? 'The dishes people order most here.' : null,
                children: [for (final m in _itemsFor(cat)) _MenuRow(restaurant: r, item: m)],
              ),
          ],
        ),
      ));
    }
    slivers.add(SliverToBoxAdapter(child: SizedBox(height: MediaQuery.sizeOf(context).height * .35)));

    return RefreshIndicator(
      onRefresh: () => refreshAll(ref, [restaurantProvider(r.slug)]),
      edgeOffset: kToolbarHeight + MediaQuery.paddingOf(context).top,
      child: CustomScrollView(
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: slivers,
      ),
    );
  }
}

// ---------- Hero ----------

class _Hero extends ConsumerStatefulWidget {
  const _Hero({required this.restaurant});
  final Restaurant restaurant;

  @override
  ConsumerState<_Hero> createState() => _HeroState();
}

class _HeroState extends ConsumerState<_Hero> {
  bool? _favorite; // optimistic, until the provider re-reads
  bool _busy = false;

  Future<void> _toggleFavorite(bool current) async {
    final r = widget.restaurant;
    if (ref.read(userIdProvider) == null) {
      context.push('/login?next=${Uri.encodeComponent('/restaurant/${r.slug}')}');
      return;
    }
    setState(() {
      _busy = true;
      _favorite = !current;
    });
    try {
      final on = await ref.read(accountRepoProvider).setFavorite(r.slug, !current);
      ref.invalidate(isFavoriteProvider(r.id));
      ref.invalidate(favoritesProvider);
      if (!mounted) return;
      setState(() => _favorite = on);
      showSnack(context, on ? 'Saved to favourites' : 'Removed from favourites');
    } catch (e) {
      if (!mounted) return;
      setState(() => _favorite = current);
      showSnack(context, e is ApiException ? e.friendly : 'Couldn\'t update favourites. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.restaurant;
    final c = context.colors;
    final fav = _favorite ?? ref.watch(isFavoriteProvider(r.id)).value ?? false;
    final top = MediaQuery.paddingOf(context).top;

    ButtonStyle circle() => IconButton.styleFrom(
          backgroundColor: c.surface,
          foregroundColor: c.ink,
          minimumSize: const Size(44, 44),
          elevation: 2,
          shadowColor: Colors.black26,
        );

    return SliverAppBar(
      pinned: true,
      expandedHeight: _heroHeight,
      automaticallyImplyLeading: false,
      backgroundColor: c.bg,
      leading: Padding(
        padding: const EdgeInsets.only(left: 8),
        child: Center(
          child: IconButton(
            tooltip: 'Back',
            style: circle(),
            onPressed: () => context.canPop() ? context.pop() : context.go('/'),
            icon: const Icon(Icons.arrow_back_rounded, size: 21),
          ),
        ),
      ),
      leadingWidth: 60,
      actions: [
        IconButton(
          tooltip: fav ? 'Remove from favourites' : 'Save to favourites',
          style: circle(),
          onPressed: _busy ? null : () => _toggleFavorite(fav),
          icon: Icon(
            fav ? Icons.favorite_rounded : Icons.favorite_border_rounded,
            size: 21,
            color: fav ? c.deal : c.ink,
          ),
        ),
        const SizedBox(width: 10),
      ],
      flexibleSpace: LayoutBuilder(
        builder: (context, box) {
          final min = kToolbarHeight + top;
          final t = ((box.maxHeight - min) / (_heroHeight + top - min)).clamp(0.0, 1.0);
          return Stack(
            fit: StackFit.expand,
            children: [
              Opacity(
                opacity: t,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    NetImage(
                      url: r.image,
                      tint: r.accentTint,
                      radius: 0,
                      fallback: Icon(Icons.restaurant_rounded, size: 52, color: Colors.white.withValues(alpha: .8)),
                    ),
                    const DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [Color(0x40000000), Color(0x00000000), Color(0x8C000000)],
                        ),
                      ),
                    ),
                    Positioned(
                      left: 20,
                      right: 20,
                      bottom: 18,
                      child: Text(
                        r.name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 25,
                          height: 1.1,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -0.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              // The name moves into the bar once the photo has scrolled away.
              Positioned(
                left: 72,
                right: 72,
                top: top,
                height: kToolbarHeight,
                child: IgnorePointer(
                  child: Opacity(
                    opacity: (1 - t * 3).clamp(0.0, 1.0),
                    child: Center(
                      child: Text(
                        r.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: c.ink, fontSize: 17, fontWeight: FontWeight.w800),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _Info extends ConsumerWidget {
  const _Info({required this.restaurant});
  final Restaurant restaurant;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = restaurant;
    final c = context.colors;
    final km = distanceToShop(ref.watch(locationProvider), r);
    final subtitle = r.tagline.trim().isNotEmpty ? r.tagline.trim() : r.cuisines.join(', ');
    final meta = TextStyle(color: c.muted, fontSize: 13.5, fontWeight: FontWeight.w600);

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (subtitle.isNotEmpty)
            Text(subtitle, style: TextStyle(color: c.muted, fontSize: 14.5, height: 1.35)),
          if (r.tagline.trim().isNotEmpty && r.cuisines.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(r.cuisines.join(' · '), style: TextStyle(color: c.muted, fontSize: 13)),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  RatingPill(rating: r.rating, count: r.ratingCount),
                  if (r.ratingCount > 0) ...[
                    const SizedBox(width: 5),
                    Text('(${r.ratingCount})', style: meta),
                  ],
                ],
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.schedule_rounded, size: 16, color: c.muted),
                  const SizedBox(width: 4),
                  Text(etaBand(r.etaMin, r.etaMax), style: meta),
                ],
              ),
              if (km != null)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.place_outlined, size: 16, color: c.muted),
                    const SizedBox(width: 3),
                    Text(distance(km), style: meta),
                  ],
                ),
              if (r.pace.busy && r.open)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(color: c.pop, borderRadius: BorderRadius.circular(8)),
                  child: Text(
                    'Busy · +${r.pace.addedMinutes} min',
                    style: TextStyle(color: c.popInk, fontWeight: FontWeight.w800, fontSize: 12),
                  ),
                ),
            ],
          ),
          if (r.address != null && r.address!.trim().isNotEmpty) ...[
            const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: Icon(Icons.storefront_outlined, size: 16, color: c.muted),
                ),
                const SizedBox(width: 6),
                Expanded(child: Text(r.address!.trim(), style: TextStyle(color: c.muted, fontSize: 13))),
              ],
            ),
          ],
          if (r.offer != null && r.open) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(12)),
              child: Row(
                children: [
                  Icon(Icons.local_offer_rounded, size: 18, color: c.deal),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(r.offer!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w700)),
                  ),
                ],
              ),
            ),
          ],
          if (!r.open) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(16)),
              child: Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(color: c.ink.withValues(alpha: .06), shape: BoxShape.circle),
                    child: Icon(Icons.bedtime_outlined, color: c.muted),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Not taking orders right now',
                            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
                        const SizedBox(height: 2),
                        Text(
                          'This shop reopens when they\'re ready — try again a bit later.',
                          style: TextStyle(color: c.muted, fontSize: 12.5),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

// ---------- Menu ----------

class _TabsDelegate extends SliverPersistentHeaderDelegate {
  _TabsDelegate({required this.extent, required this.child});
  final double extent;
  final Widget child;

  @override
  double get minExtent => extent;
  @override
  double get maxExtent => extent;

  @override
  bool shouldRebuild(covariant _TabsDelegate oldDelegate) => true;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) => Material(
        color: context.colors.bg,
        elevation: overlapsContent || shrinkOffset > 0 ? 1 : 0,
        child: child,
      );
}

class _MenuTabs extends StatelessWidget {
  const _MenuTabs({
    required this.categories,
    required this.active,
    required this.tabKeys,
    required this.searching,
    required this.onTap,
    required this.onToggleSearch,
    required this.search,
  });

  final List<String> categories;
  final String active;
  final Map<String, GlobalKey> tabKeys;
  final bool searching;
  final ValueChanged<String> onTap;
  final VoidCallback onToggleSearch;
  final Widget? search;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      children: [
        SizedBox(
          height: _tabsHeight,
          child: Row(
            children: [
              Expanded(
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
                  itemCount: categories.length,
                  separatorBuilder: (_, _) => const SizedBox(width: 8),
                  itemBuilder: (_, i) {
                    final cat = categories[i];
                    final on = cat == active && !searching;
                    return ChoiceChip(
                      key: tabKeys.putIfAbsent(cat, GlobalKey.new),
                      label: Text(cat),
                      selected: on,
                      showCheckmark: false,
                      onSelected: searching ? null : (_) => onTap(cat),
                      selectedColor: c.ink,
                      labelStyle: TextStyle(
                        color: on ? c.bg : c.ink,
                        fontWeight: on ? FontWeight.w800 : FontWeight.w600,
                        fontSize: 13,
                      ),
                    );
                  },
                ),
              ),
              if (!searching)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: IconButton(
                    tooltip: 'Search the menu',
                    onPressed: onToggleSearch,
                    icon: const Icon(Icons.search_rounded),
                  ),
                ),
            ],
          ),
        ),
        ?search,
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({super.key, required this.title, required this.children, this.note});
  final String title;
  final String? note;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(16, 20, 16, note == null ? 4 : 2),
            child: Text(title, style: Theme.of(context).textTheme.titleLarge),
          ),
          if (note != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
              child: Text(note!, style: TextStyle(color: context.colors.muted, fontSize: 13)),
            ),
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0) const _RowDivider(),
            children[i],
          ],
        ],
      );
}

class _RowDivider extends StatelessWidget {
  const _RowDivider();

  @override
  Widget build(BuildContext context) => const Divider(height: 1, indent: 16, endIndent: 16);
}

class _MenuRow extends ConsumerWidget {
  const _MenuRow({required this.restaurant, required this.item});
  final Restaurant restaurant;
  final MenuItem item;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final r = restaurant;
    final qty = ref.watch(cartProvider.select((s) => s.slug == r.slug ? s.qtyOf(item.id) : 0));
    final soldOut = !item.available;

    final Widget action = !r.open
        ? Container(
            height: 34,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: c.surface,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: c.line),
            ),
            child: Text('Closed', style: TextStyle(color: c.muted, fontWeight: FontWeight.w800, fontSize: 13)),
          )
        : QtyStepper(
            compact: true,
            qty: qty,
            enabled: !soldOut,
            onAdd: () => addToCart(context, ref, r, item),
            onRemove: () => ref.read(cartProvider.notifier).decrement(item.id),
          );

    return Semantics(
      button: true,
      label: '${item.name}, ${rupees(item.effective)}${soldOut ? ', sold out' : ''}',
      child: InkWell(
        onTap: () => showItemSheet(context, r, item),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 18),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Opacity(
                  opacity: soldOut ? .5 : 1,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          VegMark(item.veg),
                          if (item.popular) ...[
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: c.accentSoft,
                                borderRadius: BorderRadius.circular(5),
                              ),
                              child: Text('Bestseller',
                                  style: TextStyle(color: c.accentInk, fontSize: 11, fontWeight: FontWeight.w800)),
                            ),
                          ],
                          if (soldOut) ...[
                            Text('Sold out',
                                style: TextStyle(color: c.muted, fontSize: 12, fontWeight: FontWeight.w700)),
                          ],
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(item.name, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700, height: 1.25)),
                      const SizedBox(height: 4),
                      PriceText(price: item.price, effective: item.effective),
                      if (item.description.trim().isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Text(
                          item.description.trim(),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: c.muted, fontSize: 13, height: 1.35),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 14),
              if (item.image != null)
                SizedBox(
                  width: 112,
                  height: 128,
                  child: Stack(
                    clipBehavior: Clip.none,
                    alignment: Alignment.topCenter,
                    children: [
                      Opacity(
                        opacity: soldOut ? .5 : 1,
                        child: SizedBox(
                          width: 112,
                          height: 108,
                          child: NetImage(url: item.image, tint: r.accentTint, radius: 12),
                        ),
                      ),
                      Positioned(bottom: 0, child: action),
                    ],
                  ),
                )
              else
                Padding(padding: const EdgeInsets.only(top: 18), child: action),
            ],
          ),
        ),
      ),
    );
  }
}

class _MenuSkeleton extends StatelessWidget {
  const _MenuSkeleton();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget box(double? w, double h, [double r = 8]) => Container(
          width: w,
          height: h,
          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(r)),
        );
    return ListView(
      physics: const NeverScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: [
        box(null, 170, radiusBlock),
        const SizedBox(height: 16),
        box(220, 22),
        const SizedBox(height: 8),
        box(160, 14),
        const SizedBox(height: 24),
        for (var i = 0; i < 4; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 22),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [box(150, 16), const SizedBox(height: 8), box(60, 14), const SizedBox(height: 8), box(null, 12)],
                  ),
                ),
                const SizedBox(width: 14),
                box(100, 96, 12),
              ],
            ),
          ),
      ],
    );
  }
}
