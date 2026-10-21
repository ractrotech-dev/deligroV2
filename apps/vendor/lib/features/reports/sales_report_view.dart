import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/documents.dart';
import '../../core/export.dart';
import '../../core/format.dart';
import '../../models/money.dart';
import '../../state/money.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';
import '../documents/document_screen.dart';

/// The sales report (requirements §5): every order in a date range with its
/// sale, charges and earnings, filtered by status, payment and settlement,
/// downloadable as PDF, Excel or CSV.
class SalesReportView extends ConsumerStatefulWidget {
  const SalesReportView({super.key});

  @override
  ConsumerState<SalesReportView> createState() => _SalesReportViewState();
}

/// IST today, so the default range matches the server's.
DateTime _istToday() {
  final ist = DateTime.now().toUtc().add(const Duration(minutes: 330));
  return DateTime(ist.year, ist.month, ist.day);
}

class _SalesReportViewState extends ConsumerState<SalesReportView> {
  late ReportQuery _q = _range('this_month');
  String _preset = 'this_month';

  static ReportQuery _range(String preset, [ReportQuery? base]) {
    final t = _istToday();
    final (from, to) = switch (preset) {
      'today' => (t, t),
      'yesterday' => (t.subtract(const Duration(days: 1)), t.subtract(const Duration(days: 1))),
      'last_7' => (t.subtract(const Duration(days: 6)), t),
      'last_month' => (DateTime(t.year, t.month - 1, 1), DateTime(t.year, t.month, 0)),
      _ => (DateTime(t.year, t.month, 1), t),
    };
    return (base ?? const ReportQuery(from: '', to: '')).copyWith(from: isoDate(from), to: isoDate(to));
  }

  String get _filterLabel => [
    switch (_q.status) {
      'completed' => 'Completed orders',
      'cancelled' => 'Cancelled orders',
      'in_progress' => 'Orders in progress',
      _ => 'All orders',
    },
    if (_q.payment != 'all') _q.payment == 'cod' ? 'cash' : 'online',
    if (_q.settled != 'all') _q.settled,
  ].join(' · ');

  Future<void> _pickCustom() async {
    final t = _istToday();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(t.year - 2, 1, 1),
      lastDate: t,
      initialDateRange: DateTimeRange(start: DateTime.parse(_q.from), end: DateTime.parse(_q.to)),
    );
    if (picked == null) return;
    if (picked.end.difference(picked.start).inDays > 365) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Pick a range of a year or less.')));
      }
      return;
    }
    setState(() {
      _preset = 'custom';
      _q = _q.copyWith(from: isoDate(picked.start), to: isoDate(picked.end));
    });
  }

  ExportTable _table(SalesReport r) => ExportTable(
    title: 'Sales ${r.from} to ${r.to}',
    headers: reportHeaders(r.includesMoney),
    rows: [for (final row in r.rows) reportCells(row, r.includesMoney)],
  );

  Future<void> _download(SalesReport r, String kind) async {
    final name = 'deligro-sales-${r.from}-to-${r.to}';
    if (kind == 'pdf') {
      await context.push(
        '/document',
        extra: DocumentRequest(
          title: 'Sales report',
          fileName: '$name.pdf',
          build: () async => reportPdf(r, _filterLabel, await DocFonts.load()),
        ),
      );
      return;
    }
    await runWrite(context, ref, () async {
      if (kind == 'xlsx') await shareBytes(toXlsx(_table(r)), '$name.xlsx', xlsxMime);
      if (kind == 'csv') await shareBytes(toCsv(_table(r)), '$name.csv', csvMime);
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final async = ref.watch(reportProvider(_q));
    final report = async.value;

    Widget chip(String value, String label) => Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(label),
        selected: _preset == value,
        onSelected: (_) => value == 'custom'
            ? _pickCustom()
            : setState(() {
                _preset = value;
                _q = _range(value, _q);
              }),
      ),
    );

    Widget menu<T>(String label, String current, Map<String, String> options, void Function(String) onPick) =>
        PopupMenuButton<String>(
          onSelected: onPick,
          itemBuilder: (_) => [
            for (final e in options.entries)
              CheckedPopupMenuItem(value: e.key, checked: current == e.key, child: Text(e.value)),
          ],
          child: Chip(
            label: Text(current == 'all' ? label : options[current]!),
            avatar: Icon(Icons.filter_list_rounded, size: 16, color: current == 'all' ? c.muted : c.accentInk),
            side: BorderSide(color: current == 'all' ? c.line : c.accent),
          ),
        );

    return RefreshIndicator(
      onRefresh: () => ref.refresh(reportProvider(_q).future),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          SizedBox(
            height: 52,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 2),
              children: [
                chip('today', 'Today'),
                chip('yesterday', 'Yesterday'),
                chip('last_7', 'Last 7 days'),
                chip('this_month', 'This month'),
                chip('last_month', 'Last month'),
                chip('custom', _preset == 'custom' ? reportRangeLabel(_q.from, _q.to) : 'Custom…'),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
            child: Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                menu('Status', _q.status, const {
                  'all': 'All statuses',
                  'completed': 'Completed',
                  'in_progress': 'In progress',
                  'cancelled': 'Cancelled',
                }, (v) => setState(() => _q = _q.copyWith(status: v))),
                menu('Payment', _q.payment, const {
                  'all': 'Any payment',
                  'cod': 'Cash',
                  'online': 'Online',
                }, (v) => setState(() => _q = _q.copyWith(payment: v))),
                if (report?.includesMoney ?? true)
                  menu('Settlement', _q.settled, const {
                    'all': 'Any settlement',
                    'settled': 'Settled',
                    'unsettled': 'Unsettled',
                  }, (v) => setState(() => _q = _q.copyWith(settled: v))),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 10, 12, 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    reportRangeLabel(_q.from, _q.to),
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15),
                  ),
                ),
                if (report != null && report.rows.isNotEmpty)
                  PopupMenuButton<String>(
                    onSelected: (k) => _download(report, k),
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'pdf', child: Text('PDF (view, print, share)')),
                      PopupMenuItem(value: 'xlsx', child: Text('Excel')),
                      PopupMenuItem(value: 'csv', child: Text('CSV')),
                    ],
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                      child: Row(
                        children: [
                          Icon(Icons.download_rounded, color: c.accentInk, size: 20),
                          const SizedBox(width: 4),
                          Text(
                            'Download',
                            style: TextStyle(color: c.accentInk, fontWeight: FontWeight.w700),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          switch (async) {
            AsyncData(:final value) => _Results(r: value),
            AsyncError(:final error) => SizedBox(
              height: 300,
              child: LoadFailed(error: error, onRetry: () => ref.invalidate(reportProvider(_q))),
            ),
            _ => const Padding(
              padding: EdgeInsets.all(48),
              child: Center(child: CircularProgressIndicator()),
            ),
          },
        ],
      ),
    );
  }
}

class _Results extends StatelessWidget {
  const _Results({required this.r});

  final SalesReport r;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final t = r.totals;
    final figures = <(String, String)>[
      ('Gross sales', rupees(t.grossSales)),
      ('Net sales', rupees(t.netSales)),
      ('Orders', '${t.orders}'),
      if (t.earnings != null) ('Earnings', rupees(t.earnings!)),
      if (t.charges != null) ('Deligro charges', rupees(t.charges!)),
      ('Discounts given', rupees(t.vendorDiscounts)),
      ('Refunds', rupees(t.refunds)),
      ('Completed / cancelled', '${t.completed} / ${t.cancelled}'),
      if (t.settled != null) ('Settled', rupees(t.settled!)),
      if (t.unsettled != null) ('Not yet settled', rupees(t.unsettled!)),
      ('Cash / online', '${t.codOrders} / ${t.onlineOrders}'),
      if (t.cancelled > 0) ('Cancelled value', rupees(t.cancelledValue)),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: TwoUp(
            gap: 8,
            children: [
              for (final (k, v) in figures)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: c.surface,
                    borderRadius: BorderRadius.circular(radiusBlock),
                    border: Border.all(color: c.line),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        k,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: c.muted, fontSize: 12),
                      ),
                      FittedBox(
                        child: Text(v, style: dataStyle(context, size: 16, weight: FontWeight.w800)),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        if (!r.includesMoney)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
            child: Text(
              'Deligro has switched earnings off for your shop, so the report shows sales only.',
              style: TextStyle(color: c.muted, fontSize: 12.5),
            ),
          ),
        SectionHeading('${r.rows.length} orders'),
        if (r.rows.isEmpty)
          Padding(
            padding: const EdgeInsets.all(32),
            child: Text(
              'No orders match.',
              textAlign: TextAlign.center,
              style: TextStyle(color: c.muted),
            ),
          ),
        for (final row in r.rows)
          ListTile(
            dense: true,
            contentPadding: const EdgeInsets.symmetric(horizontal: 20),
            onTap: () => context.push('/orders/${row.orderId}'),
            title: Text(row.code, style: dataStyle(context, size: 14, weight: FontWeight.w800)),
            subtitle: Text(
              '${placedAt(row.createdAt)} · ${stageWord(row.stage)} · ${row.paymentMethod == 'online' ? 'Online' : 'Cash'}'
              '${row.settlement == null ? '' : ' · ${row.settlement == 'settled' ? 'Settled' : 'Unsettled'}'}',
              style: TextStyle(color: c.muted, fontSize: 12.5),
            ),
            trailing: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  rupees(row.sale),
                  style: dataStyle(context, size: 14, weight: FontWeight.w800).copyWith(
                    decoration: row.stage == 'cancelled' ? TextDecoration.lineThrough : null,
                    color: row.stage == 'cancelled' ? c.muted : null,
                  ),
                ),
                if (row.earnings != null)
                  Text('earned ${rupees(row.earnings!)}', style: TextStyle(color: c.green, fontSize: 11.5)),
              ],
            ),
          ),
      ],
    );
  }
}
