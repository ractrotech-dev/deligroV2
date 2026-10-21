import 'package:flutter/material.dart';

import '../../core/format.dart';
import '../../models/orders.dart';
import '../../theme/app_theme.dart';
import 'order_labels.dart';

/// One order in the list: code and status, vendor and customer, when, how
/// much and how it was paid, who is carrying it, and — when something is
/// wrong — the delay or the cancellation in words.
class OrderTile extends StatelessWidget {
  const OrderTile({super.key, required this.order, required this.onTap, this.selected = false});

  final OrderListItem order;
  final VoidCallback onTap;

  /// Highlighted in the side-by-side layout.
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = order;
    final who = [o.vendor.name, if (o.customerName != null && o.customerName!.isNotEmpty) o.customerName!].join(' → ');
    return Material(
      color: selected ? c.accentSoft : c.surface,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        key: Key('order-tile-${o.id}'),
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: selected ? c.accent : c.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(o.code, style: dataStyle(context, size: 14.5, weight: FontWeight.w700)),
                  if (o.byPhone) ...[
                    const SizedBox(width: 6),
                    Icon(Icons.phone_in_talk_outlined, size: 14, color: c.muted,
                        semanticLabel: 'Phone order'),
                  ],
                  const SizedBox(width: 10),
                  Flexible(child: StatusText(statusLabel(o.status), color: statusColor(c, o.status))),
                  const Spacer(),
                  Text(rupees(o.total), style: dataStyle(context, size: 15, weight: FontWeight.w700)),
                ],
              ),
              const SizedBox(height: 6),
              Text(who,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ink)),
              const SizedBox(height: 4),
              Row(
                children: [
                  Text(placedAt(o.createdAt), style: TextStyle(fontSize: 12.5, color: c.muted)),
                  _dot(c),
                  Flexible(
                    child: Text(
                      paymentLabel(o.payment),
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: paymentColor(c, o.payment)),
                    ),
                  ),
                  _dot(c),
                  Icon(Icons.two_wheeler_outlined, size: 14, color: o.rider == null ? c.deal : c.muted),
                  const SizedBox(width: 3),
                  Flexible(
                    child: Text(
                      o.rider?.name ?? 'No rider',
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: o.rider == null && o.status.isActive ? c.deal : c.muted,
                      ),
                    ),
                  ),
                ],
              ),
              if (o.delay != null && o.status.isActive) ...[
                const SizedBox(height: 8),
                AlertPill(delayText(o.delay!)),
              ],
              if (o.status == OrderStatus.cancelled && o.cancellation != null) ...[
                const SizedBox(height: 6),
                Text(
                  cancellationLine(o.cancellation!),
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: c.deal),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _dot(AppColors c) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6),
        child: Text('·', style: TextStyle(color: c.muted)),
      );
}

/// A grey placeholder the shape of a tile, for the first load.
class OrderTileSkeleton extends StatelessWidget {
  const OrderTileSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget bar(double w, double h) => Container(
          width: w,
          height: h,
          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(6)),
        );
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [bar(90, 14), const Spacer(), bar(54, 14)]),
          const SizedBox(height: 10),
          bar(200, 13),
          const SizedBox(height: 8),
          bar(160, 11),
        ],
      ),
    );
  }
}
