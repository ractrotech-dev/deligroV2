import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/live.dart';
import '../../models/orders.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/order_labels.dart';

enum LiveSection { lanes, unassigned, delayed, alerts }

/// A signal in words (§6.7–6.8): "Ravi hasn't sent a location for 9 min
/// during a delivery", "Delivery failed: EF56AB78", …
String signalText(LiveSnapshot s, Signal g) {
  final order = g.orderId == null ? null : s.order(g.orderId!);
  final code = order?.item.code ?? (g.orderId == null ? 'An order' : g.orderId!.substring(0, 8).toUpperCase());
  final rider = g.riderId == null ? null : s.rider(g.riderId!)?.name;
  return switch (g.kind) {
    SignalKind.riderInactive => "${rider ?? 'A rider'} hasn't sent a location for ${g.minutes} min during a delivery",
    SignalKind.deliveryFailed => 'Delivery failed: $code',
    SignalKind.deliveryDelayed => '$code is running ${g.minutes} min late',
    SignalKind.orderUnassigned => '$code has had no rider for ${g.minutes} min',
    SignalKind.prepDelayed => '${order?.item.vendor.name ?? 'The kitchen'} is ${g.minutes} min behind on $code',
    SignalKind.acceptDelayed => '${order?.item.vendor.name ?? 'The kitchen'} has not accepted $code for ${g.minutes} min',
    SignalKind.unknown => 'Something needs attention${order == null ? '' : ' on $code'}',
  };
}

IconData signalIcon(SignalKind k) => switch (k) {
      SignalKind.riderInactive => Icons.location_off_outlined,
      SignalKind.deliveryFailed => Icons.report_gmailerrorred_outlined,
      SignalKind.deliveryDelayed => Icons.schedule,
      SignalKind.orderUnassigned => Icons.person_off_outlined,
      SignalKind.prepDelayed => Icons.soup_kitchen_outlined,
      SignalKind.acceptDelayed => Icons.notifications_active_outlined,
      SignalKind.unknown => Icons.info_outline,
    };

/// "Pickup by 2:05 PM · Arrives about 2:20 PM" — §6.5's estimates.
String etaLine(OrderListItem o) {
  final t = DateFormat('h:mm a');
  return [
    if (o.eta?.pickupAt != null) 'Pickup by ${t.format(o.eta!.pickupAt!.toLocal())}',
    if (o.eta?.expectedAt != null) 'Arrives about ${t.format(o.eta!.expectedAt!.toLocal())}',
  ].join(' · ');
}

/// What Live shows beside (tablet) or under (phone) the map: the lanes, the
/// unassigned and delayed queues, and the alert signals. [controller] is the
/// phone sheet's scroll controller (null in the side panel).
class LivePanel extends StatelessWidget {
  const LivePanel({
    super.key,
    required this.snapshot,
    required this.section,
    required this.onSection,
    required this.onLane,
    required this.onAssign,
    required this.onIntervene,
    required this.onOpenOrder,
    required this.onRider,
    this.controller,
    this.canAssign = true,
    this.showHandle = false,
  });

  final LiveSnapshot snapshot;
  final LiveSection section;
  final ValueChanged<LiveSection> onSection;
  final ValueChanged<String> onLane;
  final void Function(LiveOrder order) onAssign;
  final void Function(LiveOrder order) onIntervene;
  final ValueChanged<String> onOpenOrder;
  final void Function(LiveRider rider) onRider;
  final ScrollController? controller;
  final bool canAssign;
  final bool showHandle;

  static const _lanes = ['placed', 'kitchen', 'ready', 'on_the_way'];

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = snapshot;
    final unassigned = [for (final id in s.unassigned) ?s.order(id)];
    Widget chip(LiveSection value, String label) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: Key('live-section-${value.name}'),
            label: Text(label),
            selected: section == value,
            onSelected: (_) => onSection(value),
          ),
        );

    final rows = <Widget>[
      if (showHandle)
        Center(
          child: Container(
            margin: const EdgeInsets.only(top: 8, bottom: 6),
            width: 36,
            height: 4,
            decoration: BoxDecoration(color: c.line, borderRadius: BorderRadius.circular(2)),
          ),
        ),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
        child: Row(children: [
          chip(LiveSection.lanes, 'Lanes'),
          chip(LiveSection.unassigned, 'Unassigned (${s.unassigned.length})'),
          chip(LiveSection.delayed, 'Delayed (${s.delayed.length})'),
          chip(LiveSection.alerts, 'Alerts (${s.signals.length})'),
        ]),
      ),
      ...switch (section) {
        LiveSection.lanes => [
            for (final w in _lanes)
              ListTile(
                key: Key('lane-$w'),
                leading: StatusText('', color: statusColor(c, OrderStatus.parse(w))),
                minLeadingWidth: 12,
                title: Text(statusWireLabel(w), style: const TextStyle(fontWeight: FontWeight.w600)),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text('${s.lanes[w] ?? 0}', style: dataStyle(context, size: 18, weight: FontWeight.w700)),
                  const SizedBox(width: 4),
                  Icon(Icons.chevron_right, color: c.muted),
                ]),
                onTap: () => onLane(w),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: Text(
                '${s.riders.where((r) => r.state == RiderState.available && !r.stale).length} available · '
                '${s.riders.where((r) => r.state == RiderState.onDelivery && !r.stale).length} on delivery · '
                '${s.riders.where((r) => r.stale).length} out of date',
                style: TextStyle(color: c.muted, fontSize: 13),
              ),
            ),
          ],
        // The server lists only orders that have waited past the grace period
        // (thresholds.unassignedMinutes), so a brand-new order isn't "late".
        LiveSection.unassigned => unassigned.isEmpty
            ? [EmptyLine('No order has waited more than ${s.thresholds.unassignedMinutes} min for a rider.')]
            : [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                  child: Text('Waiting more than ${s.thresholds.unassignedMinutes} min for a rider',
                      style: TextStyle(fontSize: 12.5, color: c.muted)),
                ),
                for (final o in unassigned)
                  _OrderRow(
                    order: o,
                    actions: [
                      if (canAssign && o.item.rider == null)
                        FilledButton.tonal(
                          key: Key('assign-${o.item.id}'),
                          onPressed: () => onAssign(o),
                          child: const Text('Assign'),
                        ),
                      _actButton(o),
                    ],
                    onTap: () => onOpenOrder(o.item.id),
                  ),
              ],
        LiveSection.delayed => s.delayed.isEmpty
            ? [const EmptyLine('Nothing is running late.')]
            : [
                for (final d in s.delayed)
                  if (s.order(d.orderId) case final o?)
                    _OrderRow(
                      order: o,
                      delay: Delay(kind: d.kind, minutes: d.minutes),
                      actions: [_actButton(o)],
                      onTap: () => onOpenOrder(o.item.id),
                    ),
              ],
        LiveSection.alerts => s.signals.isEmpty
            ? [const EmptyLine('No alerts right now.')]
            : [
                for (final g in s.signals)
                  ListTile(
                    leading: Icon(signalIcon(g.kind), color: g.kind == SignalKind.unknown ? c.muted : c.deal),
                    title: Text(signalText(s, g), style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                    subtitle: g.at == null ? null : Text(placedAt(g.at)),
                    onTap: () {
                      if (g.orderId != null) {
                        onOpenOrder(g.orderId!);
                      } else if (g.riderId != null && s.rider(g.riderId!) != null) {
                        onRider(s.rider(g.riderId!)!);
                      }
                    },
                  ),
              ],
      },
    ];

    return ListView(
      key: const Key('live-panel'),
      controller: controller,
      padding: const EdgeInsets.only(bottom: 16),
      children: rows,
    );
  }

  Widget _actButton(LiveOrder o) => OutlinedButton(
        key: Key('intervene-${o.item.id}'),
        onPressed: () => onIntervene(o),
        child: const Text('Act'),
      );
}

class _OrderRow extends StatelessWidget {
  const _OrderRow({required this.order, required this.actions, required this.onTap, this.delay});
  final LiveOrder order;
  final Delay? delay;
  final List<Widget> actions;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = order.item;
    final d = delay ?? o.delay;
    final eta = etaLine(o);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    Text(o.code, style: dataStyle(context, size: 14, weight: FontWeight.w700)),
                    const SizedBox(width: 8),
                    Flexible(child: StatusText(statusLabel(o.status), color: statusColor(c, o.status))),
                  ]),
                  const SizedBox(height: 2),
                  Text(o.vendor.name, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: c.ink)),
                  if (d != null) ...[const SizedBox(height: 6), AlertPill(delayText(d))],
                  if (eta.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(eta, style: TextStyle(fontSize: 12.5, color: c.muted)),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
              for (final a in actions) Padding(padding: const EdgeInsets.only(bottom: 4), child: a),
            ]),
          ],
        ),
      ),
    );
  }
}
