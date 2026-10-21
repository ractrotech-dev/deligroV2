import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/order.dart';
import '../../models/tracking.dart';
import '../../state/cart.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/cart_widgets.dart';
import '../../widgets/common.dart';

// ---------------------------------------------------------------------------
// Order helpers shared by the orders, tracking and receipt screens.
// ---------------------------------------------------------------------------

/// `trackingSteps` in src/lib/utils/order-status.ts — each stage worded to be
/// true at the moment it lights up.
///
/// [riderArrived]: the rider tapped "Arrived" at the door, so the on-the-way
/// line is the same words as the push the customer just received.
List<({String title, String sub})> trackingSteps({
  String? restaurantName,
  String? riderName,
  bool riderArrived = false,
}) {
  final shop = restaurantName?.trim().isNotEmpty == true ? restaurantName : null;
  final rider = riderName?.trim().isNotEmpty == true ? riderName : null;
  return [
    (
      title: 'Order sent',
      sub: shop != null ? 'Waiting for $shop to accept' : 'Waiting for the restaurant to accept',
    ),
    (
      title: 'Accepted',
      sub: shop != null ? '$shop started cooking' : 'The kitchen started cooking',
    ),
    (title: 'Packed', sub: 'Waiting for a rider to collect it'),
    (
      title: 'On the way',
      sub: riderArrived
          ? 'Your rider has arrived'
          : rider != null
              ? '$rider is heading to you'
              : 'Heading to you',
    ),
    (title: 'Delivered', sub: 'Handed to you at the door'),
  ];
}

/// Who cancelled, and why (cancellationNote in order-map.ts). Null when the
/// cancellation can't be attributed — never guess whose fault it was.
({String who, String? reason})? cancellationNote(Order o) {
  final r = o.cancellationReason?.trim();
  final reason = r == null || r.isEmpty ? null : r;
  return switch (o.cancelledBy) {
    'customer' => (who: 'You cancelled this order', reason: reason),
    'vendor' => (who: 'The restaurant could not take this order', reason: reason),
    'manager' || 'admin' => (who: 'Cancelled by Deligro support', reason: reason),
    'system' => (who: 'Cancelled automatically', reason: reason),
    _ => reason == null ? null : (who: 'This order was cancelled', reason: reason),
  };
}

/// How the order was paid, as the receipt words it.
String paymentLabel(Order o) {
  if (o.paymentMethod != 'online') return 'Cash on delivery';
  return switch (o.paymentStatus) {
    'paid' => 'Paid online',
    'refunded' => 'Paid online · refunded',
    _ => 'Online payment',
  };
}

/// "2 × Paneer Tikka, 1 × Naan".
String orderItemsSummary(Order o) =>
    o.lines.map((l) => '${l.qty} × ${l.name}').join(', ');

/// Refills the basket from a past order after checking today's menu: closed
/// shop, sold-out dishes, price changes and a basket from another shop are
/// all confirmed before anything is replaced.
Future<void> reorderOrder(BuildContext context, WidgetRef ref, Order order) async {
  if (order.restaurantSlug.isEmpty) {
    showSnack(context, 'This restaurant is no longer available.');
    return;
  }
  final ({bool open, Map<String, ({int price, bool available})> items}) live;
  try {
    live = await ref.read(orderRepoProvider).menuPrices(order.restaurantSlug);
  } on ApiException catch (e) {
    if (context.mounted) showSnack(context, e.friendly);
    return;
  } catch (_) {
    if (context.mounted) showSnack(context, 'Couldn\'t check today\'s menu. Try again.');
    return;
  }
  if (!context.mounted) return;
  if (!live.open) {
    showSnack(context, '${order.restaurantName} is closed right now. Try again later.');
    return;
  }

  final removed = <String>[];
  final repriced = <({String name, int oldPrice, int newPrice})>[];
  for (final l in order.lines) {
    final now = live.items[l.itemId];
    // A customised dish (size / add-ons) is chosen again from the menu.
    if (l.itemId.isEmpty || l.customised || now == null || !now.available) {
      removed.add(l.customised ? '${l.name} (customised — add it again from the menu)' : l.name);
    } else if (now.price != l.price) {
      repriced.add((name: l.name, oldPrice: l.price, newPrice: now.price));
    }
  }

  if (removed.isNotEmpty || repriced.isNotEmpty) {
    final nothingLeft = removed.length == order.lines.length;
    final go = await showModalBottomSheet<bool>(
      context: context,
      builder: (ctx) => _ReorderReview(
        removed: removed,
        repriced: repriced,
        nothingLeft: nothingLeft,
      ),
    );
    if (go != true || !context.mounted) return;
  }

  final cart = ref.read(cartProvider);
  if (!cart.isEmpty && cart.slug != null && cart.slug != order.restaurantSlug) {
    final replace = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Start a new basket?'),
        content: Text(
          'Your basket has items from ${cart.restaurantName ?? 'another restaurant'}. '
          'Ordering this again will clear them.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep basket')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Start new')),
        ],
      ),
    );
    if (replace != true || !context.mounted) return;
  }

  ref.read(cartProvider.notifier).reorder(order, live.items);
  await showCartSheet(context);
}

class _ReorderReview extends StatelessWidget {
  const _ReorderReview({required this.removed, required this.repriced, required this.nothingLeft});
  final List<String> removed;
  final List<({String name, int oldPrice, int newPrice})> repriced;
  final bool nothingLeft;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final strong = TextStyle(color: c.ink, fontWeight: FontWeight.w700);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(color: c.dealSoft, shape: BoxShape.circle),
              child: Icon(Icons.warning_amber_rounded, color: c.deal, size: 28),
            ),
            const SizedBox(height: 12),
            Text('A few things changed',
                style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 19)),
            const SizedBox(height: 10),
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final name in removed)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 3),
                        child: Text.rich(
                          TextSpan(
                            style: TextStyle(color: c.muted, fontSize: 14, height: 1.45),
                            children: [
                              TextSpan(text: name, style: strong),
                              const TextSpan(text: ' isn\'t available right now — left out of your basket.'),
                            ],
                          ),
                        ),
                      ),
                    for (final r in repriced)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 3),
                        child: Text.rich(
                          TextSpan(
                            style: TextStyle(color: c.muted, fontSize: 14, height: 1.45),
                            children: [
                              TextSpan(text: r.name, style: strong),
                              const TextSpan(text: ' is now '),
                              TextSpan(text: rupees(r.newPrice), style: strong),
                              const TextSpan(text: ' '),
                              TextSpan(
                                text: rupees(r.oldPrice),
                                style: const TextStyle(decoration: TextDecoration.lineThrough),
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 18),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: nothingLeft ? null : () => Navigator.pop(context, true),
                    style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
                    child: Text(nothingLeft ? 'Nothing left' : 'Continue'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Green delivered, muted cancelled, accent while live.
class OrderStatusChip extends StatelessWidget {
  const OrderStatusChip(this.status, {super.key});
  final OrderStatus status;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (bg, fg) = switch (status) {
      OrderStatus.delivered => (c.greenSoft, c.green),
      OrderStatus.cancelled => (c.surface2, c.muted),
      _ => (c.accentSoft, c.accentInk),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(status.label,
          style: TextStyle(color: fg, fontSize: 11.5, fontWeight: FontWeight.w800)),
    );
  }
}

// ---------------------------------------------------------------------------
// Orders tab
// ---------------------------------------------------------------------------

/// The live card's arrival estimate — the same snapshot the tracking screen
/// polls, so the two never disagree. Null when it can't be read.
final _liveSnapshotProvider =
    FutureProvider.autoDispose.family<TrackingSnapshot?, String>((ref, id) async {
  try {
    return await ref.watch(orderRepoProvider).tracking(id);
  } catch (_) {
    return null;
  }
});

enum _Filter { all, delivered, cancelled }

/// Orders (app/(customer)/orders/page.tsx): what's happening now, then the
/// history with filters, month headings and "Load older orders".
class OrdersScreen extends ConsumerStatefulWidget {
  const OrdersScreen({super.key});

  @override
  ConsumerState<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends ConsumerState<OrdersScreen> {
  /// Slower than the tracking screen's 3s: this is a list people glance at.
  static const _refreshEvery = Duration(seconds: 10);

  Timer? _poll;
  final List<Order> _older = [];
  bool? _serverHasMore;
  bool _loadingOlder = false;
  String? _olderError;
  _Filter _filter = _Filter.all;

  @override
  void initState() {
    super.initState();
    ref.listenManual<AsyncValue<List<Order>>>(myOrdersProvider, (_, next) {
      final list = next.value;
      if (list != null) _syncPolling(list.any((o) => o.status.inFlight));
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  void _syncPolling(bool live) {
    if (live && _poll == null) {
      _poll = Timer.periodic(_refreshEvery, (_) {
        if (!mounted) return;
        ref.invalidate(myOrdersProvider);
        ref.invalidate(activeOrderProvider);
        ref.invalidate(_liveSnapshotProvider);
      });
    } else if (!live && _poll != null) {
      _poll!.cancel();
      _poll = null;
    }
  }

  Future<void> _refresh() async {
    ref.invalidate(myOrdersProvider);
    ref.invalidate(activeOrderProvider);
    ref.invalidate(_liveSnapshotProvider);
    try {
      await ref.read(myOrdersProvider.future);
    } catch (_) {
      // The error state renders itself.
    }
  }

  Future<void> _loadOlder(List<Order> past) async {
    final oldest = past.isEmpty ? null : past.last.createdAt;
    if (oldest == null || _loadingOlder) return;
    setState(() {
      _loadingOlder = true;
      _olderError = null;
    });
    try {
      final page = await ref.read(orderRepoProvider).history(before: oldest);
      if (!mounted) return;
      setState(() {
        _older.addAll(page.orders);
        _serverHasMore = page.hasMore;
      });
    } catch (_) {
      if (mounted) setState(() => _olderError = 'Couldn\'t load older orders. Try again.');
    } finally {
      if (mounted) setState(() => _loadingOlder = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(myOrdersProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Orders')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: async.when(
          skipLoadingOnRefresh: true,
          skipLoadingOnReload: true,
          loading: () => const _OrdersSkeleton(),
          error: (e, _) => _scrollable(
            EmptyState(
              icon: Icons.report_problem_outlined,
              title: 'Couldn\'t load your orders',
              body: 'This is a problem on our side, not a sign that anything is missing. '
                  'Your orders are safe — try again in a moment.',
              action: 'Try again',
              onAction: _refresh,
            ),
          ),
          data: (orders) => _buildList(context, orders),
        ),
      ),
    );
  }

  Widget _scrollable(Widget child) => LayoutBuilder(
        builder: (context, box) => SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: box.maxHeight),
            child: child,
          ),
        ),
      );

  Widget _buildList(BuildContext context, List<Order> orders) {
    final c = context.colors;
    final active = orders.where((o) => o.status.inFlight).toList();
    final seen = <String>{};
    final past = <Order>[
      for (final o in [...orders.where((o) => !o.status.inFlight), ..._older])
        if (!o.status.inFlight && seen.add(o.id)) o,
    ]..sort((a, b) => (b.createdAt ?? DateTime(0)).compareTo(a.createdAt ?? DateTime(0)));

    if (active.isEmpty && past.isEmpty) {
      return _scrollable(
        EmptyState(
          icon: Icons.receipt_long_rounded,
          title: 'No orders yet',
          body: 'Your orders will appear here — track live and reorder in a tap.',
          action: 'Find something to eat',
          onAction: () => context.go('/'),
        ),
      );
    }

    final delivered = past.where((o) => o.status == OrderStatus.delivered).length;
    final cancelled = past.length - delivered;
    final shown = past.where((o) => switch (_filter) {
          _Filter.all => true,
          _Filter.delivered => o.status == OrderStatus.delivered,
          _Filter.cancelled => o.status == OrderStatus.cancelled,
        });

    // The first read is capped at 30 rows; until a page says otherwise, a
    // full first read means there may be older orders.
    final hasMore = _serverHasMore ?? orders.length >= 30;

    final children = <Widget>[
      if (active.isNotEmpty) ...[
        _SectionLabel('Happening now', live: true),
        for (final o in active)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _LiveOrderCard(order: o),
          ),
        const SizedBox(height: 8),
      ],
      if (past.isNotEmpty) ...[
        _SectionLabel('Past orders'),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final (f, label, n) in [
                (_Filter.all, 'All', past.length),
                (_Filter.delivered, 'Delivered', delivered),
                (_Filter.cancelled, 'Cancelled', cancelled),
              ])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text('$label  $n'),
                    selected: _filter == f,
                    showCheckmark: false,
                    onSelected: (_) => setState(() => _filter = f),
                  ),
                ),
            ],
          ),
        ),
        if (shown.isEmpty)
          Container(
            margin: const EdgeInsets.only(top: 16),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 28),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(radiusBlock),
              border: Border.all(color: c.line),
            ),
            child: Column(
              children: [
                const Text('Nothing matches', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                const SizedBox(height: 4),
                Text('No orders with this status yet.', style: TextStyle(color: c.muted, fontSize: 13)),
                const SizedBox(height: 10),
                OutlinedButton(
                  onPressed: () => setState(() => _filter = _Filter.all),
                  child: const Text('Show all orders'),
                ),
              ],
            ),
          )
        else
          ..._grouped(context, shown.toList()),
        if (hasMore)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Column(
              children: [
                OutlinedButton.icon(
                  onPressed: _loadingOlder ? null : () => _loadOlder(past),
                  icon: _loadingOlder
                      ? const SizedBox(
                          width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.history_rounded, size: 18),
                  label: Text(_loadingOlder ? 'Loading…' : 'Load older orders'),
                ),
                if (_olderError != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(_olderError!,
                        style: TextStyle(color: c.deal, fontSize: 12, fontWeight: FontWeight.w600)),
                  ),
              ],
            ),
          ),
      ],
    ];

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
      children: children,
    );
  }

  /// Month headings break up a long run of near-identical rows.
  List<Widget> _grouped(BuildContext context, List<Order> list) {
    final now = DateTime.now();
    String key(Order o) {
      final d = o.createdAt?.toLocal();
      if (d == null) return 'Earlier';
      if (d.year == now.year && d.month == now.month) return 'This month';
      return DateFormat(d.year == now.year ? 'MMMM' : 'MMMM y').format(d);
    }

    final out = <Widget>[];
    String? current;
    for (final o in list) {
      final k = key(o);
      if (k != current) {
        current = k;
        out.add(Padding(
          padding: const EdgeInsets.only(top: 18, bottom: 2),
          child: Text(k.toUpperCase(), style: Theme.of(context).textTheme.labelSmall),
        ));
      } else {
        out.add(const Divider(height: 1));
      }
      out.add(_OrderRow(order: o));
    }
    return out;
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text, {this.live = false});
  final String text;
  final bool live;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 10),
      child: Row(
        children: [
          if (live) ...[
            Container(width: 7, height: 7, decoration: BoxDecoration(color: c.green, shape: BoxShape.circle)),
            const SizedBox(width: 7),
          ],
          Text(text.toUpperCase(),
              style: TextStyle(
                  fontSize: 12.5, fontWeight: FontWeight.w800, letterSpacing: .8, color: c.muted)),
        ],
      ),
    );
  }
}

/// The order that's actually happening, headlined by when it arrives.
class _LiveOrderCard extends ConsumerWidget {
  const _LiveOrderCard({required this.order});
  final Order order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final snap = ref.watch(_liveSnapshotProvider(order.id)).value;
    final status = snap?.status ?? order.status;
    final steps = trackingSteps(
      restaurantName: order.restaurantName,
      riderName: snap?.rider?.name,
      riderArrived: snap?.riderArrived == true && status == OrderStatus.onTheWay,
    );
    final step = steps[status.step.clamp(0, steps.length - 1)];
    final eta = snap?.eta;

    // Far past its promise, a countdown is fiction — say what we know.
    final stuck = eta != null && eta.late && eta.lateByMinutes >= 180;
    final String caption, headline;
    if (stuck) {
      caption = 'We\'re looking into this order';
      headline = 'Delayed';
    } else if (eta?.minutesRemaining != null) {
      caption = 'Estimated arrival';
      headline = eta!.minutesRemaining! > 0 ? '${eta.minutesRemaining} min' : 'Arriving now';
    } else {
      caption = 'Tracking live';
      headline = status.label;
    }

    return Material(
      color: c.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: c.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => context.push('/orders/${order.id}'),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  SizedBox(
                    width: 44,
                    height: 44,
                    child: NetImage(url: order.restaurantImage, tint: order.restaurantAccent, radius: 12),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(order.restaurantName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                        const SizedBox(height: 2),
                        Text('${order.shortId} · ${rupees(order.total)}',
                            style: dataStyle(context, size: 11.5, weight: FontWeight.w700)
                                .copyWith(color: c.muted, letterSpacing: 1)),
                      ],
                    ),
                  ),
                  Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
                    child: Icon(Icons.chevron_right_rounded, color: c.onAccent),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(caption, style: TextStyle(color: c.muted, fontSize: 12)),
                        const SizedBox(height: 2),
                        Text(headline,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 28, fontWeight: FontWeight.w800, letterSpacing: -0.8, height: 1.1)),
                      ],
                    ),
                  ),
                  if (eta != null && eta.late && !stuck)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                      decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(999)),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.schedule_rounded, size: 13, color: c.deal),
                          const SizedBox(width: 4),
                          Text(lateness(eta.lateByMinutes),
                              style: TextStyle(color: c.deal, fontSize: 11, fontWeight: FontWeight.w800)),
                        ],
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  for (var i = 0; i < 4; i++) ...[
                    if (i > 0) const SizedBox(width: 4),
                    Expanded(
                      child: Container(
                        height: 4,
                        decoration: BoxDecoration(
                          color: i <= status.step ? c.green : c.line,
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 10),
              Text.rich(
                TextSpan(
                  text: step.title,
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
                  children: [
                    TextSpan(
                      text: ' — ${step.sub}',
                      style: TextStyle(color: c.muted, fontWeight: FontWeight.w400),
                    ),
                  ],
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One finished order: what, when, what it cost, and "order again".
class _OrderRow extends ConsumerStatefulWidget {
  const _OrderRow({required this.order});
  final Order order;

  @override
  ConsumerState<_OrderRow> createState() => _OrderRowState();
}

class _OrderRowState extends ConsumerState<_OrderRow> {
  bool _busy = false;

  Future<void> _again() async {
    setState(() => _busy = true);
    try {
      await reorderOrder(context, ref, widget.order);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.order;
    final c = context.colors;
    final cancelled = o.status == OrderStatus.cancelled;
    final why = cancelled ? cancellationNote(o) : null;
    final owesRefund = cancelled && o.paymentStatus == 'paid';
    final items = orderItemsSummary(o);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => context.push('/orders/${o.id}'),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 48,
                      height: 48,
                      child: NetImage(url: o.restaurantImage, tint: o.restaurantAccent, radius: 12),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(
                                child: Text(o.restaurantName,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                              ),
                              const SizedBox(width: 8),
                              Text(rupees(o.total), style: dataStyle(context, weight: FontWeight.w700)),
                            ],
                          ),
                          if (items.isNotEmpty) ...[
                            const SizedBox(height: 2),
                            Text(items,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 13, color: c.ink.withValues(alpha: .75))),
                          ],
                          const SizedBox(height: 6),
                          Wrap(
                            spacing: 8,
                            runSpacing: 4,
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: [
                              OrderStatusChip(o.status),
                              Text(placedAt(o.createdAt), style: TextStyle(fontSize: 12, color: c.muted)),
                              if (owesRefund)
                                Text('Refund not issued',
                                    style: TextStyle(
                                        fontSize: 12, color: c.popInk, fontWeight: FontWeight.w700)),
                            ],
                          ),
                          if (why != null) ...[
                            const SizedBox(height: 4),
                            Text(why.reason != null ? '“${why.reason}”' : why.who,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 12, color: c.muted)),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          OutlinedButton.icon(
            onPressed: _busy ? null : _again,
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(44, 44),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              shape: const StadiumBorder(),
              textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800),
            ),
            icon: _busy
                ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.replay_rounded, size: 16),
            label: const Text('Again'),
          ),
        ],
      ),
    );
  }
}

class _OrdersSkeleton extends StatelessWidget {
  const _OrdersSkeleton();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget box(double h, {double? w, double r = 10}) => Container(
          height: h,
          width: w,
          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(r)),
        );
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: [
        box(150, r: 18),
        const SizedBox(height: 24),
        for (var i = 0; i < 5; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 18),
            child: Row(
              children: [
                box(48, w: 48, r: 12),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [box(14, w: 160), const SizedBox(height: 8), box(12, w: 220)],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
