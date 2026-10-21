import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/stats.dart';
import '../../theme/app_theme.dart';

String _axisLabel(String date, String granularity) {
  final d = DateTime.tryParse(granularity == 'month' ? '$date-01' : (granularity == 'year' ? '$date-01-01' : date));
  if (d == null) return date;
  return switch (granularity) {
    'month' => DateFormat('MMM').format(d),
    'year' => DateFormat('y').format(d),
    _ => DateFormat('d MMM').format(d),
  };
}

/// §2.1 — sales day by day, as a line.
class SalesLineChart extends StatelessWidget {
  const SalesLineChart({super.key, required this.points});
  final List<SeriesPoint> points;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final maxY = points.fold<int>(0, (m, p) => p.sales > m ? p.sales : m);
    final step = (points.length / 4).ceil().clamp(1, 1 << 20);
    return SizedBox(
      height: 180,
      child: LineChart(LineChartData(
        minY: 0,
        maxY: maxY == 0 ? 1 : maxY * 1.15,
        gridData: FlGridData(
          drawVerticalLine: false,
          getDrawingHorizontalLine: (_) => FlLine(color: c.line, strokeWidth: 1),
        ),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(),
          rightTitles: const AxisTitles(),
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 52,
              getTitlesWidget: (v, meta) => v == meta.max
                  ? const SizedBox.shrink()
                  : Text(rupees(v), style: TextStyle(fontSize: 10, color: c.muted)),
            ),
          ),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              interval: 1,
              getTitlesWidget: (v, _) {
                final i = v.round();
                if (i < 0 || i >= points.length || i % step != 0) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(_axisLabel(points[i].date, 'day'), style: TextStyle(fontSize: 10, color: c.muted)),
                );
              },
            ),
          ),
        ),
        lineTouchData: LineTouchData(
          touchTooltipData: LineTouchTooltipData(
            getTooltipItems: (spots) => [
              for (final s in spots)
                LineTooltipItem('${_axisLabel(points[s.x.round()].date, 'day')}\n${rupees(s.y)}',
                    TextStyle(color: c.onAccent, fontSize: 12, fontWeight: FontWeight.w600)),
            ],
          ),
        ),
        lineBarsData: [
          LineChartBarData(
            spots: [for (var i = 0; i < points.length; i++) FlSpot(i.toDouble(), points[i].sales.toDouble())],
            isCurved: false,
            color: c.accent,
            barWidth: 2.5,
            dotData: FlDotData(show: points.length <= 31),
            belowBarData: BarAreaData(show: true, color: c.accent.withValues(alpha: 0.12)),
          ),
        ],
      )),
    );
  }
}

/// §2.5 — orders per bar (day, or month for a year), cancelled stacked on top.
class OrdersBarChart extends StatelessWidget {
  const OrdersBarChart({super.key, required this.points, required this.granularity});
  final List<SeriesPoint> points;
  final String granularity;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final maxY = points.fold<int>(0, (m, p) => p.orders + p.cancelled > m ? p.orders + p.cancelled : m);
    final step = (points.length / 6).ceil().clamp(1, 1 << 20);
    return SizedBox(
      height: 160,
      child: BarChart(BarChartData(
        maxY: maxY == 0 ? 1 : maxY * 1.15,
        gridData: FlGridData(
          drawVerticalLine: false,
          getDrawingHorizontalLine: (_) => FlLine(color: c.line, strokeWidth: 1),
        ),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(),
          rightTitles: const AxisTitles(),
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 30,
              getTitlesWidget: (v, meta) => v == meta.max || v != v.roundToDouble()
                  ? const SizedBox.shrink()
                  : Text(count(v), style: TextStyle(fontSize: 10, color: c.muted)),
            ),
          ),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              getTitlesWidget: (v, _) {
                final i = v.round();
                if (i < 0 || i >= points.length || i % step != 0) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(_axisLabel(points[i].date, granularity), style: TextStyle(fontSize: 10, color: c.muted)),
                );
              },
            ),
          ),
        ),
        barGroups: [
          for (var i = 0; i < points.length; i++)
            BarChartGroupData(x: i, barRods: [
              BarChartRodData(
                toY: (points[i].orders + points[i].cancelled).toDouble(),
                width: points.length > 20 ? 6 : 12,
                borderRadius: BorderRadius.circular(3),
                rodStackItems: [
                  BarChartRodStackItem(0, points[i].orders.toDouble(), c.accent),
                  BarChartRodStackItem(points[i].orders.toDouble(), (points[i].orders + points[i].cancelled).toDouble(),
                      c.muted.withValues(alpha: 0.45)),
                ],
                color: c.accent,
              ),
            ]),
        ],
      )),
    );
  }
}
