import 'package:flutter/material.dart';

import '../../core/money.dart';
import '../../models/insights.dart';
import '../../theme/app_theme.dart';

/// The date range chips on History.
enum HistoryRange {
  today('today', 'Today', 'today'),
  yesterday('yesterday', 'Yesterday', 'yesterday'),
  week('week', 'This week', 'this week'),
  month('month', 'This month', 'this month'),
  custom('custom', 'Custom', 'in these dates');

  const HistoryRange(this.wire, this.label, this.phrase);

  /// The `range=` value in a link into History.
  final String wire;
  final String label;
  final String phrase;

  static HistoryRange? tryParse(String? v) {
    for (final r in values) {
      if (r.wire == v && r != custom) return r;
    }
    return null;
  }
}

/// What History shows: a date range (IST days the job ended on) and an
/// outcome (null = all).
class HistoryFilter {
  const HistoryFilter({
    this.range = HistoryRange.month,
    this.customFrom,
    this.customTo,
    this.outcome,
    this.notDelivered = false,
  });

  final HistoryRange range;

  /// `YYYY-MM-DD`, for [HistoryRange.custom].
  final String? customFrom;
  final String? customTo;
  final HistoryOutcome? outcome;

  /// Every job that did not end delivered (cancelled, failed, reassigned).
  /// The server filters by one outcome only, so this asks for all and drops
  /// the delivered rows here. Excludes [outcome].
  final bool notDelivered;

  HistoryFilter withRange(HistoryRange r, {String? from, String? to}) =>
      HistoryFilter(
        range: r,
        customFrom: from,
        customTo: to,
        outcome: outcome,
        notDelivered: notDelivered,
      );

  HistoryFilter withOutcome(HistoryOutcome? o) => HistoryFilter(
    range: range,
    customFrom: customFrom,
    customTo: customTo,
    outcome: o,
  );

  HistoryFilter withNotDelivered() => HistoryFilter(
    range: range,
    customFrom: customFrom,
    customTo: customTo,
    notDelivered: true,
  );

  /// The query for `GET /api/rider/history`, with [today] the IST day key
  /// (`YYYY-MM-DD`). Weeks start on Monday, as the server's do.
  ({String from, String to, String? outcome}) query(String today) {
    final day = parseDay(today)!;
    final (from, to) = switch (range) {
      HistoryRange.today => (today, today),
      HistoryRange.yesterday => (addDays(today, -1), addDays(today, -1)),
      HistoryRange.week => (addDays(today, -(day.weekday - 1)), today),
      HistoryRange.month => ('${today.substring(0, 8)}01', today),
      HistoryRange.custom => (
        customFrom ?? today,
        customTo ?? customFrom ?? today,
      ),
    };
    return (from: from, to: to, outcome: outcome?.wire);
  }

  /// "No failed jobs this week".
  String get emptyTitle {
    if (notDelivered) return 'No undelivered jobs ${range.phrase}';
    final noun = switch (outcome) {
      null => 'deliveries',
      HistoryOutcome.delivered => 'delivered jobs',
      HistoryOutcome.failed => 'failed jobs',
      HistoryOutcome.cancelled => 'cancelled jobs',
      HistoryOutcome.reassigned => 'reassigned jobs',
      HistoryOutcome.other => 'other jobs',
    };
    return 'No $noun ${range.phrase}';
  }

  @override
  bool operator ==(Object other) =>
      other is HistoryFilter &&
      other.range == range &&
      other.customFrom == customFrom &&
      other.customTo == customTo &&
      other.outcome == outcome &&
      other.notDelivered == notDelivered;

  @override
  int get hashCode =>
      Object.hash(range, customFrom, customTo, outcome, notDelivered);
}

/// The two chip rows on top of History.
class HistoryFilterBar extends StatelessWidget {
  const HistoryFilterBar({
    super.key,
    required this.filter,
    required this.onRange,
    required this.onOutcome,
    required this.onNotDelivered,
  });

  final HistoryFilter filter;

  /// Called with a range; for [HistoryRange.custom] the screen opens a date
  /// picker first.
  final ValueChanged<HistoryRange> onRange;
  final ValueChanged<HistoryOutcome?> onOutcome;
  final VoidCallback onNotDelivered;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget chip(Key key, String label, bool selected, VoidCallback onTap) =>
        Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: key,
            label: Text(label),
            selected: selected,
            showCheckmark: false,
            onSelected: (_) => onTap(),
            selectedColor: c.accentSoft,
            side: BorderSide(color: selected ? c.accent : c.line),
          ),
        );
    String customLabel() {
      final f = filter.customFrom;
      final t = filter.customTo;
      if (filter.range != HistoryRange.custom || f == null) return 'Custom';
      return formatRange(f, t ?? f);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              for (final r in HistoryRange.values)
                chip(
                  Key('range-${r.wire}'),
                  r == HistoryRange.custom ? customLabel() : r.label,
                  filter.range == r,
                  () => onRange(r),
                ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              chip(
                const Key('outcome-all'),
                'All',
                filter.outcome == null && !filter.notDelivered,
                () => onOutcome(null),
              ),
              for (final o in HistoryOutcome.filterable)
                chip(
                  Key('outcome-${o.wire}'),
                  o.label,
                  filter.outcome == o,
                  () => onOutcome(o),
                ),
              chip(
                const Key('outcome-not-delivered'),
                'Not delivered',
                filter.notDelivered,
                onNotDelivered,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
