import 'package:flutter/material.dart';

import '../../core/money.dart';
import '../../models/earnings.dart';
import '../../theme/app_theme.dart';
import '../../widgets/rows.dart';
import 'earnings_widgets.dart';

/// One record with every figure that went into it: the order, the date, the
/// base fee, the distance and its fee, any minimum top-up, the tip (and whether
/// it was paid in cash), incentive, deduction, the final amount, whether it has
/// been paid, and when and under which reference.
class RecordDetailScreen extends StatelessWidget {
  const RecordDetailScreen({super.key, required this.record});

  final EarningRecord record;

  /// "3.4 km · by road", "3.4 km (estimated)" or "not recorded".
  static String distanceText(EarningRecord r) {
    final km = r.distanceKm ?? 0;
    final amount = km == km.roundToDouble()
        ? km.toStringAsFixed(0)
        : km.toString();
    return switch (r.distanceSource) {
      DistanceSource.road => '$amount km · by road',
      DistanceSource.estimate => '$amount km (estimated)',
      null => 'not recorded',
    };
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = record;
    final fields = <Widget>[];
    void add(String label, String value, {Color? color, bool strong = false}) =>
        fields.add(
          FieldRow(
            key: Key('field-$label'),
            label: label,
            value: value,
            valueColor: color,
            strong: strong,
          ),
        );

    if (r.orderCode != null) add('Order', r.orderCode!);
    add('Date', formatDay(r.date));
    if (r.kind != RecordKind.delivery && !r.isReversal) {
      add('Type', r.kindLabel);
    }
    if (r.kind != RecordKind.delivery && r.note != null && !r.isReversal) {
      add(r.kind == RecordKind.incentive ? 'Target' : 'Reason', r.note!);
    }
    if (r.baseFee != null) add('Base fee', money(r.baseFee!));
    if (r.kind == RecordKind.delivery) add('Distance', distanceText(r));
    if (r.distanceFee != null) add('Distance fee', money(r.distanceFee!));
    if (r.minTopup != null) add('Minimum top-up', money(r.minTopup!));
    final tip = r.tip ?? 0;
    if (tip > 0) {
      add(
        'Tip',
        r.tipInCash == true
            ? '${money(tip)} · paid to you in cash, not in this amount'
            : '${money(tip)} · included in this amount',
      );
    }
    if (r.kind == RecordKind.delivery && (r.incentive ?? 0) > 0) {
      add('Incentive', money(r.incentive!));
    }
    if (r.kind == RecordKind.delivery && (r.deduction ?? 0) > 0) {
      add('Deduction', money(-r.deduction!));
    }
    add(
      'Final amount',
      money(r.amount),
      strong: true,
      color: r.amount < 0 ? c.deal : null,
    );
    add('Payment', r.paid ? 'Paid' : 'Pending');
    if (r.paid && r.settledOn != null) {
      add('Settled on', formatDay(r.settledOn));
    }
    if (r.paid && r.reference != null) add('Reference', r.reference!);

    return Scaffold(
      appBar: AppBar(title: const Text('Record')),
      body: SafeArea(
        bottom: false,
        child: ListView(
          key: const Key('record-detail'),
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    r.title,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                if (r.reversed) ...[
                  const SizedBox(width: 8),
                  StatusChip.reversed(context),
                ],
              ],
            ),
            if (r.reversed) ...[
              const SizedBox(height: 8),
              Text(
                'This delivery was corrected, so its earning was taken back. The reversal is a separate record.',
                style: TextStyle(color: c.muted, fontSize: 14, height: 1.35),
              ),
            ],
            if (r.isReversal) ...[
              const SizedBox(height: 8),
              Text(
                'Deligro corrected this delivery after it was completed, so the earning is taken back automatically.',
                style: TextStyle(color: c.muted, fontSize: 14, height: 1.35),
              ),
            ],
            const SizedBox(height: 14),
            RowsCard(children: fields),
          ],
        ),
      ),
    );
  }
}
