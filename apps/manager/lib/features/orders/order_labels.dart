import 'package:flutter/material.dart';

import '../../models/orders.dart';
import '../../theme/app_theme.dart';

/// Words for the order states, shared by the list, the detail and Live, so
/// the same status never reads two ways.

String statusLabel(OrderStatus s) => switch (s) {
      OrderStatus.placed => 'New',
      OrderStatus.kitchen => 'In kitchen',
      OrderStatus.ready => 'Ready',
      OrderStatus.onTheWay => 'On the way',
      OrderStatus.delivered => 'Delivered',
      OrderStatus.cancelled => 'Cancelled',
      OrderStatus.unknown => 'Unknown',
    };

/// Same, from a database status string (`on_the_way`, …).
String statusWireLabel(String wire) => statusLabel(OrderStatus.parse(wire));

/// The status's colour: green done, red cancelled, amber waiting on the
/// kitchen, blue moving, neutral otherwise.
Color statusColor(AppColors c, OrderStatus s) => switch (s) {
      OrderStatus.placed => c.popInk,
      OrderStatus.kitchen => c.accentInk,
      OrderStatus.ready => c.blue,
      OrderStatus.onTheWay => c.blue,
      OrderStatus.delivered => c.green,
      OrderStatus.cancelled => c.deal,
      OrderStatus.unknown => c.muted,
    };

String deliveryStatusLabel(DeliveryStatus? s) => switch (s) {
      null => 'No delivery yet',
      DeliveryStatus.unassigned => 'Waiting for a rider',
      DeliveryStatus.assigned => 'Rider assigned',
      DeliveryStatus.pickedUp => 'Picked up',
      DeliveryStatus.delivered => 'Delivered',
      DeliveryStatus.failed => 'Delivery failed',
      DeliveryStatus.cancelled => 'Delivery cancelled',
      DeliveryStatus.unknown => 'Unknown',
    };

/// "Kitchen 12 min late", "Waiting for pickup 4 min", "Late 9 min",
/// "No rider 6 min".
String delayText(Delay d) => switch (d.kind) {
      DelayKind.prep => 'Kitchen ${d.minutes} min late',
      DelayKind.pickup => 'Waiting for pickup ${d.minutes} min',
      DelayKind.delivery => 'Late ${d.minutes} min',
      DelayKind.unassigned => 'No rider ${d.minutes} min',
      DelayKind.unknown => 'Delayed ${d.minutes} min',
    };

String cancelledByLabel(CancelledBy? by) => switch (by) {
      CancelledBy.customer => 'Customer cancelled',
      CancelledBy.vendor => 'Vendor cancelled',
      CancelledBy.manager => 'Manager cancelled',
      CancelledBy.admin => 'Admin cancelled',
      CancelledBy.system => 'Cancelled automatically',
      null => 'Cancelled',
    };

/// "Vendor cancelled · Out of stock" (or just who, when no reason was given).
String cancellationLine(Cancellation c) {
  final who = cancelledByLabel(c.by);
  final why = c.reason?.trim();
  return why == null || why.isEmpty ? who : '$who · $why';
}

String paymentLabel(Payment p) {
  final method = switch (p.method) {
    PaymentMethod.cod => 'Cash',
    PaymentMethod.online => 'Online',
    PaymentMethod.unknown || null => null,
  };
  final status = switch (p.status) {
    PaymentStatus.pending => 'pending',
    PaymentStatus.paid => 'paid',
    PaymentStatus.failed => 'failed',
    PaymentStatus.refunded => 'refunded',
    PaymentStatus.unknown || null => null,
  };
  if (method == null && status == null) return 'Payment —';
  return [?method, ?status].join(' · ');
}

Color paymentColor(AppColors c, Payment p) => switch (p.status) {
      PaymentStatus.failed => c.deal,
      PaymentStatus.refunded => c.popInk,
      PaymentStatus.paid => c.green,
      _ => c.muted,
    };

/// "updated just now", "updated 45 s ago", "updated 9 min ago",
/// "updated 2 h ago" (§6.12: the age of the last location fix).
String fixAgeText(int? seconds) {
  if (seconds == null) return 'no location yet';
  if (seconds < 10) return 'updated just now';
  if (seconds < 60) return 'updated $seconds s ago';
  final m = (seconds / 60).floor();
  if (m < 60) return 'updated $m min ago';
  final h = (m / 60).floor();
  return 'updated $h h ago';
}

/// A small coloured word with a dot — a status in a row (the console's
/// StatusText: colour on the smallest mark that carries it).
class StatusText extends StatelessWidget {
  const StatusText(this.text, {super.key, required this.color, this.size = 12.5});
  final String text;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 5),
          Flexible(
            child: Text(
              text,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: size, fontWeight: FontWeight.w700, color: color),
            ),
          ),
        ],
      );
}

/// A soft pill for one attention-worthy fact (a delay).
class AlertPill extends StatelessWidget {
  const AlertPill(this.text, {super.key, this.icon = Icons.schedule});
  final String text;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(999)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: c.deal),
          const SizedBox(width: 4),
          Flexible(
            child: Text(text,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.deal)),
          ),
        ],
      ),
    );
  }
}
