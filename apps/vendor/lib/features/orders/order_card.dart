import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/i18n.dart';
import '../../models/order.dart';
import '../../theme/app_theme.dart';
import '../../widgets/stage.dart';

/// One order in a list: ID, time, items and destination on the left; status,
/// payment and amount on the right. Tap for the full order.
class OrderCard extends ConsumerWidget {
  const OrderCard({super.key, required this.order});
  final VendorOrder order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final o = order;
    final hi = ref.watch(langProvider) == 'hi';
    final col = stageColors(context, o.stage);
    final items = tr(ref, '${o.itemCount} ${o.itemCount == 1 ? 'item' : 'items'}', '${o.itemCount} आइटम');

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
      elevation: 0,
      color: c.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        side: BorderSide(color: o.stage == OrderStage.newOrder ? c.accent.withValues(alpha: .55) : c.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => context.push('/orders/${o.id}'),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: col.bg, borderRadius: BorderRadius.circular(12)),
                child: Icon(stageIcon(o.stage), color: col.fg, size: 21),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(o.code, style: dataStyle(context, size: 15, weight: FontWeight.w800)),
                    const SizedBox(height: 2),
                    Text(placedAt(o.createdAt, hi: hi), style: TextStyle(color: c.muted, fontSize: 12.5)),
                    const SizedBox(height: 4),
                    Text(
                      '$items · ${o.customerName}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: c.muted, fontSize: 12.5),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  StagePill(o.stage, outForDelivery: o.status == 'on_the_way'),
                  const SizedBox(height: 8),
                  Text(rupees(o.total), style: dataStyle(context, size: 15, weight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  PaymentChip(method: o.paymentMethod, status: o.paymentStatus),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
