import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../models/orders.dart' show TicketPriority;
import '../../models/tickets.dart';
import '../../theme/app_theme.dart';
import '../orders/order_labels.dart' show StatusText;

Color ticketStatusColor(AppColors c, TicketStatus s) => switch (s) {
      TicketStatus.open => c.deal,
      TicketStatus.escalated => c.deal,
      TicketStatus.inProgress || TicketStatus.waitingOnRequester => c.pop,
      TicketStatus.resolved => c.green,
      TicketStatus.closed || TicketStatus.unknown => c.muted,
    };

String priorityLabel(TicketPriority p) => switch (p) {
      TicketPriority.normal => 'Normal',
      TicketPriority.high => 'High priority',
      TicketPriority.emergency => 'Emergency',
    };

/// "food_quality" → "Food quality".
String categoryLabel(String wire) {
  if (wire.isEmpty) return 'General';
  final s = wire.replaceAll('_', ' ');
  return '${s[0].toUpperCase()}${s.substring(1)}';
}

/// One ticket in a list: number and subject, who raised it, its status.
class TicketSummaryTile extends StatelessWidget {
  const TicketSummaryTile({super.key, required this.ticket, required this.onTap});
  final TicketSummary ticket;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final t = ticket;
    final when = t.createdAt == null ? null : DateFormat('d MMM, h:mm a').format(t.createdAt!.toLocal());
    return Material(
      color: c.surface,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        key: Key('ticket-tile-${t.id}'),
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: c.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('#${t.number}', style: dataStyle(context, size: 13, weight: FontWeight.w700)),
                  const SizedBox(width: 8),
                  Flexible(child: StatusText(t.status.label, color: ticketStatusColor(c, t.status))),
                  const Spacer(),
                  if (t.priority != TicketPriority.normal)
                    Text(priorityLabel(t.priority), style: TextStyle(color: c.deal, fontSize: 12, fontWeight: FontWeight.w700)),
                ],
              ),
              const SizedBox(height: 4),
              Text(t.subject, maxLines: 2, overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontWeight: FontWeight.w600, color: c.ink)),
              const SizedBox(height: 4),
              Text(
                [categoryLabel(t.category), 'from ${t.requesterRole.label.toLowerCase()}', ?when].join(' · '),
                style: TextStyle(color: c.muted, fontSize: 12.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
