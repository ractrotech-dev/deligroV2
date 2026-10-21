import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/orders.dart';
import '../../state/orders.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/polling.dart';
import 'order_actions_bar.dart';
import 'order_labels.dart';
import 'order_mini_map.dart';
import 'order_timeline.dart';

/// Opens the phone's dialer. A failure is quiet: the number is on screen.
Future<void> callNumber(String phone) async {
  try {
    await launchUrl(Uri(scheme: 'tel', path: phone));
  } catch (_) {}
}

/// One order, full screen (§3.8–3.16): pushed from the list, a push, or a
/// Live pin.
class OrderDetailScreen extends ConsumerWidget {
  const OrderDetailScreen({super.key, required this.orderId});
  final String orderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final code = ref.watch(orderDetailProvider(orderId)).value?.summary.code;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        backgroundColor: c.bg,
        title: Text(code ?? 'Order', style: code == null ? null : dataStyle(context, size: 18, weight: FontWeight.w700)),
      ),
      body: OrderDetailBody(orderId: orderId),
    );
  }
}

/// The order's content and its actions — the full screen's body, and the
/// right-hand pane of the Orders tab on a tablet. Re-asks every 10 s while
/// visible.
class OrderDetailBody extends ConsumerWidget {
  const OrderDetailBody({super.key, required this.orderId});
  final String orderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(orderDetailProvider(orderId));
    final notifier = ref.read(orderDetailProvider(orderId).notifier);
    final d = value.value;
    if (d == null) {
      if (value.hasError) {
        final e = value.error!;
        if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
        return ErrorRetry(error: e, onRetry: () => ref.invalidate(orderDetailProvider(orderId)));
      }
      return const Center(child: CircularProgressIndicator());
    }
    final flows = OrderActionFlows(context: context, orderId: orderId, send: notifier.act);
    return Polling(
      interval: ordersRefresh,
      onTick: notifier.refresh,
      child: Column(
        children: [
          Expanded(
            child: RefreshIndicator(
              onRefresh: notifier.refresh,
              child: ListView(
                key: const Key('order-detail'),
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: _sections(context, d),
              ),
            ),
          ),
          if (d.allowed.any)
            Material(
              color: context.colors.surface,
              elevation: 6,
              child: SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                  child: SizedBox(width: double.infinity, child: OrderActionsBar(order: d, flows: flows)),
                ),
              ),
            ),
        ],
      ),
    );
  }

  List<Widget> _sections(BuildContext context, OrderDetail d) {
    final c = context.colors;
    final o = d.summary;
    final time = DateFormat('h:mm a');
    final del = d.delivery;
    final fix = del?.lastFix;
    final fixStale = fix != null && fix.ageSeconds > 120;
    LatLng? ll(double? lat, double? lng) => lat == null || lng == null ? null : LatLng(lat, lng);

    final etaBits = <String>[
      if (o.eta?.pickupAt != null) 'Pickup by ${time.format(o.eta!.pickupAt!.toLocal())}',
      if (o.eta?.expectedAt != null) 'Arrives about ${time.format(o.eta!.expectedAt!.toLocal())}',
      if (o.eta?.dueAt != null) 'Due ${time.format(o.eta!.dueAt!.toLocal())}',
    ];

    return [
      // Head: code, status, total, when, payment, delay, ETA.
      _Block(children: [
        Row(
          children: [
            Text(o.code, style: dataStyle(context, size: 20, weight: FontWeight.w800)),
            const SizedBox(width: 10),
            Flexible(child: StatusText(statusLabel(o.status), color: statusColor(c, o.status), size: 13.5)),
            const Spacer(),
            Text(rupees(o.total), style: dataStyle(context, size: 18, weight: FontWeight.w700)),
          ],
        ),
        const SizedBox(height: 6),
        Text(
          [placedAt(o.createdAt), paymentLabel(o.payment), if (o.byPhone) 'Phone order'].join(' · '),
          style: TextStyle(fontSize: 13, color: c.muted),
        ),
        if (o.delay != null && o.status.isActive) ...[const SizedBox(height: 10), AlertPill(delayText(o.delay!))],
        if (etaBits.isNotEmpty && o.status.isActive) ...[
          const SizedBox(height: 8),
          Text(etaBits.join(' · '), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.ink)),
        ],
        if (o.status == OrderStatus.cancelled && o.cancellation != null) ...[
          const SizedBox(height: 10),
          Text(cancellationLine(o.cancellation!),
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: c.deal)),
        ],
      ]),
      _Heading('Customer'),
      _Block(children: [
        _PersonRow(
          icon: Icons.person_outline,
          title: d.customer.name ?? o.customerName ?? 'Customer',
          phone: d.customer.phone,
          callKey: 'call-customer',
        ),
      ]),
      _Heading('Pickup'),
      _Block(children: [
        _PersonRow(
          icon: Icons.storefront_outlined,
          title: d.pickup.name ?? o.vendor.name,
          subtitle: d.pickup.address,
          phone: d.pickup.phone,
          callKey: 'call-shop',
        ),
      ]),
      _Heading('Drop'),
      _Block(children: [
        _PersonRow(
          icon: Icons.home_outlined,
          title: d.drop.label ?? 'Customer address',
          subtitle: d.drop.address,
        ),
        if (d.drop.landmark != null && d.drop.landmark!.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(left: 34, top: 2),
            child: Text(d.drop.landmark!, style: TextStyle(fontSize: 13, color: c.muted)),
          ),
      ]),
      if (d.pickup.hasPoint || d.drop.hasPoint || fix != null) ...[
        const SizedBox(height: 12),
        OrderMiniMap(
          shop: ll(d.pickup.lat, d.pickup.lng),
          drop: ll(d.drop.lat, d.drop.lng),
          rider: fix == null ? null : LatLng(fix.lat, fix.lng),
          riderStale: fixStale,
        ),
      ],
      _Heading('Delivery'),
      _Block(children: [
        Text(deliveryStatusLabel(del?.status ?? o.deliveryStatus),
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: c.ink)),
        const SizedBox(height: 6),
        if (del?.rider != null || o.rider != null)
          _PersonRow(
            icon: Icons.two_wheeler,
            title: [
              (del?.rider ?? o.rider)!.name,
              if ((del?.rider ?? o.rider)!.code != null) (del?.rider ?? o.rider)!.code!,
            ].join(' · '),
            subtitle: fix == null ? null : fixAgeText(fix.ageSeconds),
            subtitleColor: fixStale ? c.deal : null,
            phone: del?.rider?.phone,
            callKey: 'call-rider',
          )
        else
          Text(o.status.isActive ? 'No rider yet' : 'No rider', style: TextStyle(color: o.status.isActive ? c.deal : c.muted)),
        if (del?.failureReason != null) ...[
          const SizedBox(height: 6),
          Text('Failed: ${del!.failureReason!}', style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
        ],
      ]),
      _Heading('Items'),
      _Block(children: [
        for (final i in d.items)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(i.name, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ink)),
                      Text('${i.qty} × ${rupees(i.price)}', style: TextStyle(fontSize: 12.5, color: c.muted)),
                    ],
                  ),
                ),
                Text(rupees(i.lineTotal), style: dataStyle(context, size: 14)),
              ],
            ),
          ),
        Divider(color: c.line, height: 16),
        _MoneyRow('Items', d.money.subtotal),
        if (d.money.discount != 0) _MoneyRow('Discount', -d.money.discount),
        _MoneyRow('Delivery fee', d.money.deliveryFee),
        if (d.money.tax != 0) _MoneyRow('Taxes', d.money.tax),
        if (d.money.tip != 0) _MoneyRow('Tip', d.money.tip),
        const SizedBox(height: 4),
        _MoneyRow('Total', d.money.total, bold: true, key: const Key('money-total')),
      ]),
      if (d.tickets.isNotEmpty) ...[
        _Heading('Tickets'),
        _Block(children: [
          for (final t in d.tickets)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                [
                  '#${t.number}',
                  if (t.status != null) t.status!.replaceAll('_', ' '),
                  if (t.priority != null) '${t.priority!.name} priority',
                ].join(' · '),
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ink),
              ),
            ),
        ]),
      ],
      _Heading('Timeline'),
      _Block(children: [OrderTimeline(entries: d.timeline)]),
    ];
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 18, 4, 8),
        child: Text(text.toUpperCase(),
            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: context.colors.muted)),
      );
}

class _Block extends StatelessWidget {
  const _Block({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
    );
  }
}

class _PersonRow extends StatelessWidget {
  const _PersonRow({required this.icon, required this.title, this.subtitle, this.subtitleColor, this.phone, this.callKey});
  final IconData icon;
  final String title;
  final String? subtitle;
  final Color? subtitleColor;
  final String? phone;
  final String? callKey;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Row(
      children: [
        Icon(icon, size: 22, color: c.muted),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: c.ink)),
              if (subtitle != null && subtitle!.isNotEmpty)
                Text(subtitle!, style: TextStyle(fontSize: 13, color: subtitleColor ?? c.muted, height: 1.35)),
            ],
          ),
        ),
        if (phone != null && phone!.isNotEmpty)
          IconButton.filledTonal(
            key: callKey == null ? null : Key(callKey!),
            tooltip: 'Call',
            onPressed: () => callNumber(phone!),
            icon: const Icon(Icons.call),
          ),
      ],
    );
  }
}

class _MoneyRow extends StatelessWidget {
  const _MoneyRow(this.label, this.amount, {super.key, this.bold = false});
  final String label;
  final int amount;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final w = bold ? FontWeight.w800 : FontWeight.w500;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(child: Text(label, style: TextStyle(fontSize: 13.5, fontWeight: w, color: bold ? c.ink : c.muted))),
          Text(amount < 0 ? '−${rupees(-amount)}' : rupees(amount), style: dataStyle(context, size: bold ? 15 : 13.5, weight: w)),
        ],
      ),
    );
  }
}
