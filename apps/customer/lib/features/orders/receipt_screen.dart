import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/order.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'orders_screen.dart';

/// What the customer paid, itemised (components/orders/order-receipt.tsx).
class ReceiptScreen extends ConsumerWidget {
  const ReceiptScreen({super.key, required this.orderId});
  final String orderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(orderProvider(orderId));
    return Scaffold(
      appBar: AppBar(title: const Text('Receipt')),
      body: AsyncBody<Order?>(
        value: async,
        onRetry: () => ref.invalidate(orderProvider(orderId)),
        builder: (order) => order == null
            ? const EmptyState(icon: Icons.search_off_rounded, title: 'We couldn\'t find this order')
            : ListView(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
                children: [_Receipt(order: order)],
              ),
      ),
    );
  }
}

class _Receipt extends StatelessWidget {
  const _Receipt({required this.order});
  final Order order;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = order;
    final placedOn = o.createdAt == null
        ? ''
        : DateFormat('d MMM y, h:mm a').format(o.createdAt!.toLocal());
    final label = TextStyle(color: c.muted, fontSize: 13);
    final value = const TextStyle(fontSize: 13, fontWeight: FontWeight.w600);

    Widget meta(String k, String v) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: 104, child: Text(k, style: label)),
              Expanded(child: Text(v, textAlign: TextAlign.right, style: value)),
            ],
          ),
        );

    Widget money(String k, int amount, {bool negative = false}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(
            children: [
              Expanded(child: Text(k, style: TextStyle(color: c.muted, fontSize: 14))),
              Text(negative ? '−${rupees(amount)}' : rupees(amount), style: dataStyle(context)),
            ],
          ),
        );

    return Panel(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('DELIGRO',
                        style: TextStyle(
                            fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 2.2, color: c.muted)),
                    const SizedBox(height: 4),
                    const Text('Receipt',
                        style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: -0.4)),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(o.shortId,
                      style: dataStyle(context, size: 13, weight: FontWeight.w800).copyWith(letterSpacing: 1.2)),
                  const SizedBox(height: 2),
                  Text(placedOn, style: TextStyle(fontSize: 12, color: c.muted)),
                ],
              ),
            ],
          ),
          const Divider(height: 28),
          meta('Restaurant', o.restaurantName),
          if (o.address.isNotEmpty) meta('Delivered to', o.address),
          meta('Payment', paymentLabel(o)),
          meta('Status', o.status.label),
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(child: Text('ITEM', style: Theme.of(context).textTheme.labelSmall)),
              SizedBox(
                width: 40,
                child: Text('QTY', textAlign: TextAlign.right, style: Theme.of(context).textTheme.labelSmall),
              ),
              SizedBox(
                width: 84,
                child: Text('AMOUNT', textAlign: TextAlign.right, style: Theme.of(context).textTheme.labelSmall),
              ),
            ],
          ),
          const SizedBox(height: 6),
          const Divider(height: 1),
          for (final l in o.lines) ...[
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(l.name, style: const TextStyle(fontSize: 14)),
                        if (l.addons.isNotEmpty)
                          Text('+ ${l.addons.join(', ')}', style: const TextStyle(fontSize: 12.5)),
                      ],
                    ),
                  ),
                  SizedBox(
                    width: 40,
                    child: Text('${l.qty}',
                        textAlign: TextAlign.right, style: TextStyle(color: c.muted, fontSize: 14)),
                  ),
                  SizedBox(
                    width: 84,
                    child: Text(rupees(l.qty * l.price), textAlign: TextAlign.right, style: dataStyle(context)),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: c.line.withValues(alpha: .6)),
          ],
          const SizedBox(height: 12),
          money('Subtotal', o.subtotal),
          if (o.discount > 0)
            money(o.couponCode?.isNotEmpty == true ? 'Discount (${o.couponCode})' : 'Discount', o.discount,
                negative: true),
          money('Delivery', o.deliveryFee),
          if (o.tax > 0) money('Taxes', o.tax),
          if (o.tip > 0) money('Tip for the rider', o.tip),
          const Divider(height: 24),
          Row(
            children: [
              const Expanded(child: Text('Total', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800))),
              Text(rupees(o.total), style: dataStyle(context, size: 17, weight: FontWeight.w800)),
            ],
          ),
          const Divider(height: 28),
          Text(
            'This is a customer receipt for an order placed through Deligro. Prices are in Indian '
            'rupees and include any taxes shown above.',
            style: TextStyle(fontSize: 11, height: 1.5, color: c.muted),
          ),
        ],
      ),
    );
  }
}
