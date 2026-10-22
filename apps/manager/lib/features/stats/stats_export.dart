import 'dart:io';

import 'package:excel/excel.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/csv.dart';
import '../../core/format.dart';
import '../../models/stats.dart';

/// Who, when and what a downloaded report covers (§2.12, §13): printed at the
/// top of every format.
class ReportMeta {
  const ReportMeta({
    required this.title,
    required this.generatedAt,
    required this.generatedBy,
    required this.period,
    required this.zone,
    this.deviceTime = false,
  });
  final String title;
  final DateTime generatedAt;
  final String generatedBy;

  /// Human words, e.g. "1 Oct – 21 Oct 2026".
  final String period;

  /// "All my zones", or the zone's name.
  final String zone;

  /// The server sent no stamp, so [generatedAt] is this phone's clock — said
  /// so on the file rather than passed off as the server's time.
  final bool deviceTime;

  /// "21 Oct 2026 15:00 IST" — the business runs on India time whatever the
  /// phone is set to.
  String get generatedLine {
    final ist = generatedAt.toUtc().add(const Duration(hours: 5, minutes: 30));
    return 'Generated ${DateFormat('d MMM y HH:mm').format(ist)} IST${deviceTime ? ' (phone time)' : ''} by $generatedBy';
  }
}

/// "1 Oct – 21 Oct 2026", "21 Oct 2026" for a single day.
String periodWords(String from, String to) {
  final f = DateTime.tryParse(from), t = DateTime.tryParse(to);
  if (f == null || t == null) return '$from – $to';
  if (f == t) return DateFormat('d MMM y').format(f);
  return '${DateFormat(f.year == t.year ? 'd MMM' : 'd MMM y').format(f)} – ${DateFormat('d MMM y').format(t)}';
}

/// The report's stamp. The time is the **server's** — when these figures were
/// computed — not the moment the file was made, so a report saved an hour
/// after loading the screen does not claim figures fresher than they are.
ReportMeta reportMetaFor(StatsData d,
        {required String generatedBy, required String zone, String? vendorName, DateTime? now}) =>
    ReportMeta(
      title: vendorName == null ? 'Deligro performance report' : 'Deligro performance report — $vendorName',
      generatedAt: d.generatedAt ?? now ?? DateTime.now(),
      generatedBy: generatedBy,
      period: periodWords(d.from, d.to),
      zone: zone,
    );

const _weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const _cancellers = {
  'customer': 'Customer',
  'vendor': 'Vendor',
  'manager': 'Manager',
  'admin': 'Admin',
  'system': 'System',
  'unknown': 'Not recorded',
};

String _hour(int h) => DateFormat('h a').format(DateTime(2000, 1, 1, h));
Object _growth(Growth g) => g.pct ?? 'New';

/// The report's sections as plain rows: one source for CSV, Excel and PDF, so
/// the three never disagree. Money is whole rupees as numbers. Finance rows
/// appear only when the server sent them (`manager.finance.view`).
class _Tables {
  _Tables(StatsData d)
      : summary = [
          ['Sales (customer paid)', d.sales],
          ['Orders (completed and in progress)', d.orders],
          ['Gross sales (items)', d.grossSales],
          if (d.discounts != null) ['Discounts', d.discounts!],
          if (d.refunds != null) ['Refunds', d.refunds!],
          if (d.netSales != null) ['Net sales', d.netSales!],
          if (d.deliveryFees != null) ['Delivery fees', d.deliveryFees!],
          ['Average order value', d.aov],
          ['Sales growth vs previous period (%)', _growth(d.salesGrowth)],
          ['Order growth vs previous period (%)', _growth(d.ordersGrowth)],
          ['Average order value growth vs previous period (%)', _growth(d.aovGrowth)],
          ['Completed orders', d.completed.count],
          ['Completed value', d.completed.value],
          ['Cancelled orders', d.cancelled.count],
          ['Cancelled value', d.cancelled.value],
          ['Completion rate (%)', (d.completionRate * 1000).round() / 10],
          ['Cancellation rate (%)', (d.cancellationRate * 1000).round() / 10],
          ['Busiest hour', d.topHours.isEmpty ? '-' : _hour(d.topHours.first.hour)],
        ],
        daily = [
          for (final p in d.daily) [p.date, p.orders, p.sales, p.cancelled],
        ],
        cancelledBy = [
          for (final e in _cancellers.entries) [e.value, d.cancelledBy[e.key] ?? 0],
        ],
        reasons = [
          for (final r in d.topReasons) [r.reason, r.count],
        ],
        peak = [
          for (var w = 0; w < 7; w++)
            [
              _weekdays[w],
              for (var h = 0; h < 24; h++) w < d.peakGrid.length && h < d.peakGrid[w].length ? d.peakGrid[w][h] : 0,
            ],
        ],
        vendors = [
          for (var i = 0; i < d.bestVendors.length; i++)
            [i + 1, d.bestVendors[i].name, d.bestVendors[i].orders, d.bestVendors[i].sales, d.bestVendors[i].rating ?? ''],
        ],
        categories = [
          for (var i = 0; i < d.bestCategories.length; i++)
            [i + 1, d.bestCategories[i].category, d.bestCategories[i].qty, d.bestCategories[i].sales],
        ],
        cities = [
          for (final c in d.byCity) [c.cityName, c.orders, c.sales, c.cancelled, c.aov],
        ],
        zones = [
          for (final z in d.byZone) [z.cityName ?? '', z.zoneName, z.orders, z.sales],
        ];

  final List<List<Object>> summary;
  final List<List<Object>> daily;
  final List<List<Object>> cancelledBy;
  final List<List<Object>> reasons;
  final List<List<Object>> peak;
  final List<List<Object>> vendors;
  final List<List<Object>> categories;
  final List<List<Object>> cities;
  final List<List<Object>> zones;

  /// Summary rows that are rupees (shown with ₹ in the PDF).
  static const moneyRows = {
    'Sales (customer paid)',
    'Gross sales (items)',
    'Discounts',
    'Refunds',
    'Net sales',
    'Delivery fees',
    'Average order value',
    'Completed value',
    'Cancelled value',
  };

  static const dailyHead = ['Date', 'Orders', 'Sales', 'Cancelled'];
  static const cancelledByHead = ['Cancelled by', 'Orders'];
  static const reasonHead = ['Reason', 'Orders'];
  static final peakHead = ['Day', for (var h = 0; h < 24; h++) _hour(h)];
  static const vendorHead = ['Rank', 'Vendor', 'Orders', 'Sales', 'Rating'];
  static const categoryHead = ['Rank', 'Category', 'Quantity sold', 'Sales'];
  static const cityHead = ['City', 'Orders', 'Sales', 'Cancelled', 'Average order value'];
  static const zoneHead = ['City', 'Zone', 'Orders', 'Sales'];
}

String _compared(StatsData d) => periodWords(d.previousFrom, d.previousTo);

/// CSV: meta lines, then each section under its own heading.
String statsCsv(StatsData d, ReportMeta m) {
  final t = _Tables(d);
  final out = <String>[
    csvCell(m.title),
    csvCell(m.generatedLine),
    csvRow(['Period', m.period]),
    csvRow(['Zone', m.zone]),
    csvRow(['Compared with', _compared(d)]),
    '',
    'Summary',
    for (final r in t.summary) csvRow(r),
    '',
    'Day by day',
    csvRow(_Tables.dailyHead),
    for (final r in t.daily) csvRow(r),
    '',
    'Cancelled by',
    csvRow(_Tables.cancelledByHead),
    for (final r in t.cancelledBy) csvRow(r),
    '',
    'Cancellation reasons',
    csvRow(_Tables.reasonHead),
    for (final r in t.reasons) csvRow(r),
    '',
    'Peak ordering hours (orders, IST)',
    csvRow(_Tables.peakHead),
    for (final r in t.peak) csvRow(r),
    '',
    'Best-performing vendors',
    csvRow(_Tables.vendorHead),
    for (final r in t.vendors) csvRow(r),
    '',
    'Best-performing categories',
    csvRow(_Tables.categoryHead),
    for (final r in t.categories) csvRow(r),
    '',
    'By city',
    csvRow(_Tables.cityHead),
    for (final r in t.cities) csvRow(r),
    '',
    'By city and zone',
    csvRow(_Tables.zoneHead),
    for (final r in t.zones) csvRow(r),
  ];
  return csvDocument(out);
}

CellValue _cell(Object v) => switch (v) {
      int i => IntCellValue(i),
      double x => DoubleCellValue(x),
      _ => TextCellValue('$v'),
    };

/// Excel: one sheet per section, each starting with the meta lines.
List<int> statsXlsx(StatsData d, ReportMeta m) {
  final t = _Tables(d);
  final book = Excel.createExcel();
  final first = book.getDefaultSheet() ?? 'Sheet1';
  book.rename(first, 'Summary');

  void sheet(String name, List<String>? head, List<List<Object>> rows) {
    final s = book[name];
    s.appendRow([TextCellValue(m.title)]);
    s.appendRow([TextCellValue(m.generatedLine)]);
    s.appendRow([TextCellValue('Period'), TextCellValue(m.period)]);
    s.appendRow([TextCellValue('Zone'), TextCellValue(m.zone)]);
    s.appendRow([TextCellValue('Compared with'), TextCellValue(_compared(d))]);
    s.appendRow([]);
    if (head != null) s.appendRow([for (final h in head) TextCellValue(h)]);
    for (final r in rows) {
      s.appendRow([for (final v in r) _cell(v)]);
    }
  }

  sheet('Summary', null, t.summary);
  sheet('Daily', _Tables.dailyHead, t.daily);
  sheet('Cancellations', _Tables.cancelledByHead, [
    ...t.cancelledBy,
    const ['', ''],
    _Tables.reasonHead,
    ...t.reasons,
  ]);
  sheet('Peak hours', _Tables.peakHead, t.peak);
  sheet('Vendors', _Tables.vendorHead, t.vendors);
  sheet('Categories', _Tables.categoryHead, t.categories);
  sheet('Cities', _Tables.cityHead, t.cities);
  sheet('Zones', _Tables.zoneHead, t.zones);
  return book.encode() ?? const [];
}

/// PDF: the same sections as tables, money shown as ₹ (Roboto, bundled, has
/// the rupee sign — the PDF's built-in fonts do not).
Future<Uint8List> statsPdf(StatsData d, ReportMeta m) async {
  final regular = pw.Font.ttf(await rootBundle.load('assets/fonts/Roboto-Regular.ttf'));
  final bold = pw.Font.ttf(await rootBundle.load('assets/fonts/Roboto-Bold.ttf'));
  final t = _Tables(d);
  String show(Object v, {bool money = false}) => money && v is int ? rupees(v) : '$v';

  pw.Widget table(List<String> head, List<List<Object>> rows, Set<int> moneyAt, {double fontSize = 9}) =>
      pw.TableHelper.fromTextArray(
        headers: head,
        data: [
          for (final r in rows) [for (var i = 0; i < r.length; i++) show(r[i], money: moneyAt.contains(i))],
        ],
        headerStyle: pw.TextStyle(font: bold, fontSize: fontSize),
        cellStyle: pw.TextStyle(fontSize: fontSize),
        headerDecoration: const pw.BoxDecoration(color: PdfColors.grey200),
        cellAlignments: {
          for (var i = 0; i < head.length; i++) i: i <= 1 && head[i] != 'Rank' ? pw.Alignment.centerLeft : pw.Alignment.centerRight,
        },
      );

  pw.Widget heading(String s) => pw.Padding(
        padding: const pw.EdgeInsets.only(top: 14, bottom: 6),
        child: pw.Text(s, style: pw.TextStyle(font: bold, fontSize: 12)),
      );

  final doc = pw.Document(title: m.title, author: m.generatedBy, creator: 'Deligro Manager');
  doc.addPage(pw.MultiPage(
    theme: pw.ThemeData.withFont(base: regular, bold: bold),
    pageFormat: PdfPageFormat.a4,
    margin: const pw.EdgeInsets.all(28),
    footer: (ctx) => pw.Align(
      alignment: pw.Alignment.centerRight,
      child: pw.Text('${m.generatedLine} · page ${ctx.pageNumber} of ${ctx.pagesCount}',
          style: const pw.TextStyle(fontSize: 8, color: PdfColors.grey700)),
    ),
    build: (_) => [
      pw.Text(m.title, style: pw.TextStyle(font: bold, fontSize: 18)),
      pw.SizedBox(height: 4),
      pw.Text(m.generatedLine, style: const pw.TextStyle(fontSize: 9, color: PdfColors.grey700)),
      pw.Text('Period ${m.period} · Zone ${m.zone} · compared with ${_compared(d)}',
          style: const pw.TextStyle(fontSize: 9, color: PdfColors.grey700)),
      heading('Summary'),
      pw.TableHelper.fromTextArray(
        data: [
          for (final r in t.summary) [r[0], show(r[1], money: _Tables.moneyRows.contains(r[0]))],
        ],
        cellStyle: const pw.TextStyle(fontSize: 9),
        cellAlignments: {0: pw.Alignment.centerLeft, 1: pw.Alignment.centerRight},
      ),
      heading('Day by day'),
      table(_Tables.dailyHead, t.daily, {2}),
      heading('Cancelled by'),
      table(_Tables.cancelledByHead, t.cancelledBy, const {}),
      if (t.reasons.isNotEmpty) ...[
        heading('Cancellation reasons'),
        table(_Tables.reasonHead, t.reasons, const {}),
      ],
      heading('Peak ordering hours (orders, IST)'),
      table(_Tables.peakHead, t.peak, const {}, fontSize: 5.5),
      heading('Best-performing vendors'),
      table(_Tables.vendorHead, t.vendors, {3}),
      heading('Best-performing categories'),
      table(_Tables.categoryHead, t.categories, {3}),
      heading('By city'),
      table(_Tables.cityHead, t.cities, {2, 4}),
      heading('By city and zone'),
      table(_Tables.zoneHead, t.zones, {3}),
    ],
  ));
  return doc.save();
}

enum ReportFormat { csv, excel, pdf }

/// Writes the report to the app's temporary folder and opens the share sheet
/// (save to Files / Drive, WhatsApp, email). The PDF can also be printed.
Future<void> shareStatsReport(StatsData d, ReportMeta m, ReportFormat f) async {
  final stamp = DateFormat('yyyyMMdd-HHmm').format(m.generatedAt.toUtc().add(const Duration(hours: 5, minutes: 30)));
  final base = 'deligro-performance-${d.from}-to-${d.to}-$stamp';
  final dir = await getTemporaryDirectory();
  late final File file;
  late final String mime;
  switch (f) {
    case ReportFormat.csv:
      file = await File('${dir.path}/$base.csv').writeAsString(statsCsv(d, m));
      mime = 'text/csv';
    case ReportFormat.excel:
      file = await File('${dir.path}/$base.xlsx').writeAsBytes(statsXlsx(d, m));
      mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case ReportFormat.pdf:
      final bytes = await statsPdf(d, m);
      await Printing.sharePdf(bytes: bytes, filename: '$base.pdf');
      return;
  }
  await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: mime)], subject: m.title));
}
