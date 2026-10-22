import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/money.dart';
import '../../models/earnings.dart';
import '../../state/clock.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// The Earnings tab's root (`/earnings`).
const earningsPath = '/earnings';

/// The `driver.earnings` switch in `/api/rider/me`'s `features`.
const earningsFeature = 'driver.earnings';

/// A pill: "Paid", "Pending", "Reversed", "Earned".
class StatusChip extends StatelessWidget {
  const StatusChip(this.label, {super.key, required this.fg, required this.bg});

  /// Settled by a payout.
  factory StatusChip.paid(BuildContext context, {Key? key}) => StatusChip(
    'Paid',
    key: key,
    fg: context.colors.green,
    bg: context.colors.greenSoft,
  );

  /// Earned and waiting for a payout.
  factory StatusChip.pending(BuildContext context, {Key? key}) => StatusChip(
    'Pending',
    key: key,
    fg: context.colors.accentInk,
    bg: context.colors.accentSoft,
  );

  /// A delivery taken back by a correction.
  factory StatusChip.reversed(BuildContext context, {Key? key}) => StatusChip(
    'Reversed',
    key: key,
    fg: context.colors.deal,
    bg: context.colors.dealSoft,
  );

  final String label;
  final Color fg;
  final Color bg;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
    decoration: BoxDecoration(
      color: bg,
      borderRadius: BorderRadius.circular(20),
    ),
    child: Text(
      label,
      style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w800),
    ),
  );
}

/// A labelled figure in a card: "Paid out ₹11,820". [caption] is a plain
/// sentence under it.
class MoneyTile extends StatelessWidget {
  const MoneyTile({
    super.key,
    required this.label,
    required this.value,
    this.valueColor,
    this.caption,
    this.captionColor,
    this.big = false,
  });

  final String label;
  final String value;
  final Color? valueColor;
  final String? caption;
  final Color? captionColor;
  final bool big;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Panel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(
              color: c.muted,
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            value,
            style: dataStyle(
              context,
              size: big ? 28 : 21,
              weight: FontWeight.w800,
            ).copyWith(color: valueColor ?? c.ink),
          ),
          if (caption != null) ...[
            const SizedBox(height: 4),
            Text(
              caption!,
              style: TextStyle(
                color: captionColor ?? c.muted,
                fontSize: 13,
                height: 1.3,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// A key and its value, one per line of a record's detail.
class FieldRow extends StatelessWidget {
  const FieldRow({
    super.key,
    required this.label,
    required this.value,
    this.valueColor,
    this.strong = false,
  });

  final String label;
  final String value;
  final Color? valueColor;
  final bool strong;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 4,
            child: Text(
              label,
              style: TextStyle(
                color: c.muted,
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 6,
            child: Text(
              value,
              textAlign: TextAlign.end,
              style: TextStyle(
                color: valueColor ?? c.ink,
                fontSize: strong ? 17 : 15,
                fontWeight: strong ? FontWeight.w800 : FontWeight.w700,
                height: 1.3,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// One record in a list (Records and the statement): what it is, when, how
/// much, and whether it has been paid.
class RecordRow extends ConsumerWidget {
  const RecordRow({super.key, required this.record, required this.onTap});

  final EarningRecord record;
  final VoidCallback onTap;

  static IconData _icon(EarningRecord r) {
    if (r.isReversal) return Icons.undo_rounded;
    return switch (r.kind) {
      RecordKind.delivery => Icons.two_wheeler_rounded,
      RecordKind.incentive => Icons.emoji_events_outlined,
      RecordKind.bonus => Icons.card_giftcard_rounded,
      RecordKind.salary => Icons.payments_outlined,
      RecordKind.adjustment => Icons.tune_rounded,
      RecordKind.deduction => Icons.remove_circle_outline_rounded,
    };
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final r = record;
    final year = ref.watch(clockProvider)().year;
    final showYear = parseDay(r.date)?.year != year;
    // A delivery's title already carries its order code.
    final subtitle = [
      if (r.kind != RecordKind.delivery && r.orderCode != null)
        'Order ${r.orderCode}',
      formatDay(r.date, year: showYear),
    ].join(' · ');
    final amountStyle = dataStyle(context, size: 16, weight: FontWeight.w800)
        .copyWith(
          color: r.reversed ? c.muted : c.ink,
          decoration: r.reversed ? TextDecoration.lineThrough : null,
        );
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 64),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(
            children: [
              Icon(_icon(r), size: 22, color: c.muted),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      r.title,
                      style: TextStyle(
                        color: c.ink,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        height: 1.25,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(color: c.muted, fontSize: 13),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              // At most 40% of the screen: a big amount shrinks, the chips
              // wrap; the title keeps the rest.
              ConstrainedBox(
                constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(money(r.amount), style: amountStyle),
                    ),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 4,
                      runSpacing: 4,
                      alignment: WrapAlignment.end,
                      children: [
                        if (r.reversed) StatusChip.reversed(context),
                        if (r.paid)
                          StatusChip.paid(context)
                        else
                          StatusChip.pending(context),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A range the rider can pick: an id for tests, a label, the IST days.
class RangeOption {
  const RangeOption(this.id, this.label, this.from, this.to);

  final String id;
  final String label;
  final String from;
  final String to;
}

/// Quick ranges as chips, and "Pick dates" for any other.
class RangeChips extends StatelessWidget {
  const RangeChips({
    super.key,
    required this.options,
    required this.selected,
    required this.onSelect,
    required this.onPickDates,
  });

  final List<RangeOption> options;

  /// An option's id, or `custom`.
  final String selected;
  final ValueChanged<RangeOption> onSelect;
  final VoidCallback onPickDates;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final o in options)
          ChoiceChip(
            key: Key('range-${o.id}'),
            label: Text(o.label),
            selected: selected == o.id,
            onSelected: (_) => onSelect(o),
          ),
        ActionChip(
          key: const Key('range-custom'),
          avatar: const Icon(Icons.date_range_rounded, size: 18),
          label: const Text('Pick dates'),
          backgroundColor: selected == 'custom'
              ? context.colors.accentSoft
              : null,
          onPressed: onPickDates,
        ),
      ],
    );
  }
}

/// IST day ranges used by Records and the statement.
({String from, String to}) lastDays(String today, int n) =>
    (from: addDays(today, -(n - 1)), to: today);

({String from, String to}) thisMonth(String today) =>
    (from: '${today.substring(0, 8)}01', to: today);

({String from, String to}) lastMonth(String today) {
  final d = parseDay(today)!;
  final lastOfPrev = DateTime(d.year, d.month, 0);
  return (
    from: dayKeyOf(DateTime(lastOfPrev.year, lastOfPrev.month, 1)),
    to: dayKeyOf(lastOfPrev),
  );
}

/// The longest range the server answers (`invalid_range` past it).
const maxRangeDays = 366;

/// Asks for any two days within the last year.
Future<({String from, String to})?> pickDays(
  BuildContext context, {
  required String today,
  String? from,
  String? to,
}) async {
  final last = parseDay(today)!;
  final picked = await showDateRangePicker(
    context: context,
    firstDate: DateTime(last.year - 1, last.month, last.day),
    lastDate: last,
    initialDateRange: from != null && to != null
        ? DateTimeRange(start: parseDay(from)!, end: parseDay(to)!)
        : null,
    helpText: 'Choose dates',
  );
  if (picked == null) return null;
  var start = picked.start;
  // A year and a day is more than the server will give in one go.
  final earliest = DateTime(
    picked.end.year,
    picked.end.month,
    picked.end.day - (maxRangeDays - 1),
  );
  if (start.isBefore(earliest)) start = earliest;
  return (from: dayKeyOf(start), to: dayKeyOf(picked.end));
}
