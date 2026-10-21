import 'package:flutter/material.dart';

import '../../models/live.dart';
import '../../models/manager_me.dart';
import '../../models/orders.dart';
import '../../theme/app_theme.dart';
import '../orders/order_actions_bar.dart';
import '../orders/order_labels.dart';

enum _Act { advance, assign, reassign, escalate, note, cancel, open }

/// Manual intervention on a live order (§6.9–6.10): every choice asks for a
/// reason — the forward move included, which is routine on the order screen
/// but a manual override when made from the map (Claude's call, recorded in
/// the plan). What this manager may not do is not offered; the server refuses
/// it anyway.
Future<void> showInterventionSheet(
  BuildContext context, {
  required LiveOrder order,
  required OrderActionFlows flows,
  required ManagerMe? me,
  required VoidCallback onOpen,
}) async {
  final o = order.item;
  bool can(String key) => me == null || me.isAdmin || me.can(key);
  final next = nextStatus(o.status);
  final pickedUp = o.deliveryStatus == DeliveryStatus.pickedUp;
  final c = context.colors;

  final choice = await showModalBottomSheet<_Act>(
    context: context,
    showDragHandle: true,
    builder: (ctx) {
      Widget row(_Act a, IconData icon, String title, {String? subtitle, bool danger = false}) => ListTile(
            leading: Icon(icon, color: danger ? c.deal : c.ink),
            title: Text(title, style: TextStyle(fontWeight: FontWeight.w600, color: danger ? c.deal : c.ink)),
            subtitle: subtitle == null ? null : Text(subtitle),
            onTap: () => Navigator.pop(ctx, a),
          );
      return SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
              child: Text('${o.code} · ${o.vendor.name}', style: Theme.of(ctx).textTheme.titleMedium),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                [statusLabel(o.status), if (o.delay != null) delayText(o.delay!)].join(' · '),
                style: TextStyle(color: c.muted),
              ),
            ),
            if (next != null && can('manager.move_status'))
              row(_Act.advance, Icons.arrow_forward, advanceLabel(next), subtitle: 'Needs a reason'),
            if (o.rider == null && can('manager.assign_rider')) row(_Act.assign, Icons.two_wheeler, 'Assign rider'),
            if (o.rider != null && !o.status.isTerminal && can('manager.reassign_rider'))
              row(_Act.reassign, Icons.swap_horiz, 'Reassign rider'),
            if (can('manager.orders.escalate')) row(_Act.escalate, Icons.priority_high, 'Escalate'),
            if (can('manager.orders.correct')) row(_Act.note, Icons.sticky_note_2_outlined, 'Add note'),
            if (!o.status.isTerminal && can('manager.move_status'))
              row(_Act.cancel, Icons.close, 'Cancel order', danger: true),
            row(_Act.open, Icons.open_in_new, 'Open order'),
          ],
        ),
      );
    },
  );

  switch (choice) {
    case null:
      return;
    case _Act.advance:
      await flows.advance(o.status, reasonRequired: true);
    case _Act.assign:
      await flows.pickRider(reassign: false);
    case _Act.reassign:
      await flows.pickRider(reassign: true, pickedUp: pickedUp, currentRider: o.rider?.name);
    case _Act.escalate:
      await flows.escalate();
    case _Act.note:
      await flows.note();
    case _Act.cancel:
      await flows.cancel();
    case _Act.open:
      onOpen();
  }
}
