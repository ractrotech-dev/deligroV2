import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../models/orders.dart';
import '../../theme/app_theme.dart';
import 'order_labels.dart';

/// "Picked up · via code", "Status: New → In kitchen", "Rider reassigned" — one
/// line per event; unknown kinds read as their own words.
String timelineTitle(TimelineEntry e) {
  // Ops corrections carry the correction kind in `method` and the status
  // before/after in `from`/`to`; escalations carry the levels.
  if (e.kind == 'corrected') return _corrected(e);
  if (e.kind == 'escalated') return _escalated(e);
  final base = switch (e.kind) {
    'status' => e.to == null
        ? 'Status changed'
        : e.from == null
            ? 'Order ${statusWireLabel(e.to!).toLowerCase()}'
            : 'Status: ${statusWireLabel(e.from!)} → ${statusWireLabel(e.to!)}',
    'preparing' => 'Kitchen started preparing',
    'offered' => 'Offered to a rider',
    'accepted' => 'Rider accepted',
    'rejected' => 'Rider declined',
    'lapsed' => 'Offer timed out',
    'assigned' => 'Rider assigned',
    'arrived_pickup' => 'Rider at the shop',
    'picked_up' => 'Picked up',
    'departed_pickup' => 'Left the shop',
    'arrived_drop' => 'Rider at the customer',
    'delivered' => 'Delivered',
    'failed' => 'Delivery failed',
    'cancelled' => 'Cancelled',
    'reassigned' => 'Rider reassigned',
    'corrected' => 'Corrected',
    'escalated' => 'Escalated',
    'note' => 'Note',
    _ => e.kind.isEmpty ? 'Event' : '${e.kind[0].toUpperCase()}${e.kind.substring(1).replaceAll('_', ' ')}',
  };
  return e.method == null || e.method!.isEmpty ? base : '$base · via ${e.method!.replaceAll('_', ' ')}';
}

String _corrected(TimelineEntry e) {
  String change(String Function(String) words) =>
      e.from != null && e.to != null ? ': ${words(e.from!)} → ${words(e.to!)}' : (e.to != null ? ': ${words(e.to!)}' : '');
  return switch (e.method) {
    'status' => 'Status corrected${change(statusWireLabel)}',
    'delivery_status' => 'Delivery status corrected${change((s) => deliveryStatusLabel(DeliveryStatus.parse(s)))}',
    'item_unavailable' => 'Item marked unavailable',
    _ => 'Corrected${change((s) => s.replaceAll('_', ' '))}',
  };
}

String _escalated(TimelineEntry e) {
  final from = int.tryParse(e.from ?? '');
  final to = int.tryParse(e.to ?? '');
  if (to == null) return 'Escalated';
  if (from == null || from == 0) return 'Escalated to level $to';
  return 'Escalated from level $from to $to';
}

String actorRoleLabel(ActorRole r) => switch (r) {
      ActorRole.manager => 'Manager',
      ActorRole.admin => 'Admin',
      ActorRole.vendor => 'Vendor',
      ActorRole.driver => 'Rider',
      ActorRole.customer => 'Customer',
      ActorRole.system => 'System',
      ActorRole.unknown => '',
    };

/// The order's history, oldest first (§3.10): what happened, when, who did
/// it, and why when a reason was given. Ops events (notes, corrections,
/// escalations) carry the accent.
class OrderTimeline extends StatelessWidget {
  const OrderTimeline({super.key, required this.entries});
  final List<TimelineEntry> entries;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    if (entries.isEmpty) {
      return Text('Nothing recorded yet.', style: TextStyle(color: c.muted));
    }
    final time = DateFormat('h:mm a');
    final day = DateFormat('d MMM');
    String? lastDay;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < entries.length; i++) ...() {
          final e = entries[i];
          final local = e.at?.toLocal();
          final d = local == null ? null : day.format(local);
          final showDay = d != null && d != lastDay;
          if (d != null) lastDay = d;
          final ops = e.source == 'ops';
          final who = e.actor == null
              ? null
              : [e.actor!.name, actorRoleLabel(e.actor!.role)].where((s) => s.isNotEmpty).join(' · ');
          return [
            if (showDay)
              Padding(
                padding: const EdgeInsets.only(bottom: 6, top: 2),
                child: Text(d, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: c.muted)),
              ),
            IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(
                    width: 64,
                    child: Text(local == null ? '' : time.format(local),
                        style: dataStyle(context, size: 12, weight: FontWeight.w600).copyWith(color: c.muted)),
                  ),
                  Column(
                    children: [
                      Container(
                        margin: const EdgeInsets.only(top: 4),
                        width: 9,
                        height: 9,
                        decoration: BoxDecoration(color: ops ? c.accent : c.line, shape: BoxShape.circle),
                      ),
                      if (i < entries.length - 1) Expanded(child: Container(width: 1.5, color: c.line)),
                    ],
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 14),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(timelineTitle(e),
                              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: ops ? c.accentInk : c.ink)),
                          if (who != null) Text(who, style: TextStyle(fontSize: 12.5, color: c.muted)),
                          if (e.reason != null && e.reason!.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 3),
                              child: Text(e.reason!,
                                  style: TextStyle(fontSize: 13, color: c.ink, fontStyle: FontStyle.italic, height: 1.35)),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ];
        }(),
      ],
    );
  }
}
