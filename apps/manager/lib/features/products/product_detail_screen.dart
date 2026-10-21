import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/outcome.dart';
import '../../models/products.dart';
import '../../state/products.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';
import '../vendors/vendor_tabs.dart' show FactRow, Figure, InfoSection;
import 'product_history.dart';
import 'product_tile.dart';
import 'stock_dialog.dart';

/// One listing (§12.2–12.10): price and availability, what changed and who
/// changed it, flags, 30 days of sales, and the moderation this manager may
/// do on it.
class ProductDetailScreen extends ConsumerWidget {
  const ProductDetailScreen({super.key, required this.productId});
  final String productId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(productDetailProvider(productId)).value?.name;
    return Scaffold(
      backgroundColor: context.colors.bg,
      appBar: AppBar(title: Text(name ?? 'Product'), backgroundColor: context.colors.bg),
      body: ProductDetailBody(productId: productId),
    );
  }
}

class ProductDetailBody extends ConsumerWidget {
  const ProductDetailBody({super.key, required this.productId});
  final String productId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => AsyncView(
        value: ref.watch(productDetailProvider(productId)),
        onRetry: () => ref.invalidate(productDetailProvider(productId)),
        builder: (p) => RefreshIndicator(
          onRefresh: () => ref.read(productDetailProvider(productId).notifier).refresh(),
          child: SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            child: _Detail(product: p),
          ),
        ),
      );
}

abstract final class ProductPicks {
  static const hide = ['Wrong photo', 'Inaccurate description', 'Inappropriate content'];
  static const unhide = ['Fixed by the vendor', 'Flag was a mistake'];
  static const approve = ['Price checked', 'Listing looks right'];
  static const reject = ['Price too high', 'Not allowed on Deligro', 'Inaccurate listing'];
  static const resolveFlag = ['Vendor fixed it', 'Listing corrected by Deligro'];
  static const dismissFlag = ['Listing is correct', 'Duplicate flag'];
}

String productRefusalText(Refused<Object?> r, ProductAction a) => switch (r.code) {
      'invalid_transition' when a is ApproveListing || a is RejectListing =>
        'This listing is no longer waiting for approval.',
      'invalid_transition' => "That change doesn't apply to this listing any more.",
      'stale' => 'Someone else changed this listing. Showing the latest.',
      'reason_required' => 'Please give a reason of at least 3 characters.',
      'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
      'not_found' => "This listing isn't in your zones.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      _ => "That didn't go through (${r.code}).",
    };

/// Sends [a]; a fault offers Retry (same action, same id), a refusal is
/// explained. Shared by every product action.
Future<void> sendProductAction(BuildContext context, WidgetRef ref, String productId, ProductAction a,
    {required String doneText}) async {
  final Outcome<ProductDetail> out;
  try {
    out = await ref.read(productDetailProvider(productId).notifier).act(a);
  } on ApiException catch (e) {
    if (e.unauthorized) {
      await handleUnauthorized(ref, e);
      return;
    }
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text(e.friendly),
        action: SnackBarAction(
          label: 'Retry',
          onPressed: () => sendProductAction(context, ref, productId, a, doneText: doneText),
        ),
      ));
    return;
  }
  if (!context.mounted) return;
  showSnack(context, out is Refused<ProductDetail> ? productRefusalText(out, a) : doneText);
}

class _Detail extends ConsumerWidget {
  const _Detail({required this.product});
  final ProductDetail product;

  Future<void> _withReason(
    BuildContext context,
    WidgetRef ref, {
    required String title,
    required List<String> picks,
    required ProductAction Function(String reason) build,
    required String done,
    String? message,
  }) async {
    final reason = await showReasonDialog(context, title: title, quickPicks: picks, message: message);
    if (reason == null || !context.mounted) return;
    await sendProductAction(context, ref, product.id, build(reason), doneText: done);
  }

  Future<void> _flag(BuildContext context, WidgetRef ref) async {
    final why = await pickOne<FlagReason>(
      context,
      title: "What's wrong with this listing?",
      options: [for (final r in FlagReason.pickable) (r, r.label, null)],
    );
    if (why == null || !context.mounted) return;
    await _withReason(
      context,
      ref,
      title: 'Flag: ${why.label}',
      picks: const [],
      message: 'Describe what is wrong so whoever reviews it can fix it.',
      build: (note) => FlagListing(flagReason: why, reason: note),
      done: 'Listing flagged.',
    );
  }

  Future<void> _stock(BuildContext context, WidgetRef ref) async {
    final a = await showStockDialog(context, product.item);
    if (a == null || !context.mounted) return;
    await sendProductAction(context, ref, product.id, a, doneText: a.stockQty == null ? 'Stock no longer tracked.' : 'Stock set to ${a.stockQty}.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final p = product;
    final i = p.item;
    final al = p.allowed;
    final me = ref.watch(managerMeProvider).value;
    final moderator = me?.can('manager.products.moderate') ?? false;
    final (avail, availColor) = availabilityWords(c, i);
    final day = DateFormat('d MMM');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ProductThumb(url: i.imageUrl, size: 84, veg: i.veg),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(i.name, style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: c.ink)),
                  const SizedBox(height: 4),
                  InkWell(
                    onTap: () => context.push('/more/vendors/${i.vendor.id}'),
                    child: Text(i.vendor.name,
                        style: TextStyle(color: c.accent, fontWeight: FontWeight.w600, decoration: TextDecoration.underline)),
                  ),
                  if (i.category != null) Text(i.category!, style: TextStyle(color: c.muted, fontSize: 12.5)),
                  const SizedBox(height: 6),
                  StatusText(avail, color: availColor),
                ],
              ),
            ),
          ],
        ),
        if (p.description != null) ...[
          const SizedBox(height: 12),
          Text(p.description!, style: TextStyle(color: c.ink, height: 1.4)),
        ],
        if (p.hiddenReason != null) _notice(c, 'Hidden by Deligro: ${p.hiddenReason}', c.deal, c.dealSoft),
        if (i.approvalStatus == ApprovalStatus.pending)
          _notice(c, p.approvalNote ?? 'Waiting for approval.', c.ink, c.pop.withValues(alpha: 0.18)),
        if (i.approvalStatus == ApprovalStatus.rejected)
          _notice(c, p.approvalNote ?? 'Rejected by Deligro.', c.deal, c.dealSoft),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (al.approve)
              FilledButton(
                key: const Key('product-action-approve'),
                onPressed: () => _withReason(context, ref,
                    title: i.pendingPrice == null ? 'Approve this listing?' : 'Approve ${rupees(i.pendingPrice!)}?',
                    picks: ProductPicks.approve,
                    build: (r) => ApproveListing(reason: r),
                    done: 'Listing approved.'),
                child: const Text('Approve'),
              ),
            if (al.reject)
              OutlinedButton(
                key: const Key('product-action-reject'),
                style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                onPressed: () => _withReason(context, ref,
                    title: 'Reject this change?',
                    picks: ProductPicks.reject,
                    build: (r) => RejectListing(reason: r),
                    done: 'Change rejected. The vendor has been told.'),
                child: const Text('Reject'),
              ),
            if (al.flag)
              OutlinedButton.icon(
                key: const Key('product-action-flag'),
                onPressed: () => _flag(context, ref),
                icon: const Icon(Icons.flag_outlined, size: 18),
                label: const Text('Flag'),
              ),
            if (al.hide)
              OutlinedButton.icon(
                key: const Key('product-action-hide'),
                style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                onPressed: () => _withReason(context, ref,
                    title: 'Hide from customers?',
                    picks: ProductPicks.hide,
                    message: 'Customers stop seeing and ordering it. The vendor sees why.',
                    build: (r) => HideListing(reason: r),
                    done: 'Listing hidden.'),
                icon: const Icon(Icons.visibility_off_outlined, size: 18),
                label: const Text('Hide'),
              ),
            if (al.unhide)
              OutlinedButton.icon(
                key: const Key('product-action-unhide'),
                onPressed: () => _withReason(context, ref,
                    title: 'Show to customers again?',
                    picks: ProductPicks.unhide,
                    build: (r) => UnhideListing(reason: r),
                    done: 'Listing visible again.'),
                icon: const Icon(Icons.visibility_outlined, size: 18),
                label: const Text('Unhide'),
              ),
            if (al.adjustStock)
              OutlinedButton.icon(
                key: const Key('product-action-stock'),
                onPressed: () => _stock(context, ref),
                icon: const Icon(Icons.inventory_2_outlined, size: 18),
                label: const Text('Adjust stock'),
              ),
          ],
        ),
        InfoSection(title: 'Price and stock', children: [
          FactRow('Price', rupees(i.price), mono: true),
          if (i.discountPrice != null) FactRow('Offer price', rupees(i.discountPrice!), mono: true),
          if (i.pendingPrice != null) FactRow('Waiting for approval', rupees(i.pendingPrice!), mono: true),
          FactRow('Stock', i.stockWords, mono: i.stockTracked),
          if (i.lowStockAt != null) FactRow('Low stock below', '${i.lowStockAt}', mono: true),
          FactRow('Unavailable (30 days)',
              '${p.timesUnavailable} time${p.timesUnavailable == 1 ? '' : 's'} · ${p.hoursUnavailable.toStringAsFixed(1)} h'),
        ]),
        if (p.variants.isNotEmpty || p.addonGroups.isNotEmpty)
          InfoSection(title: 'Options', children: [
            for (final v in p.variants) FactRow(v.name, rupees(v.price), mono: true),
            for (final g in p.addonGroups) ...[
              Padding(
                padding: const EdgeInsets.only(top: 6, bottom: 2),
                child: Text(g.name, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
              ),
              for (final a in g.addons) FactRow('  ${a.name}', '+${rupees(a.price)}', mono: true),
            ],
          ]),
        InfoSection(title: 'Sales, last 30 days', children: [
          Wrap(
            spacing: 24,
            runSpacing: 12,
            children: [
              Figure(count(p.sales.units), 'Sold'),
              Figure(rupees(p.sales.revenue), 'Revenue'),
              Figure(count(p.sales.orders), 'Orders'),
              if (p.sales.rankInVendor != null) Figure('#${p.sales.rankInVendor}', 'In the shop'),
            ],
          ),
          if (p.sales.daily.isNotEmpty) ...[
            const SizedBox(height: 12),
            SizedBox(height: 140, child: _DailyBars(daily: p.sales.daily)),
          ],
        ]),
        InfoSection(title: 'Flags', children: [
          if (p.flags.isEmpty) Text('No flags.', style: TextStyle(color: c.muted)),
          for (final f in p.flags)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(child: Text(f.reason.label, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink))),
                      StatusText(f.status.label, color: f.status == FlagStatus.open ? c.deal : c.muted),
                    ],
                  ),
                  if (f.note != null) Text(f.note!, style: TextStyle(color: c.ink, fontSize: 13)),
                  Text(
                    [if (f.raisedByName != null) 'by ${f.raisedByName}', if (f.raisedAt != null) day.format(f.raisedAt!.toLocal())]
                        .join(' · '),
                    style: TextStyle(color: c.muted, fontSize: 12),
                  ),
                  if (f.resolution != null)
                    Text('${f.status.label}: ${f.resolution}${f.resolvedByName == null ? '' : ' (${f.resolvedByName})'}',
                        style: TextStyle(color: c.muted, fontSize: 12)),
                  if (f.status == FlagStatus.open && moderator)
                    Wrap(
                      spacing: 8,
                      children: [
                        TextButton(
                          key: Key('flag-resolve-${f.id}'),
                          onPressed: () => _withReason(context, ref,
                              title: 'Resolve this flag?',
                              picks: ProductPicks.resolveFlag,
                              build: (r) => ResolveFlag(flagId: f.id, reason: r),
                              done: 'Flag resolved.'),
                          child: const Text('Resolve'),
                        ),
                        TextButton(
                          key: Key('flag-dismiss-${f.id}'),
                          onPressed: () => _withReason(context, ref,
                              title: 'Dismiss this flag?',
                              picks: ProductPicks.dismissFlag,
                              build: (r) => DismissFlag(flagId: f.id, reason: r),
                              done: 'Flag dismissed.'),
                          child: const Text('Dismiss'),
                        ),
                      ],
                    ),
                ],
              ),
            ),
        ]),
        InfoSection(title: 'History', children: [ProductHistory(changes: p.changes)]),
      ],
    );
  }

  Widget _notice(AppColors c, String text, Color fg, Color bg) => Container(
        margin: const EdgeInsets.only(top: 10),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10)),
        child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w600)),
      );
}

class _DailyBars extends StatelessWidget {
  const _DailyBars({required this.daily});
  final List<DailyUnits> daily;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final maxY = daily.fold<int>(0, (m, d) => d.units > m ? d.units : m);
    return BarChart(
      BarChartData(
        maxY: (maxY == 0 ? 1 : maxY) * 1.2,
        gridData: const FlGridData(show: false),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          leftTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 20,
              getTitlesWidget: (v, _) {
                final i = v.toInt();
                if (i < 0 || i >= daily.length || (daily.length > 10 && i % 5 != 0)) return const SizedBox.shrink();
                final d = DateTime.tryParse(daily[i].date);
                return Text(d == null ? '' : DateFormat('d MMM').format(d), style: TextStyle(fontSize: 10, color: c.muted));
              },
            ),
          ),
        ),
        barGroups: [
          for (var i = 0; i < daily.length; i++)
            BarChartGroupData(x: i, barRods: [
              BarChartRodData(toY: daily[i].units.toDouble(), color: c.accent, width: daily.length > 20 ? 5 : 10, borderRadius: BorderRadius.circular(2)),
            ]),
        ],
      ),
    );
  }
}
