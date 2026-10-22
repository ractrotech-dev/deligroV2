import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/support_ops.dart';
import '../../state/support.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';

/// Support metrics (§11.10, §11.11): how fast tickets get a first answer and
/// get resolved, created against resolved by day, and the problems that keep
/// coming back — each row opening the queue, vendor, rider or order.
class SupportMetricsScreen extends ConsumerStatefulWidget {
  const SupportMetricsScreen({super.key});

  @override
  ConsumerState<SupportMetricsScreen> createState() => _SupportMetricsScreenState();
}

class _SupportMetricsScreenState extends ConsumerState<SupportMetricsScreen> {
  int? _days = 30;
  DateTimeRange? _custom;

  MetricsQuery _query(String? zoneId) {
    final today = istToday();
    if (_days == null && _custom != null) return (from: _custom!.start, to: _custom!.end, zoneId: zoneId);
    return (from: today.subtract(Duration(days: (_days ?? 30) - 1)), to: today, zoneId: zoneId);
  }

  Future<void> _pickCustom() async {
    final today = istToday();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: today.subtract(const Duration(days: 365)),
      lastDate: today,
      initialDateRange: _custom,
    );
    if (picked != null && mounted) {
      setState(() {
        _days = null;
        _custom = picked;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final zone = ref.watch(activeZoneProvider);
    final q = _query(zone?.id);
    final value = ref.watch(ticketMetricsProvider(q));
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Support metrics'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: Column(
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: Row(children: [
              for (final d in const [7, 30, 90])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    key: Key('metrics-range-$d'),
                    label: Text('$d days'),
                    selected: _days == d,
                    onSelected: (_) => setState(() => _days = d),
                  ),
                ),
              ChoiceChip(
                key: const Key('metrics-range-custom'),
                label: Text(_custom == null || _days != null
                    ? 'Custom'
                    : '${DateFormat('d MMM').format(_custom!.start)} – ${DateFormat('d MMM').format(_custom!.end)}'),
                selected: _days == null,
                onSelected: (_) => _pickCustom(),
              ),
            ]),
          ),
          Expanded(
            child: AsyncView(
              value: value,
              onRetry: () => ref.invalidate(ticketMetricsProvider(q)),
              builder: (m) => RefreshIndicator(
                onRefresh: () async => ref.invalidate(ticketMetricsProvider(q)),
                child: _Body(metrics: m),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.metrics});
  final TicketMetrics metrics;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final m = metrics;
    final wide = MediaQuery.sizeOf(context).width >= 840;
    final figures = [
      ('first-response-avg', 'Average first response', minutesLabel(m.firstResponse.avgMinutes)),
      ('first-response-median', 'Median first response', minutesLabel(m.firstResponse.medianMinutes)),
      ('resolution-avg', 'Average resolution', minutesLabel(m.resolution.avgMinutes)),
      ('resolution-median', 'Median resolution', minutesLabel(m.resolution.medianMinutes)),
      ('created', 'Created', count(m.created)),
      ('resolved', 'Resolved', count(m.resolved)),
      ('reopened', 'Reopened', count(m.reopened)),
      ('over-sla', 'Open, no answer after 30 min', count(m.openOverSla)),
    ];
    Widget recurring(String title, List<RecurringRow> rows, String Function(RecurringRow)? route, {bool code = false}) =>
        _Recurring(title: title, rows: rows, route: route, showCode: code);
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
      children: [
        LayoutBuilder(builder: (context, box) {
          final cols = wide ? 4 : 2;
          final w = (box.maxWidth - 10 * (cols - 1)) / cols;
          return Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              for (final f in figures)
                Container(
                  key: Key('metric-${f.$1}'),
                  width: w,
                  constraints: const BoxConstraints(minHeight: 78),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: c.surface,
                    borderRadius: BorderRadius.circular(radiusBlock),
                    border: Border.all(color: c.line),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(f.$3, style: dataStyle(context, size: 19, weight: FontWeight.w700)),
                      const SizedBox(height: 4),
                      Text(f.$2, style: TextStyle(color: c.muted, fontSize: 12.5)),
                    ],
                  ),
                ),
            ],
          );
        }),
        const SizedBox(height: 18),
        Text('Created and resolved, by day', style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15)),
        const SizedBox(height: 10),
        if (m.daily.isEmpty) const EmptyLine('No tickets in this range.') else _DailyChart(days: m.daily),
        const SizedBox(height: 18),
        Text('Recurring problems', style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15)),
        const SizedBox(height: 6),
        recurring('Issue types', m.recurringCategories, (r) => '/more/support?category=${Uri.encodeQueryComponent(r.id)}'),
        recurring('Vendors', m.recurringVendors, (r) => '/more/vendors/${r.id}'),
        recurring('Riders', m.recurringRiders, (r) => '/more/riders/${r.id}', code: true),
        recurring('Zones', m.recurringZones, null),
        recurring('Orders with more than one ticket', m.recurringOrders, (r) => '/orders/${r.id}'),
        if (m.generatedAt != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text('Generated ${placedAt(m.generatedAt)}', style: TextStyle(color: c.muted, fontSize: 12)),
          ),
      ],
    );
  }
}

class _Recurring extends StatelessWidget {
  const _Recurring({required this.title, required this.rows, required this.route, this.showCode = false});
  final String title;
  final List<RecurringRow> rows;
  final String Function(RecurringRow)? route;
  final bool showCode;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
          const SizedBox(height: 6),
          if (rows.isEmpty)
            const EmptyLine('Nothing stands out.')
          else
            for (final r in rows)
              InkWell(
                key: Key('recurring-$title-${r.id}'),
                onTap: route == null ? null : () => GoRouter.maybeOf(context)?.push(route!(r)),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        Expanded(
                          child: Text(
                            showCode && r.code != null ? '${r.label} · ${r.code}' : r.label,
                            style: TextStyle(color: c.ink),
                          ),
                        ),
                        Text('${r.count}', style: dataStyle(context, size: 13)),
                        if (route != null) Icon(Icons.chevron_right, size: 18, color: c.muted),
                      ]),
                      if (r.share != null) ...[
                        const SizedBox(height: 4),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(3),
                          child: LinearProgressIndicator(
                            value: r.share!.clamp(0, 1).toDouble(),
                            minHeight: 5,
                            backgroundColor: c.line,
                            color: c.accent,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
        ],
      ),
    );
  }
}

class _DailyChart extends StatelessWidget {
  const _DailyChart({required this.days});
  final List<DailyTickets> days;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final maxY = days.fold<int>(1, (m, d) => [m, d.created, d.resolved].reduce((a, b) => a > b ? a : b));
    final step = (days.length / 4).ceil().clamp(1, 1 << 20);
    LineChartBarData line(List<int> ys, Color color) => LineChartBarData(
          spots: [for (var i = 0; i < ys.length; i++) FlSpot(i.toDouble(), ys[i].toDouble())],
          color: color,
          barWidth: 2.5,
          dotData: FlDotData(show: days.length <= 2),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          height: 170,
          child: LineChart(LineChartData(
            minY: 0,
            maxY: maxY * 1.2,
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
                  reservedSize: 28,
                  getTitlesWidget: (v, meta) => v == meta.max || v != v.roundToDouble()
                      ? const SizedBox.shrink()
                      : Text('${v.round()}', style: TextStyle(fontSize: 10, color: c.muted)),
                ),
              ),
              bottomTitles: AxisTitles(
                sideTitles: SideTitles(
                  showTitles: true,
                  interval: 1,
                  getTitlesWidget: (v, _) {
                    final i = v.round();
                    if (i < 0 || i >= days.length || i % step != 0) return const SizedBox.shrink();
                    return Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(DateFormat('d MMM').format(days[i].date), style: TextStyle(fontSize: 10, color: c.muted)),
                    );
                  },
                ),
              ),
            ),
            lineBarsData: [
              line([for (final d in days) d.created], c.accent),
              line([for (final d in days) d.resolved], c.green),
            ],
          )),
        ),
        Padding(
          padding: const EdgeInsets.only(left: 28, top: 6),
          child: Wrap(spacing: 14, children: [
            _Key(color: c.accent, text: 'Created'),
            _Key(color: c.green, text: 'Resolved'),
          ]),
        ),
      ],
    );
  }
}

class _Key extends StatelessWidget {
  const _Key({required this.color, required this.text});
  final Color color;
  final String text;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 10, height: 3, color: color),
        const SizedBox(width: 6),
        Text(text, style: TextStyle(fontSize: 12, color: context.colors.muted)),
      ]);
}
