import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/finance.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'finance_figures.dart';

/// Where the overview's numbers lead: one list per §7 tracking item.
const financeLinks = <(String, String, IconData)>[
  ('Vendor dues, shop by shop', '/finance/vendor-dues', Icons.storefront_outlined),
  ('Rider dues, rider by rider', '/finance/rider-dues', Icons.two_wheeler_outlined),
  ('Failed and delayed, one by one', '/finance/issues', Icons.report_gmailerrorred_outlined),
  ('Settlement history', '/finance/settlements', Icons.history),
  ('Rider payouts', '/finance/rider-payouts', Icons.payments_outlined),
  ('Refunds', '/finance/refunds', Icons.undo),
  ('Reconciliation', '/finance/reconciliation', Icons.balance_outlined),
];

/// The figures, the daily chart and the links. Two columns from 840 dp.
class FinanceOverviewBody extends StatelessWidget {
  const FinanceOverviewBody({super.key, required this.overview, this.onExport});
  final FinanceOverview overview;
  final VoidCallback? onExport;

  @override
  Widget build(BuildContext context) {
    final sales = _Group(title: 'Sales and commission', figures: salesFigures(overview));
    final pay = _Group(title: 'Payments', figures: paymentFigures(overview));
    return LayoutBuilder(builder: (context, box) {
      final wide = box.maxWidth >= 840;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (wide)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [Expanded(child: sales), const SizedBox(width: 16), Expanded(child: pay)],
            )
          else ...[sales, pay],
          if (overview.series.isNotEmpty) ...[
            const GroupLabel('Day by day'),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 16, 0),
              child: FinanceLineChart(days: overview.series),
            ),
          ],
          const GroupLabel('Payment tracking'),
          for (final (label, route, icon) in financeLinks)
            ListTile(
              key: Key('finance-link-$route'),
              leading: Icon(icon, color: context.colors.muted),
              title: Text(label),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push(route),
            ),
          if (onExport != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
              child: OutlinedButton.icon(
                key: const Key('finance-export-daily'),
                onPressed: onExport,
                icon: const Icon(Icons.download_outlined),
                label: const Text('Export date-wise report'),
              ),
            ),
        ],
      );
    });
  }
}

class _Group extends StatelessWidget {
  const _Group({required this.title, required this.figures});
  final String title;
  final List<FinanceFigure> figures;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          GroupLabel(title),
          for (final f in figures) FigureRow(figure: f),
        ],
      );
}

/// One figure: words left, number right in the figures font, detail below.
/// A hairline between rows, not a box around each.
class FigureRow extends StatelessWidget {
  const FigureRow({super.key, required this.figure});
  final FinanceFigure figure;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final f = figure;
    final valueColor = switch (f.tone) {
      FigureTone.critical => c.deal,
      FigureTone.warning => c.amberText,
      FigureTone.normal => c.ink,
    };
    final row = Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.line))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(f.label, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: c.ink)),
              ),
              Text(f.value, style: dataStyle(context, size: 16, weight: FontWeight.w800).copyWith(color: valueColor)),
              if (f.route != null) Icon(Icons.chevron_right, size: 18, color: c.muted),
            ],
          ),
          if (f.detail != null && f.detail!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(f.detail!, style: TextStyle(fontSize: 12, color: c.muted)),
            ),
        ],
      ),
    );
    if (f.route == null) return row;
    return InkWell(key: Key('figure-${f.label}'), onTap: () => context.push(f.route!), child: row);
  }
}

/// Customer paid and net sales, day by day.
class FinanceLineChart extends StatelessWidget {
  const FinanceLineChart({super.key, required this.days});
  final List<FinanceDay> days;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final maxY = days.fold<int>(0, (m, d) => d.customerPaid > m ? d.customerPaid : m);
    final step = (days.length / 4).ceil().clamp(1, 1 << 20);
    LineChartBarData line(List<int> ys, Color color) => LineChartBarData(
          spots: [for (var i = 0; i < ys.length; i++) FlSpot(i.toDouble(), ys[i].toDouble())],
          color: color,
          barWidth: 2.5,
          dotData: FlDotData(show: days.length <= 2),
          isCurved: false,
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
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
                  reservedSize: 56,
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
                    if (i < 0 || i >= days.length || i % step != 0) return const SizedBox.shrink();
                    final d = DateTime.tryParse(days[i].date);
                    return Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(d == null ? days[i].date : DateFormat('d MMM').format(d),
                          style: TextStyle(fontSize: 10, color: c.muted)),
                    );
                  },
                ),
              ),
            ),
            lineBarsData: [
              line([for (final d in days) d.customerPaid], c.accent),
              line([for (final d in days) d.netSales], c.blue),
            ],
          )),
        ),
        Padding(
          padding: const EdgeInsets.only(left: 56, top: 6),
          child: Wrap(spacing: 14, children: [
            _Key(color: c.accent, text: 'Customers paid'),
            _Key(color: c.blue, text: 'Net sales'),
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
        const SizedBox(width: 5),
        Text(text, style: TextStyle(fontSize: 11.5, color: context.colors.muted)),
      ]);
}
