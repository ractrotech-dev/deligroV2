import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/orders.dart' show VendorRef;
import '../../models/products.dart';
import '../../state/products.dart';
import '../../state/session.dart';
import '../../state/vendors.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import 'product_detail_screen.dart';
import 'product_filters_sheet.dart';
import 'product_tile.dart';

/// Products across the manager's vendors (§12.1–12.3): what is unavailable,
/// sold out, low, waiting for approval, flagged or hidden, searchable and
/// paged. Categories, insights and restricted categories hang off the menu.
const productsWideBreakpoint = 840.0;

class ProductsScreen extends ConsumerStatefulWidget {
  const ProductsScreen({super.key, this.query, this.onOpen});

  final Uri? query;
  final void Function(BuildContext context, ProductListItem product)? onOpen;

  @override
  ConsumerState<ProductsScreen> createState() => _ProductsScreenState();
}

class _ProductsScreenState extends ConsumerState<ProductsScreen> {
  late ProductFilters _filters;
  late final TextEditingController _search;
  final _scroll = ScrollController();
  Timer? _debounce;
  ProductCounts _counts = const ProductCounts();
  ProductFilters? _effective;
  bool _wide = false;
  String? _selected;

  @override
  void initState() {
    super.initState();
    final q = widget.query;
    _filters = q == null || q.queryParameters.isEmpty ? const ProductFilters() : ProductFilters.fromUri(q);
    _search = TextEditingController(text: _filters.q ?? '');
    _scroll.addListener(_onScroll);
  }

  @override
  void didUpdateWidget(ProductsScreen old) {
    super.didUpdateWidget(old);
    final q = widget.query;
    if (q?.toString() != old.query?.toString() && q != null && q.queryParameters.isNotEmpty) {
      _filters = ProductFilters.fromUri(q);
      _search.text = _filters.q ?? '';
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _set(ProductFilters f) {
    if (f == _filters && f.vendorName == _filters.vendorName) return;
    setState(() => _filters = f);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  void _onSearch(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () {
      final q = text.trim();
      _set(_filters.copyWith(q: q.length < 2 ? null : q));
    });
  }

  void _onScroll() {
    final eff = _effective;
    if (eff == null || !_scroll.hasClients) return;
    final p = _scroll.position;
    if (p.maxScrollExtent > 0 && p.pixels >= p.maxScrollExtent * 0.8) {
      ref.read(productListProvider(eff).notifier).loadMore();
    }
  }

  void _open(ProductListItem p) {
    if (_wide) {
      setState(() => _selected = p.id);
      return;
    }
    final custom = widget.onOpen;
    if (custom != null) {
      custom(context, p);
    } else {
      GoRouter.maybeOf(context)?.push('/more/products/${p.id}');
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.zoneId != null || zone == null ? _filters : _filters.copyWith(zoneId: zone.id);
    _effective = eff;
    final value = ref.watch(productListProvider(eff));
    final data = value.value;
    if (data != null) _counts = data.counts;
    final moderator = me?.can('manager.products.moderate') ?? false;
    final adjustStock = me?.can('manager.products.adjust_stock') ?? false;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Products'),
        backgroundColor: c.bg,
        actions: [
          const ZonePickerChip(),
          PopupMenuButton<String>(
            key: const Key('products-menu'),
            tooltip: 'More',
            onSelected: (path) => GoRouter.maybeOf(context)?.push(path),
            itemBuilder: (_) => [
              const PopupMenuItem(value: '/more/products/categories', child: Text('Categories')),
              const PopupMenuItem(value: '/more/products/insights', child: Text('Insights')),
              if (adjustStock) const PopupMenuItem(value: '/more/products/bulk', child: Text('Bulk stock update')),
              if (moderator) const PopupMenuItem(value: '/more/products/image-reviews', child: Text('Photos to review')),
              if (moderator) const PopupMenuItem(value: '/more/products/restricted', child: Text('Restricted categories')),
            ],
          ),
        ],
      ),
      body: (me?.hasNoZones ?? false)
          ? const Padding(padding: EdgeInsets.all(16), child: NoZonesNotice())
          : LayoutBuilder(builder: (context, box) {
              _wide = box.maxWidth >= productsWideBreakpoint;
              final list = Column(
                children: [
                  _searchRow(c, data?.items ?? const []),
                  _tabs(),
                  _activeFilters(),
                  Expanded(child: _list(value, eff)),
                ],
              );
              if (!_wide) return list;
              return Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(width: 420, child: list),
                  VerticalDivider(width: 1, color: c.line),
                  Expanded(
                    child: _selected == null
                        ? Center(child: Text('Pick a product to see it here.', style: TextStyle(color: c.muted)))
                        : ProductDetailBody(key: ValueKey(_selected), productId: _selected!),
                  ),
                ],
              );
            }),
    );
  }

  Widget _searchRow(AppColors c, List<ProductListItem> loaded) {
    // The server's lists (all shops and categories in scope) when they load;
    // what is on screen otherwise.
    final dir = ref.watch(vendorDirectoryProvider).value ?? const <VendorRef>[];
    final vendors = <String, VendorRef>{
      for (final p in loaded) p.vendor.id: p.vendor,
      for (final v in dir) v.id: v,
    }.values.toList()
      ..sort((a, b) => a.name.compareTo(b.name));
    final serverCats = ref.watch(productCategoriesProvider).value ?? const <CategoryRow>[];
    final cats = {
      for (final p in loaded) if (p.category != null) p.category!,
      for (final cat in serverCats) cat.name,
    }.toList()
      ..sort();
    final extra = [_filters.vendorId != null, _filters.category != null].where((b) => b).length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              key: const Key('products-search'),
              controller: _search,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(Icons.search),
                hintText: 'Dish name',
                filled: true,
                fillColor: c.surface,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(radiusBlock), borderSide: BorderSide(color: c.line)),
                enabledBorder:
                    OutlineInputBorder(borderRadius: BorderRadius.circular(radiusBlock), borderSide: BorderSide(color: c.line)),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Badge(
            isLabelVisible: extra > 0,
            label: Text('$extra'),
            backgroundColor: c.accent,
            textColor: c.onAccent,
            child: IconButton.outlined(
              key: const Key('products-filters'),
              tooltip: 'Filters',
              onPressed: () async {
                final next = await showProductFiltersSheet(context, current: _filters, vendors: vendors, categories: cats);
                if (next != null && mounted) _set(next.copyWith(q: _filters.q, zoneId: _filters.zoneId));
              },
              icon: const Icon(Icons.tune),
            ),
          ),
        ],
      ),
    );
  }

  Widget _tabs() {
    Widget tab(String key, String label, ProductQuick? q) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: Key('product-tab-$key'),
            label: Text(label),
            selected: _filters.quick == q,
            onSelected: (_) => _set(_filters.copyWith(quick: q)),
          ),
        );
    final n = _counts;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Row(
        children: [
          tab('all', 'All', null),
          tab('unavailable', 'Unavailable (${n.unavailable})', ProductQuick.unavailable),
          tab('out-of-stock', 'Out of stock (${n.outOfStock})', ProductQuick.outOfStock),
          tab('low-stock', 'Low stock (${n.lowStock})', ProductQuick.lowStock),
          tab('pending', 'Pending approval (${n.pendingApproval})', ProductQuick.pendingApproval),
          tab('flagged', 'Flagged (${n.openFlags})', ProductQuick.flagged),
          tab('hidden', 'Hidden (${n.hidden})', ProductQuick.hidden),
        ],
      ),
    );
  }

  Widget _activeFilters() {
    final f = _filters;
    final chips = <Widget>[
      if (f.vendorId != null)
        InputChip(
          key: const Key('product-chip-vendor'),
          label: Text(f.vendorName ?? 'Vendor'),
          onDeleted: () => _set(f.copyWith(vendorId: null, vendorName: null)),
          deleteButtonTooltipMessage: 'Remove',
        ),
      if (f.category != null)
        InputChip(
          key: const Key('product-chip-category'),
          label: Text(f.category!),
          onDeleted: () => _set(f.copyWith(category: null)),
          deleteButtonTooltipMessage: 'Remove',
        ),
    ];
    if (chips.isEmpty) return const SizedBox(height: 4);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 6),
      child: Row(children: [for (final c in chips) Padding(padding: const EdgeInsets.only(right: 8), child: c)]),
    );
  }

  Widget _list(AsyncValue<ProductList> value, ProductFilters eff) {
    final data = value.value;
    if (data == null) {
      if (value.hasError) {
        final e = value.error!;
        if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
        return ErrorRetry(error: e, onRetry: () => ref.invalidate(productListProvider(eff)));
      }
      return const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()));
    }
    Future<void> pull() => ref.read(productListProvider(eff).notifier).refresh();
    if (data.items.isEmpty) {
      return RefreshIndicator(
        onRefresh: pull,
        child: ListView(
          key: const Key('products-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            EmptyLine(_filters.narrowed ? 'No products match these filters.' : 'No products in your zones yet.'),
          ],
        ),
      );
    }
    final footer = data.hasMore || data.loadingMore || data.loadMoreFailed;
    return RefreshIndicator(
      onRefresh: pull,
      child: ListView.separated(
        key: const Key('products-list'),
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        itemCount: data.items.length + (footer ? 1 : 0),
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          if (i == data.items.length) {
            if (data.loadMoreFailed) {
              return Center(
                child: TextButton(
                  onPressed: () => ref.read(productListProvider(eff).notifier).loadMore(),
                  child: const Text("Couldn't load more — tap to retry"),
                ),
              );
            }
            return const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4))),
            );
          }
          final p = data.items[i];
          return ProductTile(product: p, selected: _wide && p.id == _selected, onTap: () => _open(p));
        },
      ),
    );
  }
}
