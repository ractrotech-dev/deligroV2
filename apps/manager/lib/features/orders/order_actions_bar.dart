import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../models/orders.dart';
import 'order_labels.dart';
import 'reason_dialog.dart';
import 'rider_picker_sheet.dart';

/// The next stage a forward move takes an order to (the server's pipeline).
OrderStatus? nextStatus(OrderStatus s) => switch (s) {
      OrderStatus.placed => OrderStatus.kitchen,
      OrderStatus.kitchen => OrderStatus.ready,
      OrderStatus.ready => OrderStatus.onTheWay,
      OrderStatus.onTheWay => OrderStatus.delivered,
      _ => null,
    };

/// "Send to kitchen", "Mark Ready", "Mark On the way", "Mark Delivered".
String advanceLabel(OrderStatus next) =>
    next == OrderStatus.kitchen ? 'Send to kitchen' : 'Mark ${statusLabel(next)}';

/// What each refusal means, in a sentence (contract error codes).
String refusalText(ActionRefused r) => switch (r.code) {
      'stale' => 'Someone else moved this order. Showing where it is now.',
      'already_assigned' => 'A rider is already on this order.',
      'picked_up' => 'The rider has already picked this order up.',
      'terminal' => 'This order is already finished.',
      'financially_closed' => "This order's money is settled, so its status can't be corrected.",
      'invalid_transition' => "That change isn't possible from the order's current state.",
      'rider_ineligible' => r.reasons.isEmpty
          ? "That rider can't take this order."
          : "That rider can't take this order: ${r.reasons.map((s) => ineligibleText(IneligibleReason.parse(s)).toLowerCase()).join(', ')}.",
      'reason_required' => 'Please give a reason (at least 3 characters).',
      'permission_denied' => "You don't have permission for this. Ask an admin to turn it on.",
      'not_found' => "We couldn't find this order.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      _ => 'That didn\'t go through. Try again.',
    };

/// Every intervention on one order, as the manager walks through it: pick,
/// confirm, give a reason, send, and read the answer (§3.14–3.16, §6.9–6.10).
///
/// [send] does the request (the detail screen's notifier, or Live's
/// repository call). A refusal is shown in words; a network failure offers
/// Retry, which re-sends the very same action — and so the same
/// clientActionId — so the server can never apply it twice.
class OrderActionFlows {
  OrderActionFlows({required this.context, required this.orderId, required this.send, this.afterDone});

  final BuildContext context;
  final String orderId;
  final Future<ActionOutcome> Function(OrderAction action) send;

  /// Called after a change went through (Live refreshes its board).
  final VoidCallback? afterDone;

  Future<void> advance(OrderStatus expected, {bool reasonRequired = false}) async {
    final next = nextStatus(expected);
    if (next == null) return;
    String? reason;
    if (reasonRequired) {
      reason = await showReasonDialog(
        context,
        title: advanceLabel(next),
        quickPicks: ReasonPicks.intervention,
        message: 'This is a manual change. Say how you confirmed it.',
      );
      if (reason == null) return;
    }
    await _send(Advance(expected: expected, reason: reason), 'Marked ${statusLabel(next)}.');
  }

  Future<void> cancel() async {
    final reason = await showReasonDialog(
      context,
      title: 'Cancel order',
      quickPicks: ReasonPicks.cancel,
      submitLabel: 'Cancel order',
      message: 'The customer and the shop are told. Any refund follows the usual rules.',
    );
    if (reason == null) return;
    await _send(Cancel(reason: reason), 'Order cancelled.');
  }

  /// Assign a rider to an order without one, or [reassign] it. After pickup
  /// the manager must confirm the hand-over first.
  Future<void> pickRider({required bool reassign, bool pickedUp = false, String? currentRider}) async {
    final rider = await showRiderPicker(context, orderId: orderId, title: reassign ? 'Reassign to' : 'Assign a rider');
    if (rider == null || !context.mounted) return;
    var afterPickup = false;
    if (reassign && pickedUp) {
      final ok = await confirm(
        context,
        title: 'Hand-over needed',
        message: 'The food is with ${currentRider ?? 'the current rider'}. They must hand it to ${rider.name}.',
      );
      if (!ok || !context.mounted) return;
      afterPickup = true;
    }
    if (!reassign) {
      await _send(Assign(riderId: rider.id), '${rider.name} is on this order.');
      return;
    }
    final reason = await showReasonDialog(context, title: 'Why reassign?', quickPicks: ReasonPicks.reassign);
    if (reason == null) return;
    await _send(Reassign(riderId: rider.id, afterPickup: afterPickup, reason: reason), 'Reassigned to ${rider.name}.');
  }

  Future<void> escalate() async {
    final priority = await pickOne<TicketPriority>(context, title: 'Escalate as', options: const [
      (TicketPriority.high, 'High', 'A support ticket the team picks up first'),
      (TicketPriority.emergency, 'Emergency', 'Rings every manager and admin — safety only'),
    ]);
    if (priority == null || !context.mounted) return;
    final reason = await showReasonDialog(context, title: 'What is the issue?', quickPicks: ReasonPicks.escalate);
    if (reason == null) return;
    await _send(Escalate(priority: priority, reason: reason), 'Escalated.');
  }

  Future<void> correct(OrderDetail d) async {
    final hasItemIds = d.items.any((i) => i.id != null);
    final kind = await pickOne<CorrectionKind>(context, title: 'Correct', options: [
      (CorrectionKind.status, 'Order status', 'Move it back or forward to where it really is'),
      (CorrectionKind.deliveryStatus, 'Delivery status', 'Fix where the delivery really is'),
      if (hasItemIds) (CorrectionKind.itemUnavailable, 'Mark an item unavailable', 'Refunds that item by the usual rules'),
    ]);
    if (kind == null || !context.mounted) return;
    String? toStatus;
    String? itemId;
    switch (kind) {
      case CorrectionKind.status:
        toStatus = await pickOne<String>(context, title: 'Set the order to', options: [
          for (final s in const ['placed', 'kitchen', 'ready', 'on_the_way', 'delivered'])
            if (s != d.summary.status.wire) (s, statusWireLabel(s), null),
        ]);
        if (toStatus == null) return;
      case CorrectionKind.deliveryStatus:
        toStatus = await pickOne<String>(context, title: 'Set the delivery to', options: [
          for (final s in const ['unassigned', 'assigned', 'picked_up', 'delivered'])
            if (s != d.delivery?.status?.wire) (s, deliveryStatusLabel(DeliveryStatus.parse(s)), null),
        ]);
        if (toStatus == null) return;
      case CorrectionKind.itemUnavailable:
        itemId = await pickOne<String>(context, title: 'Which item?', options: [
          for (final i in d.items)
            if (i.id != null) (i.id!, i.name, '${i.qty} × ₹${i.price}'),
        ]);
        if (itemId == null) return;
    }
    if (!context.mounted) return;
    final reason = await showReasonDialog(context, title: 'Why correct it?', quickPicks: ReasonPicks.correct);
    if (reason == null) return;
    await _send(Correct(kind: kind, toStatus: toStatus, itemId: itemId, reason: reason), 'Corrected.');
  }

  Future<void> note() async {
    final text = await showReasonDialog(
      context,
      title: 'Add a note',
      hint: 'What should the team know?',
      submitLabel: 'Save note',
      maxLength: 1000,
    );
    if (text == null) return;
    await _send(Note(text: text), 'Note saved.');
  }

  Future<void> _send(OrderAction action, String doneText) async {
    if (!context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    void say(String text, {SnackBarAction? action}) => messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text(text),
        action: action,
        duration: action == null ? const Duration(seconds: 4) : const Duration(seconds: 12),
      ));
    try {
      final out = await send(action);
      switch (out) {
        case ActionDone(:final ticket):
          say(ticket == null ? doneText : '$doneText Ticket #${ticket.number}.');
          afterDone?.call();
        case ActionRefused():
          say(refusalText(out));
      }
    } on ApiException catch (e) {
      if (e.unauthorized) rethrow;
      say(
        e.code == 'network' ? "Couldn't reach Deligro — try again." : '${e.friendly} Try again.',
        action: SnackBarAction(label: 'Retry', onPressed: () => _send(action, doneText)),
      );
    }
  }
}

/// The buttons for what this manager may do to this order now — only the
/// ones the server's `allowed` lists.
class OrderActionsBar extends StatelessWidget {
  const OrderActionsBar({super.key, required this.order, required this.flows});

  final OrderDetail order;
  final OrderActionFlows flows;

  @override
  Widget build(BuildContext context) {
    final a = order.allowed;
    if (!a.any) return const SizedBox.shrink();
    final pickedUp = order.delivery?.status == DeliveryStatus.pickedUp || order.summary.deliveryStatus == DeliveryStatus.pickedUp;
    final riderName = order.delivery?.rider?.name ?? order.summary.rider?.name;
    Widget outlined(String key, IconData icon, String label, VoidCallback onTap, {bool danger = false}) => OutlinedButton.icon(
          key: Key('action-$key'),
          onPressed: onTap,
          icon: Icon(icon, size: 18),
          label: Text(label),
          style: danger ? OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error) : null,
        );
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        if (a.advance != null)
          FilledButton.icon(
            key: const Key('action-advance'),
            onPressed: () => flows.advance(order.summary.status),
            icon: const Icon(Icons.arrow_forward, size: 18),
            label: Text(advanceLabel(a.advance!)),
          ),
        if (a.assign) outlined('assign', Icons.two_wheeler, 'Assign rider', () => flows.pickRider(reassign: false)),
        if (a.reassign)
          outlined('reassign', Icons.swap_horiz, 'Reassign rider',
              () => flows.pickRider(reassign: true, pickedUp: pickedUp, currentRider: riderName)),
        if (a.escalate) outlined('escalate', Icons.priority_high, 'Escalate', flows.escalate),
        if (a.correct) outlined('correct', Icons.edit_note, 'Correct', () => flows.correct(order)),
        if (a.note) outlined('note', Icons.sticky_note_2_outlined, 'Add note', flows.note),
        if (a.cancel) outlined('cancel', Icons.close, 'Cancel order', flows.cancel, danger: true),
      ],
    );
  }
}
