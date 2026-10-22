import 'package:flutter/material.dart';

import '../../models/dashboard.dart';
import '../../models/jobs.dart' show RiderDeliveryStatus;
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// The delivery status in the rider's words.
String deliveryStatusLabel(RiderDeliveryStatus? s) => switch (s) {
  RiderDeliveryStatus.accepted => 'Accepted',
  RiderDeliveryStatus.arrivedPickup => 'At the shop',
  RiderDeliveryStatus.pickedUp => 'Picked up',
  RiderDeliveryStatus.onTheWay => 'On the way',
  RiderDeliveryStatus.arrivedDrop => 'At the customer',
  RiderDeliveryStatus.delivered => 'Delivered',
  RiderDeliveryStatus.failed => 'Failed',
  RiderDeliveryStatus.cancelled => 'Cancelled',
  null => 'In progress',
};

/// Figure 11: the delivery in hand with its next step, tapping through to
/// Jobs; or "No active delivery".
class CurrentDeliveryCard extends StatelessWidget {
  const CurrentDeliveryCard({
    super.key,
    required this.current,
    required this.onTap,
  });

  final DashCurrent? current;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final cur = current;
    if (cur == null) {
      return Panel(
        key: const Key('current-delivery-none'),
        child: Row(
          children: [
            Icon(Icons.two_wheeler_outlined, color: c.muted),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'No active delivery',
                style: TextStyle(
                  color: c.muted,
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      );
    }
    return Semantics(
      button: true,
      label:
          'Current delivery ${cur.code}, ${deliveryStatusLabel(cur.status)}. ${cur.next}',
      excludeSemantics: true,
      child: Material(
        key: const Key('current-delivery'),
        color: c.accentSoft,
        borderRadius: BorderRadius.circular(radiusBlock),
        child: InkWell(
          borderRadius: BorderRadius.circular(radiusBlock),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: c.accent,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(Icons.two_wheeler_rounded, color: c.onAccent),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'CURRENT DELIVERY',
                        style: Theme.of(
                          context,
                        ).textTheme.labelSmall?.copyWith(color: c.accentInk),
                      ),
                      const SizedBox(height: 2),
                      Wrap(
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 8,
                        children: [
                          Text(
                            cur.code,
                            style: dataStyle(
                              context,
                              size: 16,
                              weight: FontWeight.w800,
                            ),
                          ),
                          Text(
                            deliveryStatusLabel(cur.status),
                            style: TextStyle(
                              color: c.accentInk,
                              fontSize: 15,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ],
                      ),
                      if (cur.next.isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(
                          cur.next,
                          style: TextStyle(
                            color: c.ink,
                            fontSize: 14,
                            height: 1.3,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                Icon(Icons.chevron_right_rounded, color: c.accentInk),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
