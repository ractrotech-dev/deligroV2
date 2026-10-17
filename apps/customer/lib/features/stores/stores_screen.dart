import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../models/restaurant.dart';
import '../../models/settings.dart';
import '../../models/taxonomy.dart';
import '../../state/location.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/restaurant_card.dart';

/// Categories that open their own screen rather than a filtered list, so an
/// empty shop count is not a dead end for them.
const _ownScreen = {'groceries', 'pick-drop'};

/// Same rule as the web: a switched-off service has no tile at all.
List<StoreCategory> _enabled(PlatformSettings s) => [
      for (final c in storeCategories)
        if ((c.id != 'groceries' || s.featureGrocery) && (c.id != 'pick-drop' || s.featurePickDrop)) c,
    ];

bool _inCategory(Restaurant r, StoreCategory c) => r.cuisines.any(
      (x) => c.tags.any((t) => t.toLowerCase() == x.toLowerCase()),
    );

class StoresScreen extends ConsumerStatefulWidget {
  const StoresScreen({super.key, this.category});
  final String? category;

  @override
  ConsumerState<StoresScreen> createState() => _StoresScreenState();
}

class _StoresScreenState extends ConsumerState<StoresScreen> {
  late String? _selected = widget.category;

  @override
  void didUpdateWidget(covariant StoresScreen old) {
    super.didUpdateWidget(old);
    // The tab stays alive in the shell, so a banner deep link to
    // /stores?category=… arrives as a new widget on the same state.
    if (old.category != widget.category) _selected = widget.category;
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider).value ?? PlatformSettings.defaults;
    final restaurants = ref.watch(restaurantsProvider);
    final list = restaurants.value ?? const <Restaurant>[];
    final categories = _enabled(settings);
    // An unknown or switched-off ?category= reads as "no filter".
    final active = categories.where((c) => c.id == _selected).firstOrNull;

    final counts = {for (final c in categories) c.id: list.where((r) => _inCategory(r, c)).length};
    bool dead(StoreCategory c) => counts[c.id] == 0 && !_ownScreen.contains(c.id);
    final ordered = [...categories]..sort((a, b) => (dead(a) ? 1 : 0) - (dead(b) ? 1 : 0));

    final inView = active == null ? list : list.where((r) => _inCategory(r, active)).toList();
    int soonest(Restaurant a, Restaurant b) => a.etaMin.compareTo(b.etaMin);
    final openNow = inView.where((r) => r.open).toList()..sort(soonest);
    final closed = inView.where((r) => !r.open).toList()..sort(soonest);
    final pickDrop = active?.id == 'pick-drop';

    final slivers = <Widget>[
      SliverAppBar(
        floating: true,
        snap: true,
        automaticallyImplyLeading: false,
        titleSpacing: 16,
        title: const Text('Stores', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
        actions: [
          IconButton(
            tooltip: 'Search',
            onPressed: () => context.go('/search'),
            icon: const Icon(Icons.search_rounded),
          ),
          const SizedBox(width: 6),
        ],
      ),
      const SliverToBoxAdapter(child: SectionTitle('Categories', padding: EdgeInsets.fromLTRB(16, 6, 16, 10))),
      SliverToBoxAdapter(
        child: _StoreCategoryStrip(
          categories: ordered,
          selected: active?.id,
          muted: {for (final c in ordered) if (dead(c)) c.id},
          onSelect: (id) => setState(() => _selected = _selected == id ? null : id),
        ),
      ),
    ];

    if (restaurants.value == null && restaurants.hasError) {
      slivers.add(SliverFillRemaining(
        hasScrollBody: false,
        child: ErrorRetry(
          error: restaurants.error!,
          onRetry: () => ref.invalidate(restaurantsProvider),
        ),
      ));
    } else if (restaurants.value == null) {
      slivers.add(const SliverToBoxAdapter(
        child: Padding(padding: EdgeInsets.all(48), child: Center(child: CircularProgressIndicator())),
      ));
    } else {
      if (active?.id == 'groceries' && settings.supportWhatsapp.replaceAll(RegExp(r'\D'), '').isNotEmpty) {
        slivers.add(SliverToBoxAdapter(child: _GroceryListHero(whatsapp: settings.supportWhatsapp)));
      }
      if (pickDrop) {
        slivers.add(const SliverToBoxAdapter(child: _PickDropHero()));
      } else if (inView.isEmpty) {
        slivers.add(SliverToBoxAdapter(
          child: EmptyState(
            icon: Icons.storefront_outlined,
            title: 'No ${active?.label.toLowerCase() ?? 'stores'} yet',
            body: 'We haven\'t onboarded a ${active?.label.toLowerCase() ?? 'store'} near you. '
                'Browse everything else in the meantime.',
            action: active == null ? null : 'Show all stores',
            onAction: active == null ? null : () => setState(() => _selected = null),
          ),
        ));
      } else {
        final inActive = active == null ? '' : 'in ${active.label.toLowerCase()} ';
        if (openNow.isNotEmpty) {
          slivers.add(SliverToBoxAdapter(child: _CountTitle(active?.label ?? 'Open now', openNow.length)));
          slivers.add(_cards(openNow));
        } else {
          slivers.add(SliverToBoxAdapter(
            child: Container(
              margin: const EdgeInsets.fromLTRB(16, 20, 16, 0),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                color: context.colors.surface2,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Text(
                'Nothing ${inActive}is open right now. The kitchens below are closed — '
                'you can still look at their menus.',
                style: TextStyle(color: context.colors.muted, fontSize: 13, height: 1.35),
              ),
            ),
          ));
        }
        if (closed.isNotEmpty) {
          slivers.add(SliverToBoxAdapter(child: _CountTitle('Closed right now', closed.length, muted: true)));
          slivers.add(_cards(closed));
        }
      }
      slivers.add(const SliverToBoxAdapter(child: SizedBox(height: 24)));
    }

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () => refreshAll(ref, [restaurantsProvider, settingsProvider]),
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: slivers,
        ),
      ),
    );
  }

  Widget _cards(List<Restaurant> shops) => SliverPadding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        sliver: SliverList.separated(
          itemCount: shops.length,
          separatorBuilder: (_, _) => const SizedBox(height: 20),
          itemBuilder: (_, i) => RestaurantCard(restaurant: shops[i]),
        ),
      );
}

class _CountTitle extends StatelessWidget {
  const _CountTitle(this.title, this.count, {this.muted = false});
  final String title;
  final int count;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 24, 16, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Flexible(
            child: Text(
              title,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    fontSize: 19,
                    color: muted ? c.muted : c.ink,
                  ),
            ),
          ),
          const SizedBox(width: 8),
          Text('$count', style: TextStyle(color: c.muted, fontSize: 13, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

class _StoreCategoryStrip extends StatelessWidget {
  const _StoreCategoryStrip({
    required this.categories,
    required this.selected,
    required this.muted,
    required this.onSelect,
  });

  final List<StoreCategory> categories;
  final String? selected;

  /// Tiles with nothing behind them yet — dimmed, sorted last, still tappable.
  final Set<String> muted;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SizedBox(
      height: 118,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: categories.length,
        separatorBuilder: (_, _) => const SizedBox(width: 12),
        itemBuilder: (context, i) {
          final cat = categories[i];
          final on = cat.id == selected;
          return Semantics(
            button: true,
            selected: on,
            label: cat.label,
            excludeSemantics: true,
            child: InkWell(
              borderRadius: BorderRadius.circular(radiusBlock),
              onTap: () => onSelect(cat.id),
              child: Opacity(
                opacity: muted.contains(cat.id) && !on ? .5 : 1,
                child: SizedBox(
                  width: 76,
                  child: Column(
                    children: [
                      AnimatedContainer(
                        duration: const Duration(milliseconds: 180),
                        width: 72,
                        height: 72,
                        padding: const EdgeInsets.all(3),
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(color: on ? c.accent : Colors.transparent, width: 2.4),
                        ),
                        child: NetImage(
                          url: cat.image,
                          radius: 36,
                          fallback: Text(cat.emoji, style: const TextStyle(fontSize: 28)),
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
                          fontWeight: on ? FontWeight.w800 : FontWeight.w600,
                          color: on ? c.accentInk : c.ink,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

// The web's brand-orange hero for the two service categories.
const _heroTint = 'linear-gradient(150deg,#f2a71b,#e59a01,#d98600)';
const _waGreen = Color(0xFF25D366);

class _GroceryListHero extends ConsumerStatefulWidget {
  const _GroceryListHero({required this.whatsapp});
  final String whatsapp;

  @override
  ConsumerState<_GroceryListHero> createState() => _GroceryListHeroState();
}

class _GroceryListHeroState extends ConsumerState<_GroceryListHero> {
  final _note = TextEditingController();

  @override
  void initState() {
    super.initState();
    _note.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final list = _note.text.trim();
    if (list.isEmpty) return;
    final loc = ref.read(locationProvider);
    final where = loc.isFallback
        ? ''
        : '\n\nDeliver to: ${loc.label}${loc.sublabel != null && loc.sublabel!.isNotEmpty ? ', ${loc.sublabel}' : ''}';
    final digits = widget.whatsapp.replaceAll(RegExp(r'\D'), '');
    final text = 'Deligro grocery order 🛒\n\n$list$where';
    final ok = await launchUrl(
      Uri.parse('https://wa.me/$digits?text=${Uri.encodeComponent(text)}'),
      mode: LaunchMode.externalApplication,
    );
    if (!ok && mounted) showSnack(context, 'Couldn\'t open WhatsApp on this phone.');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final empty = _note.text.trim().isEmpty;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 0),
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          gradient: tintGradient(_heroTint),
          borderRadius: BorderRadius.circular(24),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const _HeroBadge(icon: Icons.shopping_bag_outlined, label: 'GROCERIES'),
            const SizedBox(height: 12),
            const Text(
              'Send your grocery list',
              style: TextStyle(
                color: Colors.white,
                fontSize: 23,
                height: 1.15,
                fontWeight: FontWeight.w800,
                letterSpacing: -0.4,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'No time to browse? Send us your list and we shop it for you.',
              style: TextStyle(
                color: Colors.white.withValues(alpha: .92),
                fontSize: 13.5,
                fontWeight: FontWeight.w500,
                height: 1.35,
              ),
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(16)),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Write your list', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13, color: c.ink)),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _note,
                    minLines: 4,
                    maxLines: 8,
                    keyboardType: TextInputType.multiline,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(
                      fillColor: c.surface2,
                      hintText: 'e.g. 2kg atta, 1 dozen eggs, Amul butter 500g, 1L milk…',
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide.none,
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: _waGreen, width: 1.6),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  FilledButton.icon(
                    onPressed: empty ? null : _send,
                    style: FilledButton.styleFrom(
                      backgroundColor: _waGreen,
                      foregroundColor: Colors.white,
                      minimumSize: const Size.fromHeight(48),
                      shape: const StadiumBorder(),
                    ),
                    icon: const Icon(Icons.chat_rounded, size: 18),
                    label: const Text('Send list on WhatsApp'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PickDropHero extends StatelessWidget {
  const _PickDropHero();

  @override
  Widget build(BuildContext context) {
    const body = TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 0),
      child: Column(
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: tintGradient(_heroTint),
              borderRadius: BorderRadius.circular(24),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const _HeroBadge(icon: Icons.inventory_2_outlined, label: 'ERRAND SERVICE · COMING SOON'),
                const SizedBox(height: 12),
                const Text(
                  'Pick & Drop',
                  style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -0.4),
                ),
                const SizedBox(height: 8),
                Text(
                  'Need something moved across town? Our rider picks it up and drops it at the door — '
                  'parcels, documents, forgotten keys, all of it.',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: .92),
                    fontSize: 13.5,
                    fontWeight: FontWeight.w500,
                    height: 1.35,
                  ),
                ),
                const SizedBox(height: 16),
                const Row(children: [
                  Icon(Icons.location_on_outlined, size: 16, color: Colors.white),
                  SizedBox(width: 8),
                  Text('Anywhere within Bemetara', style: body),
                ]),
                const SizedBox(height: 8),
                const Row(children: [
                  Icon(Icons.schedule_rounded, size: 16, color: Colors.white),
                  SizedBox(width: 8),
                  Text('Same-hour door-to-door pickup', style: body),
                ]),
                const SizedBox(height: 10),
                const Align(
                  alignment: Alignment.centerRight,
                  child: Icon(Icons.delivery_dining_rounded, size: 84, color: Colors.white),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Text(
            'Coming soon — Pick & Drop will be rolling out in Bemetara soon.',
            textAlign: TextAlign.center,
            style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14, color: context.colors.ink),
          ),
        ],
      ),
    );
  }
}

class _HeroBadge extends StatelessWidget {
  const _HeroBadge({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: .2),
          borderRadius: BorderRadius.circular(99),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: Colors.white),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                label,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.5,
                ),
              ),
            ),
          ],
        ),
      );
}
