import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/order.dart';
import '../theme/app_theme.dart';

/// The six statuses' labels, in the requirements' words.
String stageLabel(WidgetRef ref, OrderStage stage) => switch (stage) {
  OrderStage.newOrder => 'New',
  OrderStage.accepted => 'Accepted',
  OrderStage.preparing => 'Preparing',
  OrderStage.ready => 'Ready for pickup',
  OrderStage.completed => 'Completed',
  OrderStage.cancelled => 'Cancelled',
};

IconData stageIcon(OrderStage stage) => switch (stage) {
  OrderStage.newOrder => Icons.notifications_active_rounded,
  OrderStage.accepted => Icons.thumb_up_alt_rounded,
  OrderStage.preparing => Icons.soup_kitchen_rounded,
  OrderStage.ready => Icons.shopping_bag_rounded,
  OrderStage.completed => Icons.check_circle_rounded,
  OrderStage.cancelled => Icons.cancel_rounded,
};

/// Colour states meaning (AGENTS.md): amber pending, blue informational,
/// green success, red critical. New orders take the brand accent — they are
/// the thing the kitchen must act on.
({Color fg, Color bg}) stageColors(BuildContext context, OrderStage stage) {
  final c = context.colors;
  return switch (stage) {
    OrderStage.newOrder => (fg: c.accentInk, bg: c.accentSoft),
    OrderStage.accepted => (fg: c.blue, bg: c.blue.withValues(alpha: .14)),
    OrderStage.preparing => (fg: popText(context), bg: c.pop.withValues(alpha: .22)),
    OrderStage.ready => (fg: c.green, bg: c.greenSoft),
    OrderStage.completed => (fg: c.muted, bg: c.surface2),
    OrderStage.cancelled => (fg: c.deal, bg: c.dealSoft),
  };
}

class StagePill extends ConsumerWidget {
  const StagePill(this.stage, {super.key, this.outForDelivery = false});
  final OrderStage stage;

  /// A completed order still on its way to the customer.
  final bool outForDelivery;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final col = stageColors(context, stage);
    final label = outForDelivery ? 'Out for delivery' : stageLabel(ref, stage);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(color: col.bg, borderRadius: BorderRadius.circular(999)),
      child: Text(
        label,
        style: TextStyle(color: col.fg, fontSize: 12, fontWeight: FontWeight.w700),
      ),
    );
  }
}

/// How the customer pays, separate from the order's status (requirements §4).
class PaymentChip extends ConsumerWidget {
  const PaymentChip({super.key, required this.method, required this.status});
  final String? method;
  final String? status;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (method == null) return const SizedBox.shrink();
    final c = context.colors;
    final (label, fg) = switch ((method, status)) {
      ('cod', _) => ('Cash', c.ink),
      (_, 'paid') => ('Paid online', c.green),
      (_, 'refunded') => ('Refunded', c.muted),
      (_, 'failed') => ('Payment failed', c.deal),
      _ => ('Online · pending', popText(context)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: TextStyle(color: fg, fontSize: 11.5, fontWeight: FontWeight.w700),
      ),
    );
  }
}

/// The amber "pending" text colour, readable on both themes: the dark ink on
/// a light surface, the bright amber itself on a dark one.
Color popText(BuildContext context) =>
    Theme.of(context).brightness == Brightness.dark ? context.colors.pop : context.colors.popInk;
