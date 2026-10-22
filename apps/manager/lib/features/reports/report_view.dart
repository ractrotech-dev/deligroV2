import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/report_export.dart';
import '../../models/report.dart';
import '../../models/rider.dart' show ymd;
import '../../state/providers.dart';
import '../../state/reports.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import '../stats/stats_export.dart' show ReportFormat, periodWords;
import 'report_filters_sheet.dart';

typedef ReportSharer = Future<void> Function(ReportPayload report, ReportFormat format);

/// One report (§13): From and To, the kind's own filters, highlights, notes,
/// a paged table with the totals pinned under it, and export of every row to
/// CSV, Excel or PDF.
class ReportViewScreen extends ConsumerStatefulWidget {
  const ReportViewScreen({super.key, required this.kind, this.query, this.share});
  final String kind;

  /// `?from=&to=&zone=` (e.g. Finance → Export date-wise).
  final Uri? query;

  /// How a built report leaves the app; the share sheet by default.
  final ReportSharer? share;

  @override
  ConsumerState<ReportViewScreen> createState() => _ReportViewScreenState();
}

class _ReportViewScreenState extends ConsumerState<ReportViewScreen> {
  late ReportQuery _q;
  bool _exporting = false;

  @override
  void initState() {
    super.initState();
    final p = widget.query?.queryParameters ?? const {};
    final today = istToday();
    bool ok(String? s) => s != null && RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(s);
    _q = ReportQuery(
      kind: widget.kind,
      from: ok(p['from']) ? p['from']! : ymd(today.subtract(const Duration(days: 29))),
      to: ok(p['to']) ? p['to']! : ymd(today),
      zoneId: p['zone'] ?? ref.read(activeZoneProvider)?.id,
    );
  }

  Future<void> _pickDates() async {
    final today = istToday();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(today.year - 3),
      lastDate: today,
      initialDateRange: DateTimeRange(start: DateTime.parse(_q.from), end: DateTime.parse(_q.to)),
    );
    if (picked == null || !mounted) return;
    if (picked.end.difference(picked.start).inDays > 365) {
      showSnack(context, 'Pick 366 days or fewer.');
      return;
    }
    setState(() => _q = _q.copyWith(from: ymd(picked.start), to: ymd(picked.end), page: 1));
  }

  Future<void> _export() async {
    final f = await showModalBottomSheet<ReportFormat>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.table_view_outlined), title: const Text('CSV'), onTap: () => Navigator.pop(ctx, ReportFormat.csv)),
          ListTile(leading: const Icon(Icons.grid_on_outlined), title: const Text('Excel'), onTap: () => Navigator.pop(ctx, ReportFormat.excel)),
          ListTile(leading: const Icon(Icons.picture_as_pdf_outlined), title: const Text('PDF'), onTap: () => Navigator.pop(ctx, ReportFormat.pdf)),
        ]),
      ),
    );
    if (f == null || !mounted) return;
    setState(() => _exporting = true);
    try {
      final all = await ref.read(reportsRepoProvider).run(_q, all: true);
      await (widget.share ?? shareReport)(all, f);
    } on ReportTooLarge catch (e) {
      if (mounted) showSnack(context, 'Too many rows (${count(e.rows)}). Narrow the range.');
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
      } else if (mounted) {
        showSnack(context, e.friendly);
      }
    } catch (_) {
      if (mounted) showSnack(context, "Couldn't make the file. Try again.");
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final kinds = ref.watch(reportKindsProvider).value;
    final info = kinds?.kinds.where((k) => k.kind == widget.kind).firstOrNull;
    final value = ref.watch(reportPageProvider(_q));
    final page = value.value;
    final canExport = page != null && page.rows.isNotEmpty && !_exporting;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(info?.label ?? page?.title ?? 'Report'),
        backgroundColor: c.bg,
        actions: [
          IconButton(
            key: const Key('report-filters'),
            tooltip: 'Filters',
            icon: const Icon(Icons.tune),
            onPressed: info == null
                ? null
                : () async {
                    final next = await showReportFiltersSheet(context, info, _q);
                    if (next != null) setState(() => _q = next);
                  },
          ),
          IconButton(
            key: const Key('report-export'),
            tooltip: 'Export',
            icon: _exporting
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.download_outlined),
            onPressed: canExport ? _export : null,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(reportPageProvider(_q).future),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
              child: Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                OutlinedButton.icon(
                  key: const Key('report-dates'),
                  onPressed: _pickDates,
                  icon: const Icon(Icons.date_range, size: 18),
                  label: Text(periodWords(_q.from, _q.to)),
                ),
                if (_q.vendorName != null)
                  InputChip(
                    label: Text('Vendor: ${_q.vendorName}'),
                    onDeleted: () => setState(() => _q = _q.copyWith(vendorId: null, vendorName: null, page: 1)),
                  ),
                if (_q.riderName != null)
                  InputChip(
                    label: Text('Rider: ${_q.riderName}'),
                    onDeleted: () => setState(() => _q = _q.copyWith(riderId: null, riderName: null, page: 1)),
                  ),
                if (_q.status != null)
                  InputChip(
                    label: Text('Status: ${_q.status!.replaceAll('_', ' ')}'),
                    onDeleted: () => setState(() => _q = _q.copyWith(status: null, page: 1)),
                  ),
                if (_q.payment != null)
                  InputChip(
                    label: Text(_q.payment == 'cod' ? 'Cash only' : 'Online only'),
                    onDeleted: () => setState(() => _q = _q.copyWith(payment: null, page: 1)),
                  ),
              ]),
            ),
            if (page == null)
              value.hasError
                  ? ErrorRetry(error: value.error!, onRetry: () => ref.invalidate(reportPageProvider(_q)))
                  : const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator()))
            else
              ..._report(context, page),
          ],
        ),
      ),
    );
  }

  List<Widget> _report(BuildContext context, ReportPayload r) {
    final c = context.colors;
    return [
      if (r.subtitle.isNotEmpty)
        Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), child: Text(r.subtitle, style: TextStyle(color: c.muted))),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 0),
        child: Text(reportGeneratedLine(r), style: TextStyle(fontSize: 12, color: c.muted)),
      ),
      if (r.highlights.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
          child: Wrap(spacing: 22, runSpacing: 8, children: [
            for (final h in r.highlights)
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(h.label, style: TextStyle(fontSize: 12, color: c.muted)),
                Text(reportCellText(ReportColumn(key: h.key, label: h.label, type: h.type), h.value),
                    style: dataStyle(context, size: 18, weight: FontWeight.w800)),
              ]),
          ]),
        ),
      for (final n in r.notes)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
          child: Text(n, style: TextStyle(fontSize: 12.5, color: c.muted)),
        ),
      if (r.rows.isEmpty)
        const EmptyLine('No rows for these dates and filters.')
      else ...[
        const SizedBox(height: 8),
        _ReportTable(report: r),
        if (r.pages > 1)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(children: [
              TextButton(
                onPressed: r.page > 1 ? () => setState(() => _q = _q.copyWith(page: r.page - 1)) : null,
                child: const Text('Previous'),
              ),
              Expanded(
                child: Text('Page ${r.page} of ${r.pages} · ${count(r.totalRows)} rows',
                    textAlign: TextAlign.center, style: TextStyle(color: c.muted, fontSize: 12.5)),
              ),
              TextButton(
                onPressed: r.page < r.pages ? () => setState(() => _q = _q.copyWith(page: r.page + 1)) : null,
                child: const Text('Next'),
              ),
            ]),
          ),
      ],
    ];
  }
}

/// The rows, then the totals in bold. Scrolls sideways on a phone; fills the
/// width from 840 dp.
class _ReportTable extends StatelessWidget {
  const _ReportTable({required this.report});
  final ReportPayload report;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = report;
    DataCell cell(ReportColumn col, Object? v, {bool bold = false}) => DataCell(Text(
          reportCellText(col, v),
          style: col.type.numeric || bold
              ? dataStyle(context, size: 13, weight: bold ? FontWeight.w800 : FontWeight.w500)
              : TextStyle(fontSize: 13, color: c.ink),
        ));
    final table = DataTable(
      headingRowHeight: 40,
      dataRowMinHeight: 36,
      dataRowMaxHeight: 52,
      columnSpacing: 18,
      headingTextStyle: TextStyle(fontWeight: FontWeight.w700, color: c.muted, fontSize: 12.5),
      columns: [for (final col in r.columns) DataColumn(label: Text(col.label), numeric: col.type.numeric)],
      rows: [
        for (final row in r.rows) DataRow(cells: [for (final col in r.columns) cell(col, row[col.key])]),
        if (r.totals != null)
          DataRow(
            color: WidgetStatePropertyAll(c.surface2),
            cells: [for (final col in r.columns) cell(col, r.totals![col.key], bold: true)],
          ),
      ],
    );
    return LayoutBuilder(builder: (context, box) {
      if (box.maxWidth >= 840) {
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: ConstrainedBox(constraints: BoxConstraints(minWidth: box.maxWidth), child: table),
        );
      }
      return SingleChildScrollView(scrollDirection: Axis.horizontal, child: table);
    });
  }
}
