import 'dart:math' as math;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/duration_text.dart';
import '../../core/ist_time.dart';
import '../../core/money.dart';
import '../../models/insights.dart';
import '../../state/history.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../earnings/earnings_widgets.dart' show MoneyTile, earningsFeature;

/// Performance's route under More (`/more/performance`).
const performancePath = '/more/performance';

/// How the rider is doing: today and this week against target, the last 30
/// days' times and rates, hours online, what customers said, and the
/// month-by-month report.
class PerformanceScreen extends ConsumerWidget {
  const PerformanceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider).value;
    final riderId = me?.id;
    final perf = riderId == null
        ? const AsyncValue<RiderPerformance>.loading()
        : ref.watch(performanceProvider(riderId));
    final showMoney = me?.feature(earningsFeature) != false;
    return Scaffold(
      appBar: AppBar(title: const Text('Performance')),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            if (riderId == null) return;
            ref.invalidate(performanceProvider(riderId));
            await ref
                .read(performanceProvider(riderId).future)
                .then<void>((_) {}, onError: (_) {});
          },
          child: AsyncBody<RiderPerformance>(
            value: perf,
            onRetry: () {
              if (riderId != null) ref.invalidate(performanceProvider(riderId));
            },
            builder: (p) => _Body(perf: p, showMoney: showMoney),
          ),
        ),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.perf, required this.showMoney});

  final RiderPerformance perf;
  final bool showMoney;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final p = perf;
    String caption(num? v, String fallback) => v == null ? fallback : '';
    Widget stat(String key, String label, String value, {String? note}) =>
        MoneyTile(
          key: Key(key),
          label: label,
          value: value,
          caption: note == null || note.isEmpty ? null : note,
        );
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        Panel(
          key: const Key('targets-card'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Targets', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: TargetRing(
                      key: const Key('ring-daily'),
                      label: 'Today',
                      progress: p.daily,
                    ),
                  ),
                  Expanded(
                    child: TargetRing(
                      key: const Key('ring-weekly'),
                      label: 'This week',
                      progress: p.weekly,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SectionTitle(
          'Last 30 days',
          padding: EdgeInsets.fromLTRB(4, 22, 4, 8),
        ),
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: stat(
                  'stat-accept-deliver',
                  'Accepted to delivered',
                  minutesText(p.avgAcceptToDeliverMin),
                  note: caption(p.avgAcceptToDeliverMin, 'No deliveries yet'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: stat(
                  'stat-pickup-deliver',
                  'Picked up to delivered',
                  minutesText(p.avgPickupToDeliverMin),
                  note: caption(p.avgPickupToDeliverMin, 'No deliveries yet'),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: stat(
                  'stat-acceptance',
                  'Acceptance rate',
                  percentText(p.acceptanceRate),
                  note: p.acceptanceRate == null
                      ? 'No offers yet'
                      : 'Offers you accepted',
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: stat(
                  'stat-failed',
                  'Failed rate',
                  percentText(p.failedRate),
                  note: p.failedRate == null
                      ? 'No deliveries yet'
                      : 'Of jobs you finished',
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        SizedBox(
          width: double.infinity,
          child: stat(
            'stat-online',
            'Online this week',
            hoursText(p.onlineHoursThisWeek),
          ),
        ),
        const SectionTitle(
          'Customer ratings',
          padding: EdgeInsets.fromLTRB(4, 22, 4, 8),
        ),
        RatingCard(rating: p.rating),
        const SectionTitle(
          'Month by month',
          padding: EdgeInsets.fromLTRB(4, 22, 4, 8),
        ),
        Panel(
          padding: const EdgeInsets.fromLTRB(8, 16, 12, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(left: 8, bottom: 10),
                child: Text(
                  'Deliveries each month',
                  style: TextStyle(
                    color: c.muted,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              MonthlyChart(months: p.months),
            ],
          ),
        ),
        const SizedBox(height: 12),
        MonthlyTable(months: p.months, showMoney: showMoney),
      ],
    );
  }
}

/// A ring: [progress.done] of [progress.target]; grey and "No target" when
/// there is none to show.
class TargetRing extends StatelessWidget {
  const TargetRing({super.key, required this.label, required this.progress});

  final String label;
  final TargetProgress progress;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final has = progress.hasTarget;
    final reached = has && progress.done >= progress.target;
    return Semantics(
      label: has
          ? '$label: ${progress.done} of ${progress.target} deliveries'
          : '$label: no target',
      excludeSemantics: true,
      child: Column(
        children: [
          SizedBox(
            width: 104,
            height: 104,
            child: CustomPaint(
              painter: _RingPainter(
                fraction: progress.fraction,
                track: c.surface2,
                color: reached ? c.green : c.accent,
              ),
              child: Center(
                child: has
                    ? Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            '${progress.done}',
                            style: dataStyle(
                              context,
                              size: 24,
                              weight: FontWeight.w800,
                            ),
                          ),
                          Text(
                            'of ${progress.target}',
                            style: TextStyle(color: c.muted, fontSize: 12.5),
                          ),
                        ],
                      )
                    : Text(
                        'No target',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: c.muted,
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            label,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({
    required this.fraction,
    required this.track,
    required this.color,
  });

  final double fraction;
  final Color track;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 10.0;
    final rect = Offset.zero & size;
    final arc = rect.deflate(stroke / 2);
    final base = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = track;
    canvas.drawArc(arc, 0, math.pi * 2, false, base);
    if (fraction > 0) {
      canvas.drawArc(
        arc,
        -math.pi / 2,
        math.pi * 2 * fraction,
        false,
        base
          ..color = color
          ..strokeCap = StrokeCap.round,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.fraction != fraction || old.track != track || old.color != color;
}

/// Stars, the average and the count, then the latest comments with no names.
class RatingCard extends StatelessWidget {
  const RatingCard({super.key, required this.rating});

  final RatingBlock rating;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final avg = rating.average;
    return Panel(
      key: const Key('rating-card'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (avg == null || rating.count == 0)
            Row(
              children: [
                Icon(Icons.star_border_rounded, color: c.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'No ratings yet. Customers can rate you after a delivery.',
                    style: TextStyle(
                      color: c.muted,
                      fontSize: 14.5,
                      height: 1.3,
                    ),
                  ),
                ),
              ],
            )
          else
            Row(
              children: [
                Text(
                  avg.toStringAsFixed(1),
                  key: const Key('rating-average'),
                  style: dataStyle(context, size: 30, weight: FontWeight.w800),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Stars(value: avg, size: 22),
                      const SizedBox(height: 2),
                      Text(
                        '${rating.count} ${rating.count == 1 ? 'rating' : 'ratings'}',
                        key: const Key('rating-count'),
                        style: TextStyle(color: c.muted, fontSize: 13.5),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          if (rating.recent.isNotEmpty) ...[
            const SizedBox(height: 14),
            const Divider(),
            for (final r in rating.recent)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Stars(value: r.rating.toDouble(), size: 16),
                        const SizedBox(width: 10),
                        if (r.at != null)
                          Expanded(
                            child: Text(
                              istDayTime(r.at!),
                              textAlign: TextAlign.end,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(color: c.muted, fontSize: 12.5),
                            ),
                          ),
                      ],
                    ),
                    if (r.comment != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        r.comment!,
                        style: const TextStyle(fontSize: 14.5, height: 1.35),
                      ),
                    ],
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }
}

/// Five stars, filled to [value] (halves shown).
class Stars extends StatelessWidget {
  const Stars({super.key, required this.value, this.size = 18});

  final double value;
  final double size;

  @override
  Widget build(BuildContext context) {
    final color = context.colors.pop;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 1; i <= 5; i++)
          Icon(
            value >= i - 0.25
                ? Icons.star_rounded
                : value >= i - 0.75
                ? Icons.star_half_rounded
                : Icons.star_outline_rounded,
            size: size,
            color: color,
          ),
      ],
    );
  }
}

String _monthShort(String month) {
  final d = parseDay('$month-01');
  return d == null ? month : DateFormat('MMM').format(d);
}

String _monthLong(String month) {
  final d = parseDay('$month-01');
  return d == null ? month : DateFormat('MMM y').format(d);
}

/// Deliveries per month for the months given (the server sends newest first;
/// the chart reads oldest to newest).
class MonthlyChart extends StatelessWidget {
  const MonthlyChart({super.key, required this.months});

  final List<MonthRow> months;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final ordered = months.reversed.toList();
    final top = ordered.fold<int>(0, (m, r) => math.max(m, r.delivered));
    return SizedBox(
      key: const Key('monthly-chart'),
      height: 190,
      child: BarChart(
        BarChartData(
          maxY: math.max(top, 5) * 1.2,
          alignment: BarChartAlignment.spaceAround,
          gridData: FlGridData(
            drawVerticalLine: false,
            getDrawingHorizontalLine: (_) =>
                FlLine(color: c.line, strokeWidth: 1),
          ),
          borderData: FlBorderData(show: false),
          barTouchData: BarTouchData(
            touchTooltipData: BarTouchTooltipData(
              getTooltipColor: (_) => c.ink,
              getTooltipItem: (group, _, rod, _) => BarTooltipItem(
                '${_monthLong(ordered[group.x].month)}\n${rod.toY.round()} delivered',
                TextStyle(
                  color: c.bg,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
          titlesData: FlTitlesData(
            topTitles: const AxisTitles(),
            rightTitles: const AxisTitles(),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 30,
                getTitlesWidget: (v, meta) =>
                    v == meta.max || v != v.roundToDouble()
                    ? const SizedBox.shrink()
                    : SideTitleWidget(
                        meta: meta,
                        child: Text(
                          '${v.round()}',
                          style: TextStyle(color: c.muted, fontSize: 10),
                        ),
                      ),
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 28,
                getTitlesWidget: (v, meta) {
                  final i = v.round();
                  if (i < 0 || i >= ordered.length) {
                    return const SizedBox.shrink();
                  }
                  return SideTitleWidget(
                    meta: meta,
                    child: SizedBox(
                      width: 26,
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Text(
                          _monthShort(ordered[i].month),
                          style: TextStyle(color: c.muted, fontSize: 10),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
          ),
          barGroups: [
            for (var i = 0; i < ordered.length; i++)
              BarChartGroupData(
                x: i,
                barRods: [
                  BarChartRodData(
                    toY: ordered[i].delivered.toDouble(),
                    width: 14,
                    color: i == ordered.length - 1 ? c.accent : c.blue,
                    borderRadius: const BorderRadius.vertical(
                      top: Radius.circular(4),
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

/// The monthly report as a table, newest first.
class MonthlyTable extends StatefulWidget {
  const MonthlyTable({
    super.key,
    required this.months,
    required this.showMoney,
  });

  final List<MonthRow> months;
  final bool showMoney;

  @override
  State<MonthlyTable> createState() => _MonthlyTableState();
}

class _MonthlyTableState extends State<MonthlyTable> {
  final _scroll = ScrollController();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  List<MonthRow> get months => widget.months;
  bool get showMoney => widget.showMoney;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final earnings = showMoney && months.any((m) => m.earnings != null);
    DataColumn col(String t, {bool numeric = true}) => DataColumn(
      numeric: numeric,
      label: Text(
        t,
        style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13),
      ),
    );
    DataCell cell(String t, {bool bold = false}) => DataCell(
      Text(
        t,
        style: dataStyle(
          context,
          size: 13,
          weight: bold ? FontWeight.w800 : FontWeight.w500,
        ),
      ),
    );
    final table = Container(
      key: const Key('monthly-table'),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: Scrollbar(
        controller: _scroll,
        thumbVisibility: true,
        child: SingleChildScrollView(
          controller: _scroll,
          scrollDirection: Axis.horizontal,
          child: DataTable(
            columnSpacing: 18,
            horizontalMargin: 14,
            headingRowHeight: 44,
            dataRowMinHeight: 42,
            dataRowMaxHeight: 46,
            columns: [
              col('Month', numeric: false),
              col('Delivered'),
              col('Failed'),
              col('Cancelled'),
              col('Accepted'),
              col('Avg time'),
              col('Online'),
              if (earnings) col('Earned'),
            ],
            rows: [
              for (final m in months)
                DataRow(
                  key: ValueKey(m.month),
                  cells: [
                    DataCell(
                      Text(
                        _monthLong(m.month),
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 13.5,
                        ),
                      ),
                    ),
                    cell('${m.delivered}', bold: true),
                    cell('${m.failed}'),
                    cell('${m.cancelled}'),
                    cell(percentText(m.acceptanceRate)),
                    cell(minutesText(m.avgDeliverMin)),
                    cell(hoursText(m.onlineHours)),
                    if (earnings)
                      cell(m.earnings == null ? '—' : money(m.earnings!)),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        table,
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
          child: Row(
            children: [
              Icon(Icons.swipe_rounded, size: 16, color: c.muted),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  'Swipe the table sideways for more columns',
                  key: const Key('monthly-table-hint'),
                  style: TextStyle(color: c.muted, fontSize: 12.5),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
