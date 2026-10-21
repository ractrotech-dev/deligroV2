import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../models/jobs.dart';
import '../../theme/app_theme.dart';

/// A delivery event (`delivery_events.kind`, with its method) in words.
String timelineLabel(RiderEvent e) {
  final m = e.method;
  return switch (e.kind) {
    'offered' => 'Offered to you',
    'accepted' => 'Accepted',
    'arrived_pickup' => 'Arrived at the shop',
    'picked_up' => switch (m) {
        'code' => 'Picked up with the code',
        'qr' => 'Picked up by QR scan',
        'manual' => 'Picked up (checked by ops)',
        'vendor' => 'Handed over by the shop',
        _ => 'Picked up',
      },
    'departed' => 'Started the trip',
    'arrived_drop' => 'Arrived at the customer',
    'delivered' => switch (m) {
        'code' => 'Delivered with the code',
        'photo' => 'Delivered with a photo',
        'ops_approved' => 'Delivered (approved by ops)',
        _ => 'Delivered',
      },
    'failed' => 'Delivery failed',
    'cancelled' => 'Cancelled',
    'contact_attempt' => m == 'vendor' ? 'Called the shop' : 'Called the customer',
    'released' => 'Handed back to dispatch',
    'rejected' => 'Turned down',
    'withdrawn' => 'Offer withdrawn',
    final other => _humanize(other),
  };
}

String _humanize(String kind) {
  final words = kind.replaceAll('_', ' ').trim();
  return words.isEmpty ? 'Update' : words[0].toUpperCase() + words.substring(1);
}

IconData _icon(String kind) => switch (kind) {
      'offered' || 'accepted' => Icons.assignment_turned_in_outlined,
      'arrived_pickup' => Icons.storefront_rounded,
      'picked_up' => Icons.shopping_bag_outlined,
      'departed' => Icons.two_wheeler_rounded,
      'arrived_drop' => Icons.home_rounded,
      'delivered' => Icons.check_circle_rounded,
      'failed' || 'cancelled' => Icons.cancel_outlined,
      'contact_attempt' => Icons.call_rounded,
      _ => Icons.circle_outlined,
    };

/// The delivery's history, oldest first, from the board's `active.timeline`.
Future<void> showTimelineSheet(BuildContext context, RiderActive active) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => _TimelineSheet(active: active),
  );
}

class _TimelineSheet extends StatelessWidget {
  const _TimelineSheet({required this.active});

  final RiderActive active;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final events = [...active.timeline]..sort((a, b) => a.at.compareTo(b.at));
    final time = DateFormat('h:mm a');
    return ConstrainedBox(
      key: const Key('timeline-sheet'),
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Text('Timeline · ${active.code}', style: Theme.of(context).textTheme.titleLarge),
          ),
          if (events.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              child: Text('Nothing recorded yet.', style: TextStyle(color: c.muted)),
            )
          else
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
                itemCount: events.length,
                itemBuilder: (context, i) {
                  final e = events[i];
                  final last = i == events.length - 1;
                  return IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        SizedBox(
                          width: 30,
                          child: Column(
                            children: [
                              Icon(_icon(e.kind), size: 20, color: last ? c.accentInk : c.muted),
                              if (!last) Expanded(child: Container(width: 2, color: c.line)),
                            ],
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Padding(
                            padding: const EdgeInsets.only(bottom: 16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(timelineLabel(e),
                                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15, color: c.ink)),
                                if ((e.reason ?? '').isNotEmpty)
                                  Text(e.reason!, style: TextStyle(color: c.muted, fontSize: 13.5)),
                              ],
                            ),
                          ),
                        ),
                        Text(time.format(e.at.toLocal()), style: dataStyle(context, size: 12.5).copyWith(color: c.muted)),
                      ],
                    ),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}
