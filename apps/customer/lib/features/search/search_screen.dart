import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../models/restaurant.dart';
import '../../models/taxonomy.dart';
import '../../state/cart.dart';
import '../../state/prefs.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/cart_widgets.dart';
import '../../widgets/common.dart';
import '../../widgets/restaurant_card.dart';

// ---------- Matching & ranking (a simplified src/lib/search/dishes.ts) ----------

// Same thresholds as the web's filter chips (dishes.ts / BUDGET_PRICE).
const _budget = 200;
const _fastEta = 25;
const _minRating = 4.5;
const _dishLimit = 60;
const _perShop = 4;
const _suggestions = ['Paneer', 'Biryani', 'Pizza', 'Cold coffee', 'Dosa'];

enum _Sort { relevance, price, eta, rating }

extension on _Sort {
  String get label => switch (this) {
        _Sort.relevance => 'Relevance',
        _Sort.price => 'Price: low to high',
        _Sort.eta => 'Fastest delivery',
        _Sort.rating => 'Rating',
      };
}

const _filters = <(String, String)>[
  ('veg', 'Veg only'),
  ('offers', 'Offers'),
  ('cheap', 'Under ₹$_budget'),
  ('rating', 'Rating $_minRating+'),
  ('fast', 'Under $_fastEta min'),
];

double _bayes(Restaurant r) {
  final n = r.ratingCount < 0 ? 0 : r.ratingCount;
  return (20 * 4.0 + r.rating * n) / (20 + n);
}

List<String> _tokens(String q) =>
    q.toLowerCase().split(RegExp(r'\s+')).where((t) => t.isNotEmpty).toList();

/// [needle] at the start of a word in [text] — so "tea" finds "Masala Tea"
/// but not "Steak".
bool _wordStart(String text, String needle) {
  var i = text.indexOf(needle);
  while (i >= 0) {
    if (i == 0 || !RegExp(r'[a-z0-9]').hasMatch(text[i - 1])) return true;
    i = text.indexOf(needle, i + 1);
  }
  return false;
}

class _Dish {
  _Dish(this.shop, this.item)
      : name = item.name.toLowerCase(),
        desc = item.description.toLowerCase(),
        cat = item.category.toLowerCase();
  final Restaurant shop;
  final MenuItem item;
  final String name;
  final String desc;
  final String cat;
}

class _Hit {
  _Hit(this.dish, this.tier);
  final _Dish dish;

  /// 3 exact name, 2 name prefix, 1 name contains every word, 0 elsewhere.
  final int tier;
}

class _ShopGroup {
  _ShopGroup(this.shop);
  final Restaurant shop;
  final List<_Hit> hits = [];
}

int _tier(_Dish d, List<String> tokens) {
  if (tokens.isEmpty) return 0;
  final query = tokens.join(' ');
  if (d.name == query) return 3;
  if (d.name.startsWith(query)) return 2;
  if (tokens.every(d.name.contains)) return 1;
  return 0;
}

bool _matchesQuery(_Dish d, List<String> tokens) =>
    tokens.every((t) => d.name.contains(t) || d.desc.contains(t) || d.cat.contains(t));

bool _matchesKeywords(_Dish d, FoodCategory c) =>
    c.keywords.any((k) => _wordStart(d.name, k) || _wordStart(d.cat, k));

/// Category pool, as categoryBasis on the web: dishes named for it when any
/// exist, otherwise the kitchens whose cuisine it is.
List<_Dish> _categoryPool(List<_Dish> index, FoodCategory c) {
  final byDish = index.where((d) => _matchesKeywords(d, c)).toList();
  if (byDish.isNotEmpty || c.cuisines.isEmpty) return byDish;
  return index.where((d) => d.shop.cuisines.any(c.cuisines.contains)).toList();
}

/// Name match first; then what can actually be ordered (open shop, dish in
/// stock); then the kitchen's evidence-weighted rating.
int _relevance(_Hit a, _Hit b) {
  int first(bool x, bool y) => x == y ? 0 : (x ? -1 : 1);
  final steps = [
    () => b.tier.compareTo(a.tier),
    () => first(a.dish.shop.open, b.dish.shop.open),
    () => first(a.dish.item.available, b.dish.item.available),
    () => _bayes(b.dish.shop).compareTo(_bayes(a.dish.shop)),
    () => first(a.dish.item.popular, b.dish.item.popular),
    () => a.dish.item.name.compareTo(b.dish.item.name),
  ];
  for (final s in steps) {
    final v = s();
    if (v != 0) return v;
  }
  return 0;
}

int _compare(_Hit a, _Hit b, _Sort sort) {
  final primary = switch (sort) {
    _Sort.relevance => 0,
    _Sort.price => a.dish.item.effective.compareTo(b.dish.item.effective),
    _Sort.eta => a.dish.shop.etaMin.compareTo(b.dish.shop.etaMin),
    _Sort.rating => _bayes(b.dish.shop).compareTo(_bayes(a.dish.shop)),
  };
  return primary != 0 ? primary : _relevance(a, b);
}

bool _passesShop(Restaurant r, Set<String> chips) {
  if (chips.contains('fast') && r.etaMax > _fastEta) return false;
  if (chips.contains('rating') && (r.ratingCount == 0 || r.rating < _minRating)) return false;
  return true;
}

bool _passes(_Dish d, Set<String> chips) {
  final i = d.item;
  if (chips.contains('veg') && !i.veg) return false;
  if (chips.contains('offers') && !i.onSale) return false;
  if (chips.contains('cheap') && i.effective > _budget) return false;
  return _passesShop(d.shop, chips);
}

// ---------- Screen ----------

class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key, this.query, this.category});
  final String? query;
  final String? category;

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> with SingleTickerProviderStateMixin {
  late final _field = TextEditingController(text: widget.query ?? '');
  final _focus = FocusNode();
  late final _tabs = TabController(length: 2, vsync: this)..addListener(_onTab);
  Timer? _debounce;
  late String _query = widget.query ?? '';
  late String? _category =
      foodCategories.any((c) => c.id == widget.category) ? widget.category : null;
  final Set<String> _chips = {};
  _Sort _sort = _Sort.relevance;

  List<Restaurant>? _indexedFrom;
  List<_Dish> _index = const [];

  void _onTab() {
    if (!_tabs.indexIsChanging) setState(() {});
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _field.dispose();
    _focus.dispose();
    _tabs.dispose();
    super.dispose();
  }

  void _onChanged(String v) {
    setState(() {}); // clear button
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 200), () {
      if (mounted) setState(() => _query = v);
    });
  }

  void _setQuery(String v, {bool save = false}) {
    _debounce?.cancel();
    _field.value = TextEditingValue(text: v, selection: TextSelection.collapsed(offset: v.length));
    setState(() => _query = v);
    if (save) ref.read(searchHistoryProvider.notifier).add(v);
  }

  List<_Dish> _indexOf(List<Restaurant> shops) {
    if (!identical(shops, _indexedFrom)) {
      _indexedFrom = shops;
      _index = [
        for (final r in shops)
          for (final m in r.menu) _Dish(r, m),
      ];
    }
    return _index;
  }

  @override
  Widget build(BuildContext context) {
    final catalog = ref.watch(searchCatalogProvider);
    final c = context.colors;
    final tokens = _tokens(_query);
    final idle = tokens.isEmpty && _category == null && _chips.isEmpty;

    Widget body;
    var dishCount = 0;
    var shopCount = 0;
    final shops = catalog.value;
    if (idle) {
      body = _IdleView(onPick: (q) => _setQuery(q, save: true), onCategory: _pickCategory);
    } else if (shops == null && catalog.hasError) {
      body = ErrorRetry(error: catalog.error!, onRetry: () => ref.invalidate(searchCatalogProvider));
    } else if (shops == null) {
      body = const Center(child: CircularProgressIndicator());
    } else {
      final index = _indexOf(shops);
      final cat = foodCategories.where((x) => x.id == _category).firstOrNull;
      final pool = cat == null ? index : _categoryPool(index, cat);
      final hits = [
        for (final d in pool)
          if (_passes(d, _chips) && (tokens.isEmpty || _matchesQuery(d, tokens))) _Hit(d, _tier(d, tokens)),
      ]..sort((a, b) => _compare(a, b, _sort));

      // Shops: those with matching dishes, plus any whose name or cuisine
      // answers the words themselves.
      final groups = <String, _ShopGroup>{};
      for (final h in hits) {
        groups.putIfAbsent(h.dish.shop.id, () => _ShopGroup(h.dish.shop)).hits.add(h);
      }
      final shopList = groups.values.map((g) => g.shop).toList();
      if (tokens.isNotEmpty) {
        for (final r in shops) {
          if (groups.containsKey(r.id) || !_passesShop(r, _chips)) continue;
          if (cat != null && !r.cuisines.any(cat.cuisines.contains)) continue;
          final hay = '${r.name} ${r.cuisines.join(' ')} ${r.tagline}'.toLowerCase();
          if (tokens.every(hay.contains)) shopList.add(r);
        }
      }
      int nameHit(Restaurant r) => tokens.isNotEmpty && tokens.every(r.name.toLowerCase().contains) ? 0 : 1;
      shopList.sort((a, b) {
        if (a.open != b.open) return a.open ? -1 : 1;
        final n = nameHit(a).compareTo(nameHit(b));
        if (n != 0) return n;
        return switch (_sort) {
          _Sort.eta => a.etaMin.compareTo(b.etaMin),
          _ => _bayes(b).compareTo(_bayes(a)),
        };
      });

      dishCount = hits.length;
      shopCount = shopList.length;

      body = TabBarView(
        controller: _tabs,
        children: [
          _DishResults(
            groups: _limitGroups(hits),
            total: hits.length,
            empty: _NoResults(
              query: _query.trim(),
              onClear: _clearFilters,
              onCategory: _pickCategory,
            ),
          ),
          shopList.isEmpty
              ? _NoResults(query: _query.trim(), onClear: _clearFilters, onCategory: _pickCategory)
              : ListView.separated(
                  keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                  itemCount: shopList.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 20),
                  itemBuilder: (_, i) => RestaurantCard(restaurant: shopList[i]),
                ),
        ],
      );
    }

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
              child: TextField(
                controller: _field,
                focusNode: _focus,
                autofocus: widget.category == null && widget.query == null,
                textInputAction: TextInputAction.search,
                onChanged: _onChanged,
                onSubmitted: (v) => _setQuery(v, save: true),
                decoration: InputDecoration(
                  hintText: 'Search for a dish, cuisine or restaurant',
                  prefixIcon: Icon(Icons.search_rounded, color: c.ink),
                  suffixIcon: _field.text.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Clear search',
                          onPressed: () {
                            _setQuery('');
                            _focus.requestFocus();
                          },
                          icon: const Icon(Icons.close_rounded),
                        ),
                ),
              ),
            ),
            if (!idle) ...[
              _Segmented(controller: _tabs, dishCount: dishCount, shopCount: shopCount),
              const SizedBox(height: 8),
            ],
            _FilterRow(
              category: _category,
              chips: _chips,
              sort: _sort,
              onCategory: () => setState(() => _category = null),
              onToggle: (id) => setState(() => _chips.contains(id) ? _chips.remove(id) : _chips.add(id)),
              onSort: _pickSort,
            ),
            const SizedBox(height: 4),
            Expanded(child: body),
          ],
        ),
      ),
    );
  }

  /// Caps the dish list at [_dishLimit] dishes, grouped by kitchen in the
  /// order each kitchen first appears in the ranking.
  List<_ShopGroup> _limitGroups(List<_Hit> hits) {
    final out = <String, _ShopGroup>{};
    for (final h in hits.take(_dishLimit)) {
      out.putIfAbsent(h.dish.shop.id, () => _ShopGroup(h.dish.shop)).hits.add(h);
    }
    return out.values.toList();
  }

  void _pickCategory(String id) {
    FocusScope.of(context).unfocus();
    setState(() => _category = id);
  }

  void _clearFilters() => setState(() {
        _chips.clear();
        _category = null;
      });

  Future<void> _pickSort() async {
    final picked = await showModalBottomSheet<_Sort>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text('Sort by', style: Theme.of(ctx).textTheme.titleLarge),
            ),
            RadioGroup<_Sort>(
              groupValue: _sort,
              onChanged: (v) => Navigator.pop(ctx, v),
              child: Column(
                children: [
                  for (final s in _Sort.values)
                    RadioListTile<_Sort>(
                      value: s,
                      title: Text(s.label, style: const TextStyle(fontWeight: FontWeight.w600)),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (picked != null) setState(() => _sort = picked);
  }
}

// ---------- Header pieces ----------

class _Segmented extends StatelessWidget {
  const _Segmented({required this.controller, required this.dishCount, required this.shopCount});
  final TabController controller;
  final int dishCount;
  final int shopCount;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget tab(IconData icon, String label, int n) => Tab(
          height: 40,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 17),
              const SizedBox(width: 6),
              Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
              const SizedBox(width: 5),
              Text('$n', style: const TextStyle(fontWeight: FontWeight.w600)),
            ],
          ),
        );
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(99)),
      child: TabBar(
        controller: controller,
        dividerColor: Colors.transparent,
        indicatorSize: TabBarIndicatorSize.tab,
        indicator: BoxDecoration(color: c.accent, borderRadius: BorderRadius.circular(99)),
        labelColor: c.onAccent,
        unselectedLabelColor: c.muted,
        labelStyle: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5),
        splashBorderRadius: BorderRadius.circular(99),
        tabs: [
          tab(Icons.restaurant_menu_rounded, 'Dishes', dishCount),
          tab(Icons.storefront_rounded, 'Shops', shopCount),
        ],
      ),
    );
  }
}

class _FilterRow extends StatelessWidget {
  const _FilterRow({
    required this.category,
    required this.chips,
    required this.sort,
    required this.onCategory,
    required this.onToggle,
    required this.onSort,
  });

  final String? category;
  final Set<String> chips;
  final _Sort sort;
  final VoidCallback onCategory;
  final ValueChanged<String> onToggle;
  final VoidCallback onSort;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final cat = foodCategories.where((x) => x.id == category).firstOrNull;
    return SizedBox(
      height: 48,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        children: [
          ActionChip(
            avatar: Icon(Icons.swap_vert_rounded, size: 18, color: c.ink),
            label: Text(sort == _Sort.relevance ? 'Sort' : sort.label),
            onPressed: onSort,
            backgroundColor: sort == _Sort.relevance ? c.surface : c.accentSoft,
            side: BorderSide(color: sort == _Sort.relevance ? c.line : c.accent),
          ),
          if (cat != null) ...[
            const SizedBox(width: 8),
            InputChip(
              label: Text(cat.label),
              selected: true,
              showCheckmark: false,
              onDeleted: onCategory,
              deleteButtonTooltipMessage: 'Remove ${cat.label}',
              onPressed: onCategory,
            ),
          ],
          for (final (id, label) in _filters) ...[
            const SizedBox(width: 8),
            FilterChip(
              label: Text(label),
              selected: chips.contains(id),
              onSelected: (_) => onToggle(id),
              showCheckmark: false,
              avatar: id == 'veg' ? const VegMark(true, size: 13) : null,
            ),
          ],
        ],
      ),
    );
  }
}

// ---------- Idle: recent searches + categories ----------

class _IdleView extends ConsumerWidget {
  const _IdleView({required this.onPick, required this.onCategory});
  final ValueChanged<String> onPick;
  final ValueChanged<String> onCategory;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final history = ref.watch(searchHistoryProvider);
    final c = context.colors;
    final label = TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, letterSpacing: 0.7, color: c.muted);
    return ListView(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        if (history.isNotEmpty) ...[
          Row(
            children: [
              Expanded(child: Text('RECENT', style: label)),
              TextButton(
                onPressed: () => ref.read(searchHistoryProvider.notifier).clear(),
                child: const Text('Clear'),
              ),
            ],
          ),
          for (final term in history)
            InkWell(
              onTap: () => onPick(term),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 46),
                child: Row(
                  children: [
                    Icon(Icons.history_rounded, size: 19, color: c.muted),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(term,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                    ),
                    Icon(Icons.north_west_rounded, size: 16, color: c.muted),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 16),
        ],
        Text('TRY SEARCHING', style: label),
        const SizedBox(height: 4),
        Wrap(
          spacing: 4,
          children: [
            for (final s in _suggestions)
              TextButton.icon(
                onPressed: () => onPick(s),
                style: TextButton.styleFrom(foregroundColor: c.ink, minimumSize: const Size(44, 44)),
                icon: Icon(Icons.search_rounded, size: 16, color: c.muted),
                label: Text(s, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              ),
          ],
        ),
        const SizedBox(height: 18),
        Text('BROWSE BY CATEGORY', style: label),
        const SizedBox(height: 10),
        _CategoryChips(onPick: onCategory),
      ],
    );
  }
}

class _CategoryChips extends StatelessWidget {
  const _CategoryChips({required this.onPick});
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    final emoji = {for (final t in homeCategories) t.id: t.emoji};
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final cat in foodCategories)
          ActionChip(
            avatar: emoji[cat.id] == null ? null : Text(emoji[cat.id]!),
            label: Text(cat.label),
            onPressed: () => onPick(cat.id),
          ),
      ],
    );
  }
}

class _NoResults extends StatelessWidget {
  const _NoResults({required this.query, required this.onClear, required this.onCategory});
  final String query;
  final VoidCallback onClear;
  final ValueChanged<String> onCategory;

  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
        children: [
          EmptyState(
            icon: Icons.search_off_rounded,
            title: query.isEmpty ? 'No matches — yet' : 'No matches for “$query”',
            body: 'No kitchen near you is cooking that right now. Try a shorter word, '
                'clear a filter, or browse a category.',
            action: 'Clear filters',
            onAction: onClear,
          ),
          _CategoryChips(onPick: onCategory),
        ],
      );
}

// ---------- Dish results ----------

class _DishResults extends StatelessWidget {
  const _DishResults({required this.groups, required this.total, required this.empty});
  final List<_ShopGroup> groups;
  final int total;
  final Widget empty;

  @override
  Widget build(BuildContext context) {
    if (groups.isEmpty) return empty;
    final c = context.colors;
    return ListView.builder(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
      itemCount: groups.length + (total > _dishLimit ? 1 : 0),
      itemBuilder: (context, i) {
        if (i == groups.length) {
          return Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text(
              'Showing the top $_dishLimit of $total dishes — type more to narrow it down.',
              textAlign: TextAlign.center,
              style: TextStyle(color: c.muted, fontSize: 13),
            ),
          );
        }
        return _ShopBlock(group: groups[i]);
      },
    );
  }
}

class _ShopBlock extends StatelessWidget {
  const _ShopBlock({required this.group});
  final _ShopGroup group;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = group.shop;
    final shown = group.hits.take(_perShop).toList();
    final more = group.hits.length - shown.length;
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Panel(
        padding: EdgeInsets.zero,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            InkWell(
              borderRadius: const BorderRadius.vertical(top: Radius.circular(radiusBlock)),
              onTap: () => context.push('/restaurant/${r.slug}'),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 8, 10),
                child: Row(
                  children: [
                    SizedBox(width: 40, height: 40, child: NetImage(url: r.image, tint: r.accentTint, radius: 10)),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(r.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                          const SizedBox(height: 2),
                          Row(
                            children: [
                              RatingPill(rating: r.rating, count: r.ratingCount),
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(
                                  r.open ? '${r.etaMin}–${r.etaMax} min' : 'Closed now',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: r.open ? c.muted : c.deal,
                                    fontSize: 12.5,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    Icon(Icons.chevron_right_rounded, color: c.muted),
                  ],
                ),
              ),
            ),
            Divider(height: 1, color: c.line),
            for (var i = 0; i < shown.length; i++) ...[
              if (i > 0) Divider(height: 1, indent: 12, endIndent: 12, color: c.line),
              _DishRow(shop: r, item: shown[i].dish.item),
            ],
            if (more > 0)
              TextButton(
                onPressed: () => context.push('/restaurant/${r.slug}'),
                child: Text('+$more more at ${r.name}'),
              ),
          ],
        ),
      ),
    );
  }
}

class _DishRow extends ConsumerWidget {
  const _DishRow({required this.shop, required this.item});
  final Restaurant shop;
  final MenuItem item;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final cart = ref.watch(cartProvider);
    final qty = cart.slug == shop.slug ? cart.qtyOf(item.id) : 0;
    final canAdd = shop.open && item.available;
    return InkWell(
      onTap: () => context.push('/restaurant/${shop.slug}'),
      child: Opacity(
        opacity: canAdd ? 1 : .6,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Row(
            children: [
              if (item.image != null) ...[
                SizedBox(width: 56, height: 56, child: NetImage(url: item.image, tint: shop.accentTint, radius: 10)),
                const SizedBox(width: 10),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        VegMark(item.veg),
                        if (item.popular) ...[
                          const SizedBox(width: 6),
                          Text('Bestseller',
                              style: TextStyle(color: c.accentInk, fontSize: 11.5, fontWeight: FontWeight.w800)),
                        ],
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(item.name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14.5)),
                    const SizedBox(height: 3),
                    PriceText(price: item.price, effective: item.effective, size: 14),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              if (!shop.open)
                Text('Closed', style: TextStyle(color: c.muted, fontWeight: FontWeight.w700, fontSize: 13))
              else
                QtyStepper(
                  compact: true,
                  qty: qty,
                  enabled: item.available,
                  onAdd: () => addToCart(context, ref, shop, item),
                  onRemove: () => ref.read(cartProvider.notifier).decrement(item.id),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
