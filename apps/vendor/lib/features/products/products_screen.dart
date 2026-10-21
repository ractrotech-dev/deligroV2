import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/menu.dart';
import '../../state/menu.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

enum ProductFilter { all, lowStock, soldOut, scheduled }

enum ProductSort { menu, bestSelling, name, price }

/// Products & inventory (requirements §7): every item with its price,
/// availability, stock and sales; filters for low stock and sold out; best
/// sellers; category rename / merge; and the way into the item editor.
class ProductsScreen extends ConsumerStatefulWidget {
  const ProductsScreen({super.key, this.filter});

  /// `low_stock` opens on the low-stock filter (the dashboard links here).
  final String? filter;

  @override
  ConsumerState<ProductsScreen> createState() => _ProductsScreenState();
}

class _ProductsScreenState extends ConsumerState<ProductsScreen> {
  late ProductFilter _filter = widget.filter == 'low_stock' ? ProductFilter.lowStock : ProductFilter.all;
  ProductSort _sort = ProductSort.menu;
  String? _category;
  String _query = '';
  bool _searching = false;

  bool _matches(MenuItem i) {
    if (_category != null && i.category != _category) return false;
    if (_query.isNotEmpty && !i.name.toLowerCase().contains(_query.toLowerCase())) return false;
    return switch (_filter) {
      ProductFilter.all => true,
      ProductFilter.lowStock => i.lowStock || i.outOfStock,
      ProductFilter.soldOut => !i.available,
      ProductFilter.scheduled => i.scheduled,
    };
  }

  List<MenuItem> _sorted(List<MenuItem> items) {
    final list = [...items];
    switch (_sort) {
      case ProductSort.menu:
        break;
      case ProductSort.bestSelling:
        list.sort((a, b) => b.soldCount.compareTo(a.soldCount));
      case ProductSort.name:
        list.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      case ProductSort.price:
        list.sort((a, b) => a.fromPrice.compareTo(b.fromPrice));
    }
    return list;
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(menuProvider);
    final menu = async.value;
    return Scaffold(
      appBar: AppBar(
        title: _searching
            ? TextField(
                autofocus: true,
                decoration: InputDecoration(hintText: 'Search items', border: InputBorder.none),
                onChanged: (q) => setState(() => _query = q.trim()),
              )
            : Text('Products & stock'),
        actions: [
          IconButton(
            tooltip: 'Search',
            icon: Icon(_searching ? Icons.close_rounded : Icons.search_rounded),
            onPressed: () => setState(() {
              _searching = !_searching;
              if (!_searching) _query = '';
            }),
          ),
          if (menu != null)
            PopupMenuButton<String>(
              onSelected: (v) {
                if (v == 'reorder') context.push('/more/products/reorder');
                if (v.startsWith('sort:')) setState(() => _sort = ProductSort.values.byName(v.substring(5)));
              },
              itemBuilder: (_) => [
                for (final (s, en) in [
                  (ProductSort.menu, 'Menu order'),
                  (ProductSort.bestSelling, 'Best selling'),
                  (ProductSort.name, 'Name'),
                  (ProductSort.price, 'Price'),
                ])
                  CheckedPopupMenuItem(value: 'sort:${s.name}', checked: _sort == s, child: Text(en)),
                if (menu.canEdit) ...[
                  const PopupMenuDivider(),
                  PopupMenuItem(value: 'reorder', child: Text('Change menu order')),
                ],
              ],
            ),
        ],
      ),
      floatingActionButton: (menu?.canEdit ?? false)
          ? FloatingActionButton.extended(
              onPressed: () => context.push('/more/products/new'),
              icon: const Icon(Icons.add_rounded),
              label: Text('Add item'),
            )
          : null,
      body: switch (async) {
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.read(menuProvider.notifier).refresh(),
          child: _list(value),
        ),
        AsyncError(:final error) => LoadFailed(error: error, onRetry: () => ref.invalidate(menuProvider)),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }

  Widget _list(Menu menu) {
    final c = context.colors;
    final items = _sorted(menu.items.where(_matches).toList());
    final counts = {
      ProductFilter.all: menu.items.length,
      ProductFilter.lowStock: menu.lowStockCount,
      ProductFilter.soldOut: menu.items.where((i) => !i.available).length,
      ProductFilter.scheduled: menu.items.where((i) => i.scheduled).length,
    };
    final grouped = _sort == ProductSort.menu && _category == null;

    final rows = <Widget>[
      SizedBox(
        height: 52,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          children: [
            for (final (f, en) in [
              (ProductFilter.all, 'All'),
              if (menu.inventorySupported) (ProductFilter.lowStock, 'Low stock'),
              (ProductFilter.soldOut, 'Sold out'),
              if (menu.inventorySupported) (ProductFilter.scheduled, 'Scheduled'),
            ])
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  label: Text('$en · ${counts[f]}'),
                  selected: _filter == f,
                  onSelected: (_) => setState(() => _filter = f),
                ),
              ),
          ],
        ),
      ),
      if (menu.categories.length > 1)
        SizedBox(
          height: 48,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
            children: [
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: FilterChip(
                  label: Text('All categories'),
                  selected: _category == null,
                  onSelected: (_) => setState(() => _category = null),
                ),
              ),
              for (final cat in menu.categories)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: FilterChip(
                    label: Text(cat),
                    selected: _category == cat,
                    onSelected: (_) => setState(() => _category = _category == cat ? null : cat),
                  ),
                ),
            ],
          ),
        ),
      if (_sort == ProductSort.bestSelling && items.isNotEmpty) _Performance(items: items),
    ];

    if (items.isEmpty) {
      rows.add(
        Padding(
          padding: const EdgeInsets.all(40),
          child: Column(
            children: [
              Icon(Icons.inventory_2_outlined, size: 44, color: c.muted),
              const SizedBox(height: 12),
              Text(
                menu.items.isEmpty ? 'No items yet. Add your first dish.' : 'Nothing matches.',
                style: TextStyle(color: c.muted),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    } else if (grouped) {
      final byCat = <String, List<MenuItem>>{};
      for (final i in items) {
        byCat.putIfAbsent(i.category, () => []).add(i);
      }
      for (final cat in menu.categories.where(byCat.containsKey)) {
        rows.add(
          SectionHeading(
            '$cat · ${byCat[cat]!.length}',
            trailing: menu.canEdit
                ? IconButton(
                    tooltip: 'Rename category',
                    icon: const Icon(Icons.drive_file_rename_outline_rounded, size: 20),
                    onPressed: () => _renameCategory(menu, cat),
                  )
                : null,
          ),
        );
        for (final i in byCat[cat]!) {
          rows.add(ProductTile(item: i, canEdit: menu.canEdit, inventory: menu.inventorySupported));
        }
      }
    } else {
      rows.add(const SizedBox(height: 8));
      for (final (n, i) in items.indexed) {
        rows.add(
          ProductTile(
            item: i,
            canEdit: menu.canEdit,
            inventory: menu.inventorySupported,
            rank: _sort == ProductSort.bestSelling ? n + 1 : null,
          ),
        );
      }
    }
    rows.add(const SizedBox(height: 96));
    return ListView(children: rows);
  }

  Future<void> _renameCategory(Menu menu, String from) async {
    final ctrl = TextEditingController(text: from);
    final to = await showDialog<String>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Rename "$from"'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(controller: ctrl, autofocus: true, maxLength: 40),
            Text(
              'Use the name of another category to merge the two.',
              style: TextStyle(color: context.colors.muted, fontSize: 12.5),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(d, ctrl.text.trim()), child: Text('Save')),
        ],
      ),
    );
    if (to == null || to.isEmpty || to == from || !mounted) return;
    final merging = menu.categories.contains(to);
    final ok = await runWrite(
      context,
      ref,
      () => ref.read(menuRepoProvider).renameCategory(from, to),
      done: merging ? 'Merged into $to' : 'Renamed to $to',
    );
    if (ok) ref.read(menuProvider.notifier).refresh();
  }
}

/// The best sellers' share of units, over the list shown.
class _Performance extends ConsumerWidget {
  const _Performance({required this.items});

  final List<MenuItem> items;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final units = items.fold<int>(0, (s, i) => s + i.soldCount);
    final revenue = items.fold<int>(0, (s, i) => s + i.soldRevenue);
    final top = items.take(3).toList();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Panel(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: _Figure(label: 'Units sold', value: '$units'),
                ),
                Expanded(
                  child: _Figure(label: 'Item sales', value: rupees(revenue)),
                ),
              ],
            ),
            if (units > 0) ...[
              const SizedBox(height: 14),
              for (final i in top) ...[
                Row(
                  children: [
                    Expanded(child: Text(i.name, maxLines: 1, overflow: TextOverflow.ellipsis)),
                    Text(
                      '${(i.soldCount * 100 / units).round()}%',
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                ClipRRect(
                  borderRadius: BorderRadius.circular(99),
                  child: LinearProgressIndicator(
                    value: i.soldCount / units,
                    minHeight: 6,
                    backgroundColor: c.surface2,
                    color: c.accent,
                  ),
                ),
                const SizedBox(height: 10),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: TextStyle(color: context.colors.muted, fontSize: 12.5)),
      const SizedBox(height: 2),
      Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
    ],
  );
}

/// Veg / non-veg mark: a green or red dot in a square, as on packaging.
class VegMark extends StatelessWidget {
  const VegMark({super.key, required this.veg, this.size = 14});

  final bool veg;
  final double size;

  @override
  Widget build(BuildContext context) {
    final color = veg ? const Color(0xFF1E8E3E) : const Color(0xFFC5221F);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        border: Border.all(color: color, width: 1.5),
        borderRadius: BorderRadius.circular(3),
      ),
      alignment: Alignment.center,
      child: Container(
        width: size / 2.2,
        height: size / 2.2,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      ),
    );
  }
}

class ProductTile extends ConsumerWidget {
  const ProductTile({super.key, required this.item, required this.canEdit, required this.inventory, this.rank});

  final MenuItem item;
  final bool canEdit;
  final bool inventory;
  final int? rank;

  Future<void> _setAvailable(BuildContext context, WidgetRef ref, bool v) async {
    final ok = await runWrite(context, ref, () => ref.read(menuRepoProvider).update(item.id, {'available': v}));
    if (ok) ref.read(menuProvider.notifier).refresh();
  }

  Future<void> _setStock(BuildContext context, WidgetRef ref) async {
    final ctrl = TextEditingController(text: item.stockQty?.toString() ?? '');
    final value = await showDialog<String>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Stock for ${item.name}'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(labelText: 'Units left'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, ''), child: Text('Stop tracking')),
          FilledButton(onPressed: () => Navigator.pop(d, ctrl.text.trim()), child: Text('Save')),
        ],
      ),
    );
    if (value == null || !context.mounted) return;
    final qty = value.isEmpty ? null : int.tryParse(value);
    if (value.isNotEmpty && (qty == null || qty < 0)) return;
    final ok = await runWrite(
      context,
      ref,
      () => ref.read(menuRepoProvider).update(item.id, {'stockQty': qty}),
      done: 'Stock updated',
    );
    if (ok) ref.read(menuProvider.notifier).refresh();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final price = item.variants.isEmpty ? rupees(item.price) : 'from ${rupees(item.fromPrice)}';

    Widget? stockBadge;
    if (inventory && item.tracksStock) {
      final (bg, fg, text) = item.outOfStock
          ? (c.dealSoft, c.deal, 'Out of stock')
          : item.lowStock
          ? (c.dealSoft, c.deal, 'Low · ${item.stockQty} left')
          : (c.surface2, c.ink, '${item.stockQty} in stock');
      stockBadge = InkWell(
        onTap: canEdit ? () => _setStock(context, ref) : null,
        borderRadius: BorderRadius.circular(99),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
          child: Text(
            text,
            style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w700),
          ),
        ),
      );
    }

    return InkWell(
      onTap: () => context.push('/more/products/${item.id}'),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
        child: Row(
          children: [
            if (rank != null)
              SizedBox(
                width: 28,
                child: Text(
                  '$rank',
                  style: TextStyle(color: c.muted, fontWeight: FontWeight.w800),
                ),
              ),
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: SizedBox(
                width: 56,
                height: 56,
                child: item.imageUrl == null
                    ? ColoredBox(
                        color: c.surface2,
                        child: Icon(Icons.restaurant_rounded, color: c.muted),
                      )
                    : CachedNetworkImage(imageUrl: item.imageUrl!, fit: BoxFit.cover),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Opacity(
                opacity: item.available ? 1 : .55,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        VegMark(veg: item.veg),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            item.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text('$price · ${item.soldCount} sold', style: TextStyle(color: c.muted, fontSize: 13)),
                    if (stockBadge != null || item.scheduled || item.hasOptions) ...[
                      const SizedBox(height: 5),
                      Wrap(
                        spacing: 6,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          ?stockBadge,
                          if (item.scheduled) Icon(Icons.schedule_rounded, size: 16, color: c.muted),
                          if (item.hasOptions) Icon(Icons.tune_rounded, size: 16, color: c.muted),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
            Switch(value: item.available, onChanged: canEdit ? (v) => _setAvailable(context, ref, v) : null),
          ],
        ),
      ),
    );
  }
}
