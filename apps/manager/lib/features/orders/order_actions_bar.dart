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

/// Every later stage on the forward path, nearest first.
List<OrderStatus> laterStatuses(OrderStatus s) {
  final out = <OrderStatus>[];
  for (var n = nextStatus(s); n != null; n = nextStatus(n)) {
    out.add(n);
  }
  return out;
}

/// "Send to kitchen", "Mark Ready", "Mark On the way", "Mark Delivered".
String advanceLabel(OrderStatus next) =>
    next == OrderStatus.kitchen ? 'Send to kitchen' : 'Mark ${statusLabel(next)}';

/// The request field a 400 named, in words.
String fieldWords(String field) => switch (field) {
      'reason' => 'reason',
      'note' => 'note',
      'riderId' => 'rider',
      'toStatus' => 'status',
      'itemId' => 'item',
      'priority' => 'priority',
      'expected' => 'current status',
      'kind' => 'kind of correction',
      _ => field,
    };

/// What the Emergency escalation does — the server sends a high-priority push
/// to the zone's managers and every admin (the app has no ringing service).
const escalateEmergencyText = "Sends an urgent push to this zone's managers and all admins — safety only";

/// What each refusal means, in a sentence (contract error codes).
String refusalText(ActionRefused r) => switch (r.code) {
      'stale' => 'Someone else moved this order. Showing where it is now.',
      'already_assigned' => 'A rider is already on this order.',
      'picked_up' => 'The rider has already picked this order up.',
      'terminal' => 'This order is already finished.',
      'financially_closed' => "This order's money is settled, so its status can't be corrected.",
      'invalid_transition' => "That change isn't possible from the order's current state.",
      'use_advance' => 'To complete an order use Mark Delivered — it records the cash and closes the delivery.',
      'refund_exceeds_total' => 'That would refund more than the customer paid.',
      'rider_ineligible' => r.reasons.isEmpty
          ? "That rider can't take this order."
          : "That rider can't take this order: ${r.reasons.map((s) => ineligibleText(IneligibleReason.parse(s)).toLowerCase()).join(', ')}.",
      'reason_required' => 'Please give a reason (at least 3 characters).',
      'bad_request' => r.field == null
          ? 'That request was incomplete. Try again.'
          : "The server didn't accept the ${fieldWords(r.field!)}. Check it and try again.",
      'permission_denied' => "You don't have permission for this. Ask an admin to turn it on.",
      'not_found' => "We couldn't find this order.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      _ => "That didn't go through. Try again.",
    };

/// The inline message under a refused reason or note.
String _inlineError(ActionRefused r, String field) => field == 'note'
    ? 'The note needs 3 to 1,000 characters.'
    : r.code == 'reason_required'
        ? 'A reason of 3 to 300 characters is needed.'
        : "The server didn't accept this ${fieldWords(field)}. Change it and send again.";

/// Every intervention on one order, as the manager walks through it: pick,
/// confirm, give a reason, send, and read the answer (§3.14–3.16, §6.9–6.10).
///
/// [send] does the request (the detail screen's notifier, or Live's
/// repository call). A refusal is shown in words — and one that names the
/// reason or note field reopens that dialog with the complaint under the
/// text. A network or server failure (500 `action_failed` included) offers
/// Retry, which re-sends the very same action — and so the same
/// clientActionId — so the server can never apply it twice.
class OrderActionFlows {
  OrderActionFlows({required this.context, required this.orderId, required this.send, this.afterDone});

  final BuildContext context;
  final String orderId;
  final Future<ActionOutcome> Function(OrderAction action) send;

  /// Called after a change went through (Live refreshes its board).
  final VoidCallback? afterDone;

  /// Move the order a step, or straight to any later status (e.g. preparing
  /// to delivered) — the server walks it through each step, audited. Every
  /// manager status change carries a reason (the server refuses one without);
  /// the four quick reasons cost one tap.
  Future<void> advance(OrderStatus expected) async {
    final later = laterStatuses(expected);
    if (later.isEmpty) return;
    var target = later.first;
    if (later.length > 1) {
      final picked = await pickOne<OrderStatus>(context, title: 'Move the order to', options: [
        for (final s in later) (s, statusLabel(s), s == later.first ? 'Next step' : 'Skips the steps in between'),
      ]);
      if (picked == null || !context.mounted) return;
      target = picked;
    }
    final jump = target != later.first;
    await _withText(
      title: jump ? 'Move to ${statusLabel(target)}' : advanceLabel(target),
      picks: ReasonPicks.advance,
      message: 'This is a manual change. Say how you confirmed it.',
      build: (r) => Advance(expected: expected, to: jump ? target : null, reason: r),
      doneText: 'Marked ${statusLabel(target)}.',
    );
  }

  Future<void> cancel() => _withText(
        title: 'Cancel order',
        picks: ReasonPicks.cancel,
        submitLabel: 'Cancel order',
        message: 'The customer and the shop are told. Any refund follows the usual rules.',
        build: (r) => Cancel(reason: r),
        doneText: 'Order cancelled.',
      );

  /// Assign a rider to an order without one, or [reassign] it. After pickup
  /// the manager must confirm the hand-over first. A rider the picker marks
  /// offline, on a break or with no recent location can be put on anyway
  /// (an override, with a reason the server records); a failed or cancelled
  /// delivery takes a new rider as a new attempt, also with a reason.
  Future<void> pickRider({required bool reassign, bool pickedUp = false, String? currentRider, bool newLeg = false}) async {
    final pick = await showRiderPicker(context, orderId: orderId, title: reassign ? 'Reassign to' : 'Assign a rider');
    if (pick == null || !context.mounted) return;
    final rider = pick.rider;
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
    if (!reassign && !pick.override && !newLeg) {
      await _send(Assign(riderId: rider.id), '${rider.name} is on this order.');
      return;
    }
    if (!reassign) {
      await _withText(
        title: pick.override ? 'Why put ${rider.name} on anyway?' : 'Why try again?',
        picks: pick.override ? ReasonPicks.override : ReasonPicks.newLeg,
        build: (r) => Assign(riderId: rider.id, override: pick.override, reason: r),
        doneText: '${rider.name} is on this order.',
      );
      return;
    }
    await _withText(
      title: 'Why reassign?',
      picks: pick.override ? ReasonPicks.override : ReasonPicks.reassign,
      build: (r) => Reassign(riderId: rider.id, afterPickup: afterPickup, override: pick.override, reason: r),
      doneText: 'Reassigned to ${rider.name}.',
    );
  }

  Future<void> escalate() async {
    final priority = await pickOne<TicketPriority>(context, title: 'Escalate as', options: const [
      (TicketPriority.high, 'High', 'A support ticket the team picks up first'),
      (TicketPriority.emergency, 'Emergency', escalateEmergencyText),
    ]);
    if (priority == null || !context.mounted) return;
    await _withText(
      title: 'What is the issue?',
      picks: ReasonPicks.escalate,
      build: (r) => Escalate(priority: priority, reason: r),
      doneText: 'Escalated.',
    );
  }

  Future<void> correct(OrderDetail d) async {
    final hasItemIds = d.items.any((i) => i.id != null);
    final kind = await pickOne<CorrectionKind>(context, title: 'Correct', options: [
      (CorrectionKind.status, 'Order status', 'Move it back or forward to where it really is'),
      (CorrectionKind.deliveryStatus, 'Delivery status', 'Fix where the delivery really is'),
      if (hasItemIds) (CorrectionKind.itemUnavailable, 'Mark an item unavailable', 'Refunds that item by the usual rules'),
      (CorrectionKind.addressNote, 'Delivery note for the rider', 'A gate code or landmark the customer gave'),
    ]);
    if (kind == null || !context.mounted) return;
    String? toStatus;
    String? itemId;
    String? note;
    switch (kind) {
      case CorrectionKind.status:
        toStatus = await pickOne<String>(context, title: 'Set the order to', options: [
          for (final s in const ['placed', 'kitchen', 'ready', 'on_the_way'])
            if (s != d.summary.status.wire) (s, statusWireLabel(s), null),
        ]);
        if (toStatus == null) return;
      case CorrectionKind.deliveryStatus:
        toStatus = await pickOne<String>(context, title: 'Set the delivery to', options: [
          for (final s in const ['unassigned', 'assigned', 'picked_up'])
            if (s != d.delivery?.status?.wire) (s, deliveryStatusLabel(DeliveryStatus.parse(s)), null),
        ]);
        if (toStatus == null) return;
      case CorrectionKind.itemUnavailable:
        itemId = await pickOne<String>(context, title: 'Which item?', options: [
          for (final i in d.items)
            if (i.id != null) (i.id!, i.name, '${i.qty} × ₹${i.price}'),
        ]);
        if (itemId == null) return;
      case CorrectionKind.addressNote:
        if (!context.mounted) return;
        note = await showReasonDialog(
          context,
          title: 'Delivery note for the rider',
          hint: 'Gate code, landmark, which door…',
          submitLabel: 'Next',
          initialText: d.drop.note,
        );
        if (note == null) return;
    }
    if (!context.mounted) return;
    await _withText(
      title: 'Why correct it?',
      picks: ReasonPicks.correct,
      build: (r) => Correct(kind: kind, toStatus: toStatus, itemId: itemId, note: note, reason: r),
      doneText: 'Corrected.',
    );
  }

  Future<void> note() => _withText(
        title: 'Add a note',
        hint: 'What should the team know?',
        submitLabel: 'Save note',
        maxLength: 1000,
        field: 'note',
        build: (t) => Note(text: t),
        doneText: 'Note saved.',
      );

  /// Ask for the text, send, and — while the server refuses that very
  /// [field] — ask again with its complaint shown inline. Changed text is a
  /// new decision, so it goes with a new clientActionId.
  Future<void> _withText({
    required String title,
    required OrderAction Function(String text) build,
    required String doneText,
    List<String> picks = const [],
    String? message,
    String submitLabel = 'Submit',
    String hint = 'Reason',
    int maxLength = 300,
    String field = 'reason',
  }) async {
    String? error;
    String? last;
    while (true) {
      if (!context.mounted) return;
      final text = await showReasonDialog(
        context,
        title: title,
        quickPicks: picks,
        message: message,
        submitLabel: submitLabel,
        hint: hint,
        maxLength: maxLength,
        initialText: last,
        errorText: error,
      );
      if (text == null) return;
      final out = await _send(build(text), doneText, inlineField: field);
      if (out is ActionRefused && _isAbout(out, field)) {
        last = text;
        error = _inlineError(out, field);
        continue;
      }
      return;
    }
  }

  static bool _isAbout(ActionRefused r, String field) =>
      r.field == field || (field == 'reason' && r.code == 'reason_required' && (r.field == null || r.field == 'reason'));

  Future<ActionOutcome?> _send(OrderAction action, String doneText, {String? inlineField}) async {
    if (!context.mounted) return null;
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
          // A complaint about the text is shown in the reopened dialog.
          if (inlineField == null || !_isAbout(out, inlineField)) say(refusalText(out));
      }
      return out;
    } on ApiException catch (e) {
      if (e.unauthorized) rethrow;
      say(
        e.code == 'network' ? "Couldn't reach Deligro — try again." : '${e.friendly} Try again.',
        action: SnackBarAction(label: 'Retry', onPressed: () => _send(action, doneText)),
      );
      return null;
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
    final legStatus = order.delivery?.status ?? order.summary.deliveryStatus;
    final newLeg = legStatus == DeliveryStatus.failed || legStatus == DeliveryStatus.cancelled;
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
        if (a.assign)
          outlined('assign', Icons.two_wheeler, newLeg ? 'Assign a new rider' : 'Assign rider',
              () => flows.pickRider(reassign: false, newLeg: newLeg)),
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
