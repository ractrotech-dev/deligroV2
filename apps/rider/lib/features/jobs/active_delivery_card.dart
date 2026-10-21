import 'package:flutter/material.dart';

import '../../core/format.dart';
import '../../models/jobs.dart';
import '../../theme/app_theme.dart';
import 'offer_card.dart';

/// The delivery the rider is carrying, as the Jobs tab shows it for now: the
/// order, where from and to, and the money. The step-by-step delivery screen
/// (Task 7) replaces this widget.
class ActiveDeliveryCard extends StatelessWidget {
  const ActiveDeliveryCard({super.key, required this.active});

  final RiderActive active;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      key: const Key('active-delivery'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusSheet),
        border: Border.all(color: c.green, width: 2.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.two_wheeler_rounded, color: c.green),
              const SizedBox(width: 8),
              Expanded(child: Text('Active delivery', style: Theme.of(context).textTheme.titleLarge)),
              Text(active.code, style: dataStyle(context, size: 14).copyWith(color: c.muted)),
            ],
          ),
          const SizedBox(height: 14),
          Text('Pick up from', style: Theme.of(context).textTheme.labelSmall),
          Text(active.shop.name, style: Theme.of(context).textTheme.titleMedium),
          if ((active.shop.line ?? '').isNotEmpty) Text(active.shop.line!, style: TextStyle(color: c.muted)),
          const SizedBox(height: 12),
          Text('Deliver to', style: Theme.of(context).textTheme.labelSmall),
          if ((active.drop.customerName ?? '').isNotEmpty)
            Text(active.drop.customerName!, style: Theme.of(context).textTheme.titleMedium),
          if ((active.drop.line ?? '').isNotEmpty) Text(active.drop.line!, style: TextStyle(color: c.muted)),
          const SizedBox(height: 14),
          PaymentBanner(payment: active.payment),
          if (active.distanceKm != null || active.etaMinutes != null) ...[
            const SizedBox(height: 10),
            Text(
              [
                if (active.distanceKm != null) distance(active.distanceKm!),
                if (active.etaMinutes != null) 'ETA ${active.etaMinutes} min',
              ].join(' · '),
              style: TextStyle(color: c.muted, fontWeight: FontWeight.w600),
            ),
          ],
        ],
      ),
    );
  }
}
