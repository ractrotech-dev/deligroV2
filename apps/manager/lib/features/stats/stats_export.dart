import 'dart:io';

import 'package:excel/excel.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:share_plus/share_plus.dart';

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
  });
  final String title;
  final DateTime generatedAt;
  final String generatedBy;

  /// Human words, e.g. "1 Oct – 21 Oct 2026".
  final String period;

  /// "All my zones", or the zone's name.
  final String zone;

  /// "21 Oct 2026 15:00 IST" — the business runs on India time whatever the
  /// phone is set to.
  String get generatedLine {
    final ist = generatedAt.toUtc().add(const Duration(hours: 5, minutes: 30));
    return 'Generated ${DateFormat('d MMM y HH:mm').format(ist)} IST by $generatedBy';
  }
}

/// The report's sections as plain rows: one source for CSV, Excel and PDF, so
/// the three never disagree. Money is whole rupees as numbers.
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
          ['Sales growth vs previous period (%)', d.salesGrowth.pct ?? 'New'],
          ['Order growth vs previous period (%)', d.ordersGrowth.pct ?? 'New'],
          ['Completed orders', d.completed.count],
          ['Cancelled orders', d.cancelled.count],
          ['Cancelled value', d.cancelled.value],
          ['Busiest hour', d.topHours.isEmpty ? '-' : DateFormat('h a').format(DateTime(2000, 1, 1, d.topHours.first.hour))],
        ],
        daily = [
          for (final p in d.daily) [p.date, p.orders, p.sales, p.cancelled],
        ],
        vendors = [
          for (var i = 0; i < d.bestVendors.length; i++)
            [i + 1, d.bestVendors[i].name, d.bestVendors[i].orders, d.bestVendors[i].sales, d.bestVendors[i].rating ?? ''],
        ],
        categories = [
          for (var i = 0; i < d.bestCategories.length; i++)
            [i + 1, d.bestCategories[i].category, d.bestCategories[i].qty, d.bestCategories[i].sales],
        ],
        zones = [
          for (final z in d.byZone) [z.cityName ?? '', z.zoneName, z.orders, z.sales],
        ];

  final List<List<Object>> summary;
  final List<List<Object>> daily;
  final List<List<Object>> vendors;
  final List<List<Object>> categories;
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
    'Cancelled value',
  };

  static const dailyHead = ['Date', 'Orders', 'Sales', 'Cancelled'];
  static const vendorHead = ['Rank', 'Vendor', 'Orders', 'Sales', 'Rating'];
  static const categoryHead = ['Rank', 'Category', 'Quantity sold', 'Sales'];
  static const zoneHead = ['City', 'Zone', 'Orders', 'Sales'];
}

String _csvCell(Object v) {
  final s = '$v';
  return s.contains(RegExp(r'[",\n\r]')) ? '"${s.replaceAll('"', '""')}"' : s;
}

String _csvRow(List<Object> row) => row.map(_csvCell).join(',');

/// CSV: meta lines, then each section under its own heading.
String statsCsv(StatsData d, ReportMeta m) {
  final t = _Tables(d);
  final out = <String>[
    _csvCell(m.title),
    _csvCell(m.generatedLine),
    _csvRow(['Period', m.period]),
    _csvRow(['Zone', m.zone]),
    _csvRow(['Compared with', '${d.previousFrom} to ${d.previousTo}']),
    '',
    'Summary',
    for (final r in t.summary) _csvRow(r),
    '',
    'Day by day',
    _csvRow(_Tables.dailyHead),
    for (final r in t.daily) _csvRow(r),
    '',
    'Best-performing vendors',
    _csvRow(_Tables.vendorHead),
    for (final r in t.vendors) _csvRow(r),
    '',
    'Best-performing categories',
    _csvRow(_Tables.categoryHead),
    for (final r in t.categories) _csvRow(r),
    '',
    'By city and zone',
    _csvRow(_Tables.zoneHead),
    for (final r in t.zones) _csvRow(r),
  ];
  return '${out.join('\n')}\n';
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
    s.appendRow([]);
    if (head != null) s.appendRow([for (final h in head) TextCellValue(h)]);
    for (final r in rows) {
      s.appendRow([for (final v in r) _cell(v)]);
    }
  }

  sheet('Summary', null, t.summary);
  sheet('Daily', _Tables.dailyHead, t.daily);
  sheet('Vendors', _Tables.vendorHead, t.vendors);
  sheet('Categories', _Tables.categoryHead, t.categories);
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

  pw.Widget table(List<String> head, List<List<Object>> rows, Set<int> moneyAt) => pw.TableHelper.fromTextArray(
        headers: head,
        data: [
          for (final r in rows) [for (var i = 0; i < r.length; i++) show(r[i], money: moneyAt.contains(i))],
        ],
        headerStyle: pw.TextStyle(font: bold, fontSize: 9),
        cellStyle: const pw.TextStyle(fontSize: 9),
        headerDecoration: const pw.BoxDecoration(color: PdfColors.grey200),
        cellAlignments: {for (var i = 0; i < head.length; i++) i: i == 1 ? pw.Alignment.centerLeft : pw.Alignment.centerRight},
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
      pw.Text('Period ${m.period} · Zone ${m.zone} · compared with ${d.previousFrom} to ${d.previousTo}',
          style: const pw.TextStyle(fontSize: 9, color: PdfColors.grey700)),
      heading('Summary'),
      pw.TableHelper.fromTextArray(
        data: [
          for (final r in t.summary)
            [r[0], show(r[1], money: _Tables.moneyRows.contains(r[0]))],
        ],
        cellStyle: const pw.TextStyle(fontSize: 9),
        cellAlignments: {0: pw.Alignment.centerLeft, 1: pw.Alignment.centerRight},
      ),
      heading('Day by day'),
      table(_Tables.dailyHead, t.daily, {2}),
      heading('Best-performing vendors'),
      table(_Tables.vendorHead, t.vendors, {3}),
      heading('Best-performing categories'),
      table(_Tables.categoryHead, t.categories, {3}),
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
