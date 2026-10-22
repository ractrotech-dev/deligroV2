import 'dart:io';

import 'package:excel/excel.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:share_plus/share_plus.dart';

import '../features/stats/stats_export.dart' show ReportFormat, ReportMeta, periodWords;
import '../models/report.dart';
import 'csv.dart';
import 'format.dart';

/// CSV, Excel and PDF from any report the server sends (§13). The server
/// owns every figure and the totals; this only lays them out. Every file
/// starts with the title, the period, the zone, the filters in words and
/// "Generated <IST time> by <name>" from the server's own stamp.

ReportMeta reportMeta(ReportPayload r) => ReportMeta(
      title: r.title,
      generatedAt: r.generatedAt ?? DateTime.now(),
      generatedBy: r.generatedBy.isEmpty ? 'Deligro' : r.generatedBy,
      period: periodWords(r.filters.from, r.filters.to),
      zone: r.filters.zone?.name ?? 'All my zones',
    );

String reportGeneratedLine(ReportPayload r) => reportMeta(r).generatedLine;

const _payments = {'cod': 'Cash', 'online': 'Online'};

/// "Vendor: Spice Hub · Payment: Online", or "None".
String reportFilterWords(ReportPayload r) {
  final f = r.filters;
  final parts = [
    if (f.vendor != null) 'Vendor: ${f.vendor!.name}',
    if (f.rider != null) 'Rider: ${f.rider!.name}',
    if (f.status != null) 'Status: ${f.status!.replaceAll('_', ' ')}',
    if (f.payment != null && f.payment != 'all') 'Payment: ${_payments[f.payment] ?? f.payment}',
  ];
  return parts.isEmpty ? 'None' : parts.join(' · ');
}

final _ist = DateFormat('d MMM y HH:mm');

/// One cell in words for the screen and the PDF.
String reportCellText(ReportColumn col, Object? v) {
  if (v == null) return '—';
  if (v is! num) {
    if (col.type == ReportColumnType.datetime && v is String) {
      final d = DateTime.tryParse(v);
      if (d != null) return _ist.format(d.toUtc().add(const Duration(hours: 5, minutes: 30)));
    }
    return '$v';
  }
  return switch (col.type) {
    ReportColumnType.money => rupeesSigned(v),
    ReportColumnType.money2 => rupeesFlex(v),
    // Rates come as fractions (0.125), as the metrics module computes them.
    ReportColumnType.percent => '${NumberFormat('0.#').format(v * 100)}%',
    ReportColumnType.minutes => '${v.round()} min',
    ReportColumnType.int => count(v),
    _ => '$v',
  };
}

/// The raw value for CSV and Excel: numbers as numbers, no ₹.
Object? _raw(Object? v) => v;

List<String> _metaLines(ReportPayload r) {
  final m = reportMeta(r);
  return [
    csvCell(m.title),
    csvCell(m.generatedLine),
    csvRow(['Period', m.period]),
    csvRow(['Zone', m.zone]),
    csvRow(['Filters', reportFilterWords(r)]),
  ];
}

/// CSV: meta lines, a blank line, the label row, one line per row, then
/// the totals line.
String reportCsv(ReportPayload r) {
  final cols = r.columns;
  return csvDocument([
    ..._metaLines(r),
    if (r.subtitle.isNotEmpty) csvCell(r.subtitle),
    '',
    csvRow([for (final c in cols) c.label]),
    for (final row in r.rows) csvRow([for (final c in cols) _raw(row[c.key])]),
    if (r.totals != null) csvRow([for (final c in cols) _raw(r.totals![c.key])]),
    if (r.notes.isNotEmpty) '',
    for (final n in r.notes) csvCell(n),
  ]);
}

CellValue? _cell(Object? v) => switch (v) {
      null => null,
      int i => IntCellValue(i),
      double x => DoubleCellValue(x),
      _ => TextCellValue('$v'),
    };

/// Excel: one sheet, the same lines and cells as the CSV.
List<int> reportXlsx(ReportPayload r) {
  final m = reportMeta(r);
  final book = Excel.createExcel();
  final name = book.getDefaultSheet() ?? 'Sheet1';
  final s = book[name];
  s.appendRow([TextCellValue(m.title)]);
  s.appendRow([TextCellValue(m.generatedLine)]);
  s.appendRow([TextCellValue('Period'), TextCellValue(m.period)]);
  s.appendRow([TextCellValue('Zone'), TextCellValue(m.zone)]);
  s.appendRow([TextCellValue('Filters'), TextCellValue(reportFilterWords(r))]);
  s.appendRow([]);
  s.appendRow([for (final c in r.columns) TextCellValue(c.label)]);
  for (final row in r.rows) {
    s.appendRow([for (final c in r.columns) _cell(row[c.key])]);
  }
  if (r.totals != null) s.appendRow([for (final c in r.columns) _cell(r.totals![c.key])]);
  for (final n in r.notes) {
    s.appendRow([TextCellValue(n)]);
  }
  return book.encode() ?? const [];
}

/// PDF: the header on every page, page numbers, money as ₹ (bundled Roboto
/// has the rupee sign; the PDF's built-in fonts do not). Landscape when the
/// table is wide.
Future<Uint8List> reportPdf(ReportPayload r) async {
  final regular = pw.Font.ttf(await rootBundle.load('assets/fonts/Roboto-Regular.ttf'));
  final bold = pw.Font.ttf(await rootBundle.load('assets/fonts/Roboto-Bold.ttf'));
  final m = reportMeta(r);
  final cols = r.columns;
  final wide = cols.length > 7;
  final fontSize = cols.length > 11 ? 6.5 : (wide ? 7.5 : 9.0);
  final doc = pw.Document(title: m.title, author: m.generatedBy, creator: 'Deligro Manager');
  doc.addPage(pw.MultiPage(
    theme: pw.ThemeData.withFont(base: regular, bold: bold),
    pageFormat: wide ? PdfPageFormat.a4.landscape : PdfPageFormat.a4,
    margin: const pw.EdgeInsets.all(24),
    header: (ctx) => pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
      pw.Text(m.title, style: pw.TextStyle(font: bold, fontSize: 15)),
      pw.Text(m.generatedLine, style: const pw.TextStyle(fontSize: 8.5, color: PdfColors.grey700)),
      pw.Text('Period ${m.period} · Zone ${m.zone} · Filters ${reportFilterWords(r)}',
          style: const pw.TextStyle(fontSize: 8.5, color: PdfColors.grey700)),
      pw.SizedBox(height: 8),
    ]),
    footer: (ctx) => pw.Align(
      alignment: pw.Alignment.centerRight,
      child: pw.Text('Page ${ctx.pageNumber} of ${ctx.pagesCount}',
          style: const pw.TextStyle(fontSize: 8, color: PdfColors.grey700)),
    ),
    build: (_) => [
      if (r.highlights.isNotEmpty)
        pw.Padding(
          padding: const pw.EdgeInsets.only(bottom: 8),
          child: pw.Wrap(spacing: 18, runSpacing: 4, children: [
            for (final h in r.highlights)
              pw.Text('${h.label}: ${reportCellText(ReportColumn(key: h.key, label: h.label, type: h.type), h.value)}',
                  style: pw.TextStyle(font: bold, fontSize: 9.5)),
          ]),
        ),
      pw.TableHelper.fromTextArray(
        headers: [for (final c in cols) c.label],
        data: [
          for (final row in r.rows) [for (final c in cols) reportCellText(c, row[c.key])],
          if (r.totals != null) [for (final c in cols) reportCellText(c, r.totals![c.key])],
        ],
        headerStyle: pw.TextStyle(font: bold, fontSize: fontSize),
        cellStyle: pw.TextStyle(fontSize: fontSize),
        headerDecoration: const pw.BoxDecoration(color: PdfColors.grey200),
        cellAlignments: {
          for (var i = 0; i < cols.length; i++) i: cols[i].type.numeric ? pw.Alignment.centerRight : pw.Alignment.centerLeft,
        },
      ),
      for (final n in r.notes)
        pw.Padding(
          padding: const pw.EdgeInsets.only(top: 6),
          child: pw.Text(n, style: const pw.TextStyle(fontSize: 8.5, color: PdfColors.grey700)),
        ),
    ],
  ));
  return doc.save();
}

/// Writes the file and opens the share sheet (save to Files, Drive, email).
Future<void> shareReport(ReportPayload r, ReportFormat f) async {
  final stamp = DateFormat('yyyyMMdd-HHmm')
      .format((r.generatedAt ?? DateTime.now()).toUtc().add(const Duration(hours: 5, minutes: 30)));
  final base = 'deligro-${r.kind}-${r.filters.from}-to-${r.filters.to}-$stamp';
  final dir = await getTemporaryDirectory();
  switch (f) {
    case ReportFormat.csv:
      final file = await File('${dir.path}/$base.csv').writeAsString(reportCsv(r));
      await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: 'text/csv')], subject: r.title));
    case ReportFormat.excel:
      final file = await File('${dir.path}/$base.xlsx').writeAsBytes(reportXlsx(r));
      await SharePlus.instance.share(ShareParams(
        files: [XFile(file.path, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')],
        subject: r.title,
      ));
    case ReportFormat.pdf:
      await Printing.sharePdf(bytes: await reportPdf(r), filename: '$base.pdf');
  }
}
