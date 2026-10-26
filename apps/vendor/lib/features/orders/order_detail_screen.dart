import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../documents/order_documents.dart';
import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/order.dart';
import '../../state/orders.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/stage.dart';
import 'order_actions.dart';

/// Everything about one order (requirements §3) and the next step for it.
class OrderDetailScreen extends ConsumerStatefulWidget {
  const OrderDetailScreen({super.key, required this.orderId});
  final String orderId;

  @override
  ConsumerState<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends ConsumerState<OrderDetailScreen> {
  bool _busy = false;

  Future<void> _act(Future<void> Function() action, String done) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await action();
      messenger.showSnackBar(SnackBar(content: Text(done)));
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.friendly())));
    } catch (_) {
      messenger.showSnackBar(SnackBar(content: Text('Something went wrong. Try again.')));
    } finally {
      // Whatever happened, show the order as it now is — a 409 means another
      // phone or the website moved it.
      ref.invalidate(orderDetailProvider(widget.orderId));
      ref.read(boardProvider.notifier).refresh();
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _accept(VendorOrder o) async {
    final shopPrep = ref.read(vendorMeProvider).value?.activeShop.prepMinutes ?? 20;
    final minutes = await showAcceptSheet(context, defaultMinutes: o.prepMinutes ?? shopPrep);
    if (minutes == null || !mounted) return;
    await _act(() => ref.read(ordersRepoProvider).accept(o.id, prepMinutes: minutes), 'Order accepted');
  }

  Future<void> _reject(VendorOrder o) async {
    final reason = await showRejectSheet(context);
    if (reason == null || !mounted) return;
    await _act(() => ref.read(ordersRepoProvider).reject(o.id, reason), 'Order rejected');
  }

  @override
  Widget build(BuildContext context) {
    final detail = ref.watch(orderDetailProvider(widget.orderId));
    final o = detail.value;
    return Scaffold(
      appBar: AppBar(
        title: Text(o?.code ?? 'Order'),
        actions: [if (o != null) OrderDocumentsButton(order: o)],
      ),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(e is ApiException ? e.friendly() : 'Couldn\'t load this order.', textAlign: TextAlign.center),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () => ref.invalidate(orderDetailProvider(widget.orderId)),
                  child: Text('Retry'),
                ),
              ],
            ),
          ),
        ),
        data: (o) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(orderDetailProvider(widget.orderId)),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
            children: [
              _Header(order: o),
              if (o.stage == OrderStage.ready || o.status == 'on_the_way') _Pickup(order: o),
              _Customer(order: o),
              _Items(order: o),
              _Bill(order: o),
              if (o.stage == OrderStage.cancelled) _Cancelled(order: o),
              _Timeline(order: o),
            ],
          ),
        ),
      ),
      bottomNavigationBar: o == null
          ? null
          : _ActionBar(order: o, busy: _busy, onAccept: _accept, onReject: _reject),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child, this.trailing});
  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w800, letterSpacing: .3),
                ),
              ),
              ?trailing,
            ],
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }
}

class _Header extends ConsumerWidget {
  const _Header({required this.order});
  final VendorOrder order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final o = order;
    final due = o.dueAt;
    String? timing;
    Color? timingColor;
    if (due != null && (o.stage == OrderStage.accepted || o.stage == OrderStage.preparing)) {
      final left = due.difference(DateTime.now()).inMinutes;
      final at = DateFormat('h:mm a').format(due);
      if (left >= 0) {
        timing = 'Ready by $at · ${minutesText(left)} left';
        timingColor = c.green;
      } else {
        timing = 'Due at $at · ${minutesText(-left)} late';
        timingColor = c.deal;
      }
    }
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: stageColors(context, o.stage).bg,
        borderRadius: BorderRadius.circular(radiusBlock),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(stageIcon(o.stage), color: stageColors(context, o.stage).fg),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  o.status == 'on_the_way' ? 'Out for delivery' : stageLabel(ref, o.stage),
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: stageColors(context, o.stage).fg),
                ),
              ),
              PaymentChip(method: o.paymentMethod, status: o.paymentStatus),
            ],
          ),
          const SizedBox(height: 6),
          Text('Placed ${placedAt(o.createdAt)}', style: TextStyle(color: c.ink)),
          if (o.channel == 'phone')
            Text('Taken on the phone by Deligro', style: TextStyle(color: c.muted, fontSize: 13)),
          if (timing != null) ...[
            const SizedBox(height: 6),
            Text(
              timing,
              style: TextStyle(color: timingColor, fontWeight: FontWeight.w700),
            ),
          ],
        ],
      ),
    );
  }
}

class _Pickup extends ConsumerWidget {
  const _Pickup({required this.order});
  final VendorOrder order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final o = order;
    final rider = o.riderName == null
        ? 'Finding a rider…'
        : o.riderStage == 'picked_up'
        ? '${o.riderName} has picked it up'
        : '${o.riderName} is on the way to you';
    return _Section(
      title: 'PICKUP',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.two_wheeler_rounded, color: c.muted, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text(rider, style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Customer extends ConsumerWidget {
  const _Customer({required this.order});
  final VendorOrder order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final o = order;
    final phone = o.customerPhone;
    return _Section(
      title: 'DELIVER TO',
      trailing: phone == null
          ? null
          : TextButton.icon(
              onPressed: () => launchUrl(Uri(scheme: 'tel', path: phone)),
              icon: const Icon(Icons.call_rounded, size: 18),
              label: Text('Call'),
              style: TextButton.styleFrom(minimumSize: const Size(44, 36), visualDensity: VisualDensity.compact),
            ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(o.customerName, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text([o.area, ?o.deliveryLine].where((s) => s.isNotEmpty).join(' · '), style: TextStyle(color: c.muted)),
          const SizedBox(height: 6),
          Text(
            'A Deligro rider collects from your counter and delivers.',
            style: TextStyle(color: c.muted, fontSize: 12.5),
          ),
        ],
      ),
    );
  }
}

class _Items extends ConsumerWidget {
  const _Items({required this.order});
  final VendorOrder order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return _Section(
      title: 'ITEMS (${order.itemCount})',
      child: Column(
        children: [
          for (final l in order.lines)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 34,
                    child: Text('${l.qty}×', style: dataStyle(context, size: 14, weight: FontWeight.w800)),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(l.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                        if (l.addons.isNotEmpty)
                          Text(
                            '+ ${l.addons.join(', ')}',
                            style: TextStyle(color: c.accentInk, fontSize: 13, fontWeight: FontWeight.w700),
                          ),
                        Text('${rupees(l.price)} each', style: TextStyle(color: c.muted, fontSize: 12.5)),
                      ],
                    ),
                  ),
                  Text(rupees(l.amount), style: dataStyle(context, size: 14)),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Bill extends ConsumerWidget {
  const _Bill({required this.order});
  final VendorOrder order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final o = order;
    Widget line(String label, int amount, {bool minus = false, String? note, bool bold = false}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: TextStyle(fontWeight: bold ? FontWeight.w800 : FontWeight.w500)),
                if (note != null) Text(note, style: TextStyle(color: c.muted, fontSize: 12)),
              ],
            ),
          ),
          Text(
            minus ? '−${rupees(amount)}' : rupees(amount),
            style: dataStyle(context, size: bold ? 16 : 14, weight: bold ? FontWeight.w800 : FontWeight.w600),
          ),
        ],
      ),
    );
    final funder = switch (o.discountFundedBy) {
      'vendor' => 'Funded by you',
      'platform' => 'Funded by Deligro',
      _ => null,
    };
    return _Section(
      title: 'BILL',
      child: Column(
        children: [
          line('Items', o.itemsSubtotal),
          if (o.discount > 0)
            line(
              o.couponCode == null ? 'Discount' : 'Discount (${o.couponCode})',
              o.discount,
              minus: true,
              note: funder,
            ),
          if (o.deliveryFee > 0) line('Delivery fee', o.deliveryFee),
          if (o.taxAmount > 0) line('Taxes', o.taxAmount),
          if (o.tip > 0) line('Rider tip', o.tip),
          Divider(color: c.line, height: 16),
          line('Customer pays', o.total, bold: true),
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              o.isCod ? 'Cash on delivery — the rider collects it.' : 'Paid online to Deligro.',
              style: TextStyle(color: c.muted, fontSize: 12.5),
            ),
          ),
        ],
      ),
    );
  }
}

class _Cancelled extends ConsumerWidget {
  const _Cancelled({required this.order});
  final VendorOrder order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final reason = order.cancellationReason;
    return _Section(
      title: 'CANCELLATION',
      child: Text(
        reason == null || reason.isEmpty ? 'No reason was given.' : reason,
        style: TextStyle(color: context.colors.deal, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _Timeline extends ConsumerWidget {
  const _Timeline({required this.order});
  final VendorOrder order;

  String _what(WidgetRef ref, OrderEvent e) {
    if (e.kind == 'preparing') return 'Started preparing';
    return switch (e.to) {
      'placed' => 'Order placed',
      'kitchen' => 'Accepted',
      'ready' => 'Ready for pickup',
      'on_the_way' => 'Picked up by the rider',
      'delivered' => 'Delivered',
      'cancelled' => 'Cancelled',
      _ => e.to ?? '',
    };
  }

  String _who(WidgetRef ref, OrderEvent e) => switch (e.by) {
    'you' => 'by you',
    'customer' => 'by the customer',
    _ => 'by Deligro',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final events = order.events;
    if (events.isEmpty) return const SizedBox.shrink();
    return _Section(
      title: 'HISTORY',
      child: Column(
        children: [
          for (var i = 0; i < events.length; i++)
            IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Column(
                    children: [
                      Container(
                        width: 10,
                        height: 10,
                        margin: const EdgeInsets.only(top: 5),
                        decoration: BoxDecoration(
                          color: i == events.length - 1 ? c.accent : c.muted,
                          shape: BoxShape.circle,
                        ),
                      ),
                      if (i < events.length - 1) Expanded(child: Container(width: 2, color: c.line)),
                    ],
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${_what(ref, events[i])} ${events[i].kind == 'status' && events[i].to == 'placed' ? '' : _who(ref, events[i])}'
                                .trim(),
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          Text(placedAt(events[i].at), style: TextStyle(color: c.muted, fontSize: 12.5)),
                          if (events[i].reason != null && events[i].reason!.isNotEmpty)
                            Text('“${events[i].reason}”', style: TextStyle(color: c.muted, fontSize: 12.5)),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _ActionBar extends ConsumerWidget {
  const _ActionBar({
    required this.order,
    required this.busy,
    required this.onAccept,
    required this.onReject,
  });
  final VendorOrder order;
  final bool busy;
  final Future<void> Function(VendorOrder) onAccept;
  final Future<void> Function(VendorOrder) onReject;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final o = order;
    final canReject = ref.watch(vendorMeProvider).value?.can('vendor.reject_orders') ?? false;

    final List<Widget> buttons = switch (o.stage) {
      OrderStage.newOrder => [
        if (canReject)
          Expanded(
            child: OutlinedButton(
              onPressed: busy ? null : () => onReject(o),
              style: OutlinedButton.styleFrom(
                foregroundColor: c.deal,
                side: BorderSide(color: c.deal),
              ),
              child: Text('Reject'),
            ),
          ),
        if (canReject) const SizedBox(width: 10),
        Expanded(
          flex: 2,
          child: FilledButton.icon(
            onPressed: busy ? null : () => onAccept(o),
            icon: const Icon(Icons.check_rounded),
            label: Text('Accept'),
          ),
        ),
      ],
      _ => const [],
    };
    if (buttons.isEmpty) return const SizedBox.shrink();
    return SafeArea(
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
        decoration: BoxDecoration(
          color: c.bg,
          border: Border(top: BorderSide(color: c.line)),
        ),
        child: Row(children: buttons),
      ),
    );
  }
}
