import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/i18n.dart';
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

  Future<void> _act(Future<void> Function() action, String doneEn, String doneHi) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await action();
      messenger.showSnackBar(SnackBar(content: Text(trNow(ref, doneEn, doneHi))));
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.friendly(hi: isHindi(ref)))));
    } catch (_) {
      messenger.showSnackBar(SnackBar(content: Text(trNow(ref, 'Something went wrong. Try again.', 'कुछ गड़बड़ हुई। फिर कोशिश करें।'))));
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
    await _act(() => ref.read(ordersRepoProvider).accept(o.id, prepMinutes: minutes),
        'Order accepted', 'ऑर्डर स्वीकार हुआ');
  }

  Future<void> _reject(VendorOrder o) async {
    final reason = await showRejectSheet(context);
    if (reason == null || !mounted) return;
    await _act(() => ref.read(ordersRepoProvider).reject(o.id, reason), 'Order rejected', 'ऑर्डर मना किया');
  }

  @override
  Widget build(BuildContext context) {
    final detail = ref.watch(orderDetailProvider(widget.orderId));
    final o = detail.value;
    return Scaffold(
      appBar: AppBar(title: Text(o?.code ?? tr(ref, 'Order', 'ऑर्डर'))),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(e is ApiException ? e.friendly(hi: isHindi(ref)) : tr(ref, 'Couldn\'t load this order.', 'यह ऑर्डर लोड नहीं हुआ।'),
                    textAlign: TextAlign.center),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () => ref.invalidate(orderDetailProvider(widget.orderId)),
                  child: Text(tr(ref, 'Retry', 'फिर कोशिश करें')),
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
      bottomNavigationBar: o == null ? null : _ActionBar(order: o, busy: _busy, onAccept: _accept, onReject: _reject, act: _act),
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
                child: Text(title,
                    style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w800, letterSpacing: .3)),
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
        timing = tr(ref, 'Ready by $at · ${minutesText(left)} left', '$at तक तैयार · ${minutesText(left, hi: true)} बाकी');
        timingColor = c.green;
      } else {
        timing = tr(ref, 'Due at $at · ${minutesText(-left)} late', '$at तक देना था · ${minutesText(-left, hi: true)} देर');
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
                  o.status == 'on_the_way' ? tr(ref, 'Out for delivery', 'डिलीवरी पर') : stageLabel(ref, o.stage),
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: stageColors(context, o.stage).fg),
                ),
              ),
              PaymentChip(method: o.paymentMethod, status: o.paymentStatus),
            ],
          ),
          const SizedBox(height: 6),
          Text(tr(ref, 'Placed ${placedAt(o.createdAt)}', '${placedAt(o.createdAt, hi: true)} को आया'),
              style: TextStyle(color: c.ink)),
          if (o.channel == 'phone')
            Text(tr(ref, 'Taken on the phone by Deligro', 'Deligro ने फ़ोन पर लिया'), style: TextStyle(color: c.muted, fontSize: 13)),
          if (timing != null) ...[
            const SizedBox(height: 6),
            Text(timing, style: TextStyle(color: timingColor, fontWeight: FontWeight.w700)),
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
        ? tr(ref, 'Finding a rider…', 'राइडर ढूँढ रहे हैं…')
        : o.riderStage == 'picked_up'
            ? tr(ref, '${o.riderName} has picked it up', '${o.riderName} ने ऑर्डर ले लिया')
            : tr(ref, '${o.riderName} is on the way to you', '${o.riderName} आपकी ओर आ रहे हैं');
    return _Section(
      title: tr(ref, 'PICKUP', 'पिकअप'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (o.pickupOtp != null && o.status == 'ready') ...[
            Text(tr(ref, 'Give the bag only to the rider who tells you this code', 'बैग सिर्फ़ उसी राइडर को दें जो यह कोड बताए'),
                style: TextStyle(color: c.muted, fontSize: 13)),
            const SizedBox(height: 6),
            Text(o.pickupOtp!, style: dataStyle(context, size: 30, weight: FontWeight.w800)),
            const SizedBox(height: 8),
          ],
          Row(
            children: [
              Icon(Icons.two_wheeler_rounded, color: c.muted, size: 20),
              const SizedBox(width: 8),
              Expanded(child: Text(rider, style: const TextStyle(fontWeight: FontWeight.w600))),
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
      title: tr(ref, 'DELIVER TO', 'डिलीवरी'),
      trailing: phone == null
          ? null
          : TextButton.icon(
              onPressed: () => launchUrl(Uri(scheme: 'tel', path: phone)),
              icon: const Icon(Icons.call_rounded, size: 18),
              label: Text(tr(ref, 'Call', 'कॉल')),
              style: TextButton.styleFrom(minimumSize: const Size(44, 36), visualDensity: VisualDensity.compact),
            ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(o.customerName, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text([o.area, ?o.deliveryLine].where((s) => s.isNotEmpty).join(' · '), style: TextStyle(color: c.muted)),
          const SizedBox(height: 6),
          Text(tr(ref, 'A Deligro rider collects from your counter and delivers.', 'Deligro राइडर आपके काउंटर से लेकर डिलीवर करेगा।'),
              style: TextStyle(color: c.muted, fontSize: 12.5)),
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
      title: tr(ref, 'ITEMS (${order.itemCount})', 'आइटम (${order.itemCount})'),
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
                        Text(tr(ref, '${rupees(l.price)} each', '${rupees(l.price)} प्रति'),
                            style: TextStyle(color: c.muted, fontSize: 12.5)),
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
              Text(minus ? '−${rupees(amount)}' : rupees(amount),
                  style: dataStyle(context, size: bold ? 16 : 14, weight: bold ? FontWeight.w800 : FontWeight.w600)),
            ],
          ),
        );
    final funder = switch (o.discountFundedBy) {
      'vendor' => tr(ref, 'Funded by you', 'आपकी ओर से'),
      'platform' => tr(ref, 'Funded by Deligro', 'Deligro की ओर से'),
      _ => null,
    };
    return _Section(
      title: tr(ref, 'BILL', 'बिल'),
      child: Column(
        children: [
          line(tr(ref, 'Items', 'आइटम'), o.itemsSubtotal),
          if (o.discount > 0)
            line(
              o.couponCode == null ? tr(ref, 'Discount', 'छूट') : tr(ref, 'Discount (${o.couponCode})', 'छूट (${o.couponCode})'),
              o.discount,
              minus: true,
              note: funder,
            ),
          if (o.deliveryFee > 0) line(tr(ref, 'Delivery fee', 'डिलीवरी शुल्क'), o.deliveryFee),
          if (o.taxAmount > 0) line(tr(ref, 'Taxes', 'टैक्स'), o.taxAmount),
          if (o.tip > 0) line(tr(ref, 'Rider tip', 'राइडर टिप'), o.tip),
          Divider(color: c.line, height: 16),
          line(tr(ref, 'Customer pays', 'ग्राहक का कुल'), o.total, bold: true),
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              o.isCod
                  ? tr(ref, 'Cash on delivery — the rider collects it.', 'कैश ऑन डिलीवरी — राइडर पैसे लेगा।')
                  : tr(ref, 'Paid online to Deligro.', 'Deligro को ऑनलाइन भुगतान।'),
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
      title: tr(ref, 'CANCELLATION', 'रद्द होने का कारण'),
      child: Text(
        reason == null || reason.isEmpty ? tr(ref, 'No reason was given.', 'कोई कारण नहीं दिया गया।') : reason,
        style: TextStyle(color: context.colors.deal, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _Timeline extends ConsumerWidget {
  const _Timeline({required this.order});
  final VendorOrder order;

  String _what(WidgetRef ref, OrderEvent e) {
    if (e.kind == 'preparing') return tr(ref, 'Started preparing', 'बनाना शुरू किया');
    return switch (e.to) {
      'placed' => tr(ref, 'Order placed', 'ऑर्डर आया'),
      'kitchen' => tr(ref, 'Accepted', 'स्वीकार किया'),
      'ready' => tr(ref, 'Ready for pickup', 'पिकअप के लिए तैयार'),
      'on_the_way' => tr(ref, 'Picked up by the rider', 'राइडर ने उठाया'),
      'delivered' => tr(ref, 'Delivered', 'डिलीवर हुआ'),
      'cancelled' => tr(ref, 'Cancelled', 'रद्द हुआ'),
      _ => e.to ?? '',
    };
  }

  String _who(WidgetRef ref, OrderEvent e) => switch (e.by) {
        'you' => tr(ref, 'by you', 'आपके द्वारा'),
        'customer' => tr(ref, 'by the customer', 'ग्राहक द्वारा'),
        _ => tr(ref, 'by Deligro', 'Deligro द्वारा'),
      };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final events = order.events;
    if (events.isEmpty) return const SizedBox.shrink();
    return _Section(
      title: tr(ref, 'HISTORY', 'इतिहास'),
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
                          Text('${_what(ref, events[i])} ${events[i].kind == 'status' && events[i].to == 'placed' ? '' : _who(ref, events[i])}'.trim(),
                              style: const TextStyle(fontWeight: FontWeight.w600)),
                          Text(placedAt(events[i].at, hi: ref.watch(langProvider) == 'hi'),
                              style: TextStyle(color: c.muted, fontSize: 12.5)),
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
    required this.act,
  });
  final VendorOrder order;
  final bool busy;
  final Future<void> Function(VendorOrder) onAccept;
  final Future<void> Function(VendorOrder) onReject;
  final Future<void> Function(Future<void> Function(), String, String) act;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final o = order;
    final canReject = ref.watch(vendorMeProvider).value?.can('vendor.reject_orders') ?? false;
    final repo = ref.read(ordersRepoProvider);

    final List<Widget> buttons = switch (o.stage) {
      OrderStage.newOrder => [
          if (canReject)
            Expanded(
              child: OutlinedButton(
                onPressed: busy ? null : () => onReject(o),
                style: OutlinedButton.styleFrom(foregroundColor: c.deal, side: BorderSide(color: c.deal)),
                child: Text(tr(ref, 'Reject', 'मना करें')),
              ),
            ),
          if (canReject) const SizedBox(width: 10),
          Expanded(
            flex: 2,
            child: FilledButton.icon(
              onPressed: busy ? null : () => onAccept(o),
              icon: const Icon(Icons.check_rounded),
              label: Text(tr(ref, 'Accept', 'स्वीकार करें')),
            ),
          ),
        ],
      OrderStage.accepted => [
          Expanded(
            child: FilledButton.icon(
              onPressed: busy ? null : () => act(() => repo.startPreparing(o.id), 'Preparing started', 'बनाना शुरू हुआ'),
              icon: const Icon(Icons.soup_kitchen_rounded),
              label: Text(tr(ref, 'Start preparing', 'बनाना शुरू करें')),
            ),
          ),
        ],
      OrderStage.preparing => [
          Expanded(
            child: FilledButton.icon(
              onPressed: busy ? null : () => act(() => repo.markReady(o.id), 'Marked ready for pickup', 'पिकअप के लिए तैयार'),
              icon: const Icon(Icons.shopping_bag_rounded),
              label: Text(tr(ref, 'Mark ready for pickup', 'पिकअप के लिए तैयार करें')),
            ),
          ),
        ],
      _ => const [],
    };
    if (buttons.isEmpty) return const SizedBox.shrink();
    return SafeArea(
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
        decoration: BoxDecoration(color: c.bg, border: Border(top: BorderSide(color: c.line))),
        child: Row(children: buttons),
      ),
    );
  }
}
