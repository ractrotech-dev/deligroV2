import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/analytics.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

typedef AnalyticsQuery = ({String granularity, String? from, String? to});

final analyticsProvider = FutureProvider.autoDispose.family<Analytics, AnalyticsQuery>((ref, q) async {
  ref.watch(activeShopSlugProvider);
  final res = await ref
      .watch(apiProvider)
      .get('/api/vendor/analytics', query: {'granularity': q.granularity, 'from': ?q.from, 'to': ?q.to});
  return Analytics.fromJson(res);
});

/// Sales statistics and growth (requirements §2).
class AnalyticsView extends ConsumerStatefulWidget {
  const AnalyticsView({super.key});

  @override
  ConsumerState<AnalyticsView> createState() => _AnalyticsViewState();
}

class _AnalyticsViewState extends ConsumerState<AnalyticsView> {
  String _granularity = 'day';
  DateTimeRange? _custom;

  AnalyticsQuery get _query => (
    granularity: _granularity,
    from: _granularity == 'custom' && _custom != null ? isoDate(_custom!.start) : null,
    to: _granularity == 'custom' && _custom != null ? isoDate(_custom!.end) : null,
  );

  Future<void> _pickRange() async {
    final now = DateTime.now();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 3),
      lastDate: now,
      initialDateRange: _custom ?? DateTimeRange(start: now.subtract(const Duration(days: 13)), end: now),
    );
    if (picked != null) {
      setState(() {
        _custom = picked;
        _granularity = 'custom';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final result = ref.watch(analyticsProvider(_query));
    final labels = {'day': 'Day', 'week': 'Week', 'month': 'Month', 'year': 'Year', 'custom': 'Custom'};

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(analyticsProvider(_query)),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final g in labels.keys) ...[
                  ChoiceChip(
                    label: Text(labels[g]!),
                    selected: _granularity == g,
                    showCheckmark: false,
                    selectedColor: c.ink,
                    labelStyle: TextStyle(color: _granularity == g ? c.bg : c.ink, fontWeight: FontWeight.w700),
                    onSelected: (_) => g == 'custom' ? _pickRange() : setState(() => _granularity = g),
                  ),
                  const SizedBox(width: 8),
                ],
              ],
            ),
          ),
          const SizedBox(height: 10),
          ...result.when(
            loading: () => [const SizedBox(height: 260, child: Center(child: CircularProgressIndicator()))],
            error: (e, _) => [
              Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  e is ApiException ? e.friendly() : 'Statistics couldn\'t load.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: c.muted),
                ),
              ),
            ],
            data: (a) => _figures(context, a),
          ),
        ],
      ),
    );
  }

  List<Widget> _figures(BuildContext context, Analytics a) {
    final c = context.colors;
    const locale = 'en_IN';
    final range = '${DateFormat('d MMM y', locale).format(a.from)} – ${DateFormat('d MMM y', locale).format(a.to)}';
    String hour(int h) => DateFormat('h a').format(DateTime(2026, 1, 1, h));
    return [
      InkWell(
        onTap: _pickRange,
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            children: [
              Icon(Icons.calendar_month_rounded, size: 18, color: c.muted),
              const SizedBox(width: 8),
              Flexible(
                child: Text(range, style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
            ],
          ),
        ),
      ),
      _Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Total sales',
              style: TextStyle(color: c.muted, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 2),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Text(rupees(a.sales), style: dataStyle(context, size: 26, weight: FontWeight.w800)),
                ),
                _Change(a.salesChange, note: 'vs previous period'),
              ],
            ),
            const SizedBox(height: 14),
            SizedBox(height: 180, child: _SalesChart(a: a)),
            const SizedBox(height: 8),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: 16,
              runSpacing: 4,
              children: [
                _Legend(color: c.accent, label: 'This period', bar: true),
                _Legend(color: c.blue, label: 'Previous period'),
              ],
            ),
          ],
        ),
      ),
      Row(
        children: [
          Expanded(
            child: _Card(
              child: _Stat(label: 'Total orders', value: '${a.orders}', change: a.ordersChange),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: _Card(
              child: _Stat(
                label: 'Avg. order value',
                value: rupees(a.averageOrderValue),
                change: a.averageOrderValueChange,
              ),
            ),
          ),
        ],
      ),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: _Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Best performing days', style: const TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  if (a.bestDays.isEmpty)
                    Text('—', style: TextStyle(color: c.muted))
                  else
                    for (final d in a.bestDays)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                DateFormat('EEE d MMM', locale).format(d.day),
                                style: const TextStyle(fontSize: 13),
                              ),
                            ),
                            Text(
                              rupees(d.sales),
                              style: dataStyle(context, size: 13, weight: FontWeight.w700).copyWith(color: c.green),
                            ),
                          ],
                        ),
                      ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: _Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Peak hours', style: const TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Icon(Icons.schedule_rounded, size: 18, color: c.accent),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          a.peak == null ? '—' : '${hour(a.peak!.fromHour)} – ${hour(a.peak!.toHour)}',
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  SizedBox(height: 40, child: _HourBars(hours: a.hours)),
                ],
              ),
            ),
          ),
        ],
      ),
      _RankCard(
        title: 'Best sellers',
        rows: a.bestSellers,
        empty: 'No dishes sold in this period.',
        qty: (n) => '$n sold',
      ),
      _RankCard(
        title: 'Slow-moving dishes',
        rows: a.slowMovers,
        empty: 'No dishes on the menu.',
        qty: (n) => n == 0 ? 'not sold' : '$n sold',
        warn: true,
      ),
    ];
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: child,
    );
  }
}

class _Change extends StatelessWidget {
  const _Change(this.change, {this.note});
  final double? change;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    if (change == null) return const SizedBox.shrink();
    final up = change! >= 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(
          '${up ? '↑' : '↓'} ${change!.abs().toStringAsFixed(change!.abs() < 10 ? 1 : 0)}%',
          style: TextStyle(color: up ? c.green : c.deal, fontWeight: FontWeight.w800),
        ),
        if (note != null) Text(note!, style: TextStyle(color: c.muted, fontSize: 11)),
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, required this.change});
  final String label;
  final String value;
  final double? change;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 4),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(value, style: dataStyle(context, size: 20, weight: FontWeight.w800)),
        ),
        const SizedBox(height: 2),
        Align(alignment: Alignment.centerLeft, child: _Change(change)),
      ],
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend({required this.color, required this.label, this.bar = false});
  final Color color;
  final String label;
  final bool bar;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Container(
        width: bar ? 10 : 14,
        height: bar ? 10 : 3,
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2)),
      ),
      const SizedBox(width: 6),
      Text(label, style: TextStyle(color: context.colors.muted, fontSize: 12)),
    ],
  );
}

/// This period as bars, the previous as a line, per bucket.
class _SalesChart extends StatelessWidget {
  const _SalesChart({required this.a});
  final Analytics a;

  String _label(DateTime d) {
    const locale = 'en_IN';
    return switch (a.unit) {
      'day' => DateFormat('d MMM', locale).format(d),
      'week' => DateFormat('d MMM', locale).format(d),
      'month' => DateFormat('MMM', locale).format(d),
      _ => DateFormat('y', locale).format(d),
    };
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final b = a.buckets;
    final maxY = [for (final x in b) x.sales > x.prevSales ? x.sales : x.prevSales]
        .fold<int>(0, (m, v) => v > m ? v : m);
    // Four gridlines on round numbers: the step is 1, 2, 2.5 or 5 × 10ⁿ.
    final step = _niceStep(maxY == 0 ? 100 : maxY / 4);
    final top = step * ((maxY / step).floor() + 1).clamp(4, 1000);
    final every = (b.length / 6).ceil().clamp(1, 1000);
    final axis = FlTitlesData(
      topTitles: const AxisTitles(),
      rightTitles: const AxisTitles(),
      leftTitles: AxisTitles(
        sideTitles: SideTitles(
          showTitles: true,
          reservedSize: 40,
          interval: step,
          getTitlesWidget: (v, _) => Text(
            v >= 1000 ? '${(v / 1000).toStringAsFixed(v % 1000 == 0 ? 0 : 1)}k' : v.toStringAsFixed(0),
            style: TextStyle(color: c.muted, fontSize: 10),
          ),
        ),
      ),
      bottomTitles: AxisTitles(
        sideTitles: SideTitles(
          showTitles: true,
          reservedSize: 22,
          getTitlesWidget: (v, _) {
            final i = v.round();
            if (i < 0 || i >= b.length || i % every != 0) return const SizedBox.shrink();
            return Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(_label(b[i].start), style: TextStyle(color: c.muted, fontSize: 10)),
            );
          },
        ),
      ),
    );
    final grid = FlGridData(
      drawVerticalLine: false,
      horizontalInterval: step,
      getDrawingHorizontalLine: (_) => FlLine(color: c.line, strokeWidth: 1),
    );

    return Stack(
      children: [
        BarChart(
          BarChartData(
            maxY: top,
            minY: 0,
            gridData: grid,
            borderData: FlBorderData(show: false),
            titlesData: axis,
            barTouchData: BarTouchData(enabled: false),
            barGroups: [
              for (var i = 0; i < b.length; i++)
                BarChartGroupData(
                  x: i,
                  barRods: [
                    BarChartRodData(
                      toY: b[i].sales.toDouble(),
                      color: c.accent,
                      width: b.length > 20 ? 5 : 12,
                      borderRadius: const BorderRadius.vertical(top: Radius.circular(3)),
                    ),
                  ],
                ),
            ],
          ),
        ),
        // The previous period, on the same axes, without its own labels.
        IgnorePointer(
          child: LineChart(
            LineChartData(
              maxY: top,
              minY: 0,
              minX: -0.5,
              maxX: b.length - 0.5,
              gridData: const FlGridData(show: false),
              borderData: FlBorderData(show: false),
              titlesData: FlTitlesData(
                topTitles: const AxisTitles(),
                rightTitles: const AxisTitles(),
                leftTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 40,
                    getTitlesWidget: (_, _) => const SizedBox.shrink(),
                  ),
                ),
                bottomTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 22,
                    getTitlesWidget: (_, _) => const SizedBox.shrink(),
                  ),
                ),
              ),
              lineTouchData: const LineTouchData(enabled: false),
              lineBarsData: [
                LineChartBarData(
                  spots: [for (var i = 0; i < b.length; i++) FlSpot(i.toDouble(), b[i].prevSales.toDouble())],
                  isCurved: true,
                  color: c.blue,
                  barWidth: 2,
                  dotData: FlDotData(show: b.length <= 12),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

double _niceStep(double raw) {
  var magnitude = 1.0;
  while (magnitude * 10 <= raw) {
    magnitude *= 10;
  }
  for (final m in [1.0, 2.0, 2.5, 5.0, 10.0]) {
    if (raw <= m * magnitude) return m * magnitude;
  }
  return 10 * magnitude;
}

class _HourBars extends StatelessWidget {
  const _HourBars({required this.hours});
  final List<({int hour, int sales, int orders})> hours;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final max = hours.fold<int>(0, (m, h) => h.sales > m ? h.sales : m);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (final h in hours)
          Expanded(
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: .6),
              height: max == 0 ? 2 : 2 + 38 * h.sales / max,
              decoration: BoxDecoration(
                color: h.sales == max && max > 0 ? c.accent : c.accent.withValues(alpha: .35),
                borderRadius: BorderRadius.circular(1.5),
              ),
            ),
          ),
      ],
    );
  }
}

class _RankCard extends StatelessWidget {
  const _RankCard({required this.title, required this.rows, required this.empty, required this.qty, this.warn = false});
  final String title;
  final List<({String name, int qty, int revenue})> rows;
  final String empty;
  final String Function(int) qty;
  final bool warn;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          if (rows.isEmpty)
            Text(empty, style: TextStyle(color: c.muted))
          else
            for (var i = 0; i < rows.length; i++)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Row(
                  children: [
                    SizedBox(
                      width: 22,
                      child: Text('${i + 1}', style: dataStyle(context, size: 13).copyWith(color: c.muted)),
                    ),
                    Expanded(
                      child: Text(
                        rows[i].name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      qty(rows[i].qty),
                      style: TextStyle(
                        color: warn && rows[i].qty == 0 ? c.deal : c.muted,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(width: 10),
                    SizedBox(
                      width: 70,
                      child: Text(
                        rupees(rows[i].revenue),
                        textAlign: TextAlign.right,
                        style: dataStyle(context, size: 13),
                      ),
                    ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}
