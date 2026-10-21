import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/products.dart';
import '../../state/products.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import '../vendors/vendor_tabs.dart' show InfoSection;
import 'product_tile.dart';

/// Product insights over a window (§12.3, §12.5, §12.6, §12.10): dishes that
/// keep going unavailable, price changes, top and slow sellers, sold out now.
class ProductInsightsScreen extends ConsumerWidget {
  const ProductInsightsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final range = ref.watch(insightsRangeProvider);
    final value = ref.watch(productInsightsProvider);
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Product insights'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(productInsightsProvider.future),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final d in const [7, 30, 90])
                  ChoiceChip(
                    key: Key('insights-$d'),
                    label: Text('$d days'),
                    selected: range.days == d,
                    onSelected: (_) => ref.read(insightsRangeProvider.notifier).set(InsightsRange.days(d)),
                  ),
                ChoiceChip(
                  key: const Key('insights-custom'),
                  label: Text(range.days == null
                      ? '${DateFormat('d MMM').format(range.from!)} – ${DateFormat('d MMM').format(range.to!)}'
                      : 'Custom'),
                  selected: range.days == null,
                  onSelected: (_) async {
                    final today = istToday();
                    final picked = await showDateRangePicker(
                      context: context,
                      firstDate: today.subtract(const Duration(days: 365)),
                      lastDate: today,
                    );
                    if (picked == null) return;
                    final problem = insightsRangeProblem(picked.start, picked.end);
                    if (problem != null) {
                      if (context.mounted) showSnack(context, problem);
                      return;
                    }
                    ref.read(insightsRangeProvider.notifier).set(InsightsRange.custom(picked.start, picked.end));
                  },
                ),
              ],
            ),
            value.when(
              skipLoadingOnRefresh: true,
              skipLoadingOnReload: true,
              loading: () => const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
              error: (e, _) => ErrorRetry(error: e, onRetry: () => ref.invalidate(productInsightsProvider)),
              data: (d) => _Sections(d: d),
            ),
          ],
        ),
      ),
    );
  }
}

class _Sections extends StatelessWidget {
  const _Sections({required this.d});
  final ProductInsights d;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    String pct(double? p) => p == null ? '' : '${p >= 0 ? '+' : ''}${p.toStringAsFixed(1)}%';
    Widget row(ProductListItem p, String right, {String? below}) => _Row(product: p, right: right, below: below);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InfoSection(title: 'Frequently unavailable', children: [
          if (d.frequentlyUnavailable.isEmpty) Text('Nothing stood out.', style: TextStyle(color: c.muted)),
          for (final r in d.frequentlyUnavailable)
            row(r.product, '${r.hoursUnavailable.toStringAsFixed(1)} h unavailable',
                below: '${r.timesUnavailable} time${r.timesUnavailable == 1 ? '' : 's'}'),
        ]),
        InfoSection(title: 'Price changes', children: [
          if (d.priceChanges.isEmpty) Text('No price changes.', style: TextStyle(color: c.muted)),
          for (final r in d.priceChanges)
            row(
              r.product,
              '${r.from == null ? '?' : rupees(r.from!)} → ${r.to == null ? '?' : rupees(r.to!)}',
              below: [pct(r.changePct), r.source.label, if (r.at != null) DateFormat('d MMM').format(r.at!.toLocal())]
                  .where((s) => s.isNotEmpty)
                  .join(' · '),
            ),
        ]),
        InfoSection(title: 'Top sellers', children: [
          if (d.topSellers.isEmpty) Text('No sales in this period.', style: TextStyle(color: c.muted)),
          for (final r in d.topSellers) row(r.product, '${count(r.units)} sold', below: rupees(r.revenue)),
        ]),
        InfoSection(title: 'Slow sellers', children: [
          if (d.slowSellers.isEmpty) Text('None.', style: TextStyle(color: c.muted)),
          for (final r in d.slowSellers) row(r.product, '${count(r.units)} sold', below: rupees(r.revenue)),
        ]),
        InfoSection(title: 'Sold out now', children: [
          if (d.outOfStock.isEmpty) Text('Nothing is sold out.', style: TextStyle(color: c.muted)),
          for (final p in d.outOfStock) row(p, p.stockWords),
        ]),
      ],
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.product, required this.right, this.below});
  final ProductListItem product;
  final String right;
  final String? below;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: () => GoRouter.maybeOf(context)?.push('/more/products/${product.id}'),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            ProductThumb(url: product.imageUrl, size: 40),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(product.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
                  Text(product.vendor.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: c.muted, fontSize: 12.5)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(right, style: dataStyle(context, size: 13, weight: FontWeight.w700)),
                if (below != null && below!.isNotEmpty) Text(below!, style: TextStyle(color: c.muted, fontSize: 12)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
