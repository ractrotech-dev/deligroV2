import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:share_plus/share_plus.dart';

import '../models/earnings.dart';
import 'money.dart';

/// The statement as a file: a PDF to keep and a CSV for a spreadsheet, both
/// with the rider's name, rider ID and range at the top.
///
/// English only (ruling P3-R3): the PDF uses Roboto (assets/fonts), which has
/// the ₹ sign; no Devanagari font is bundled, so a name typed in Devanagari
/// would show as empty boxes in the PDF.

/// The fonts the PDF is set in, regular first.
const statementFontAssets = [
  'assets/fonts/Roboto-Regular.ttf',
  'assets/fonts/Roboto-Bold.ttf',
];

/// `deligro-statement-<riderCode>-<from>-<to>.<ext>`. The rider ID is cleaned
/// to letters, digits, `-` and `_`, so it can never carry a path.
String statementFileName(Statement s, String ext) {
  final code = (s.riderCode ?? '').replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '');
  return 'deligro-statement-${code.isEmpty ? 'rider' : code}-${s.from}-${s.to}.$ext';
}

String _riderName(Statement s) => (s.name ?? '').trim();

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/// A cell that is text, safe to open in a spreadsheet: quoted when it holds a
/// comma, quote or line break, and never starting with a character a
/// spreadsheet reads as a formula (`= + - @`).
String _text(String? v) {
  var t = (v ?? '').replaceAll(RegExp(r'[\r\n]+'), ' ');
  if (t.isNotEmpty && '=+-@\t'.contains(t[0])) t = "'$t";
  return _quote(t);
}

String _quote(String t) =>
    t.contains(RegExp(r'[",]')) ? '"${t.replaceAll('"', '""')}"' : t;

/// The statement as CSV text: the rider, the range and the four totals, a
/// blank line, then one header line and one line per record, oldest first.
/// Amounts are plain numbers (`-32.00` for a reversal), no symbol.
String statementCsv(Statement s) {
  final out = <String>[
    'Deligro rider statement',
    'Rider,${_text(_riderName(s))}',
    'Rider ID,${_text(s.riderCode)}',
    'From,${s.from}',
    'To,${s.to}',
    'Opening pending,${plainAmount(s.openingPending)}',
    'Earned,${plainAmount(s.earned)}',
    'Paid,${plainAmount(s.paid)}',
    'Closing pending,${plainAmount(s.closingPending)}',
    '',
    'Date,Order,Type,Description,Amount,Status,Settled on,Reference',
    for (final r in s.lines)
      [
        r.date,
        _text(r.orderCode),
        r.kindLabel,
        _text(r.reversed ? '${r.title} (reversed)' : r.title),
        plainAmount(r.amount),
        r.paid ? 'Paid' : 'Pending',
        r.settledOn ?? '',
        _text(r.reference),
      ].join(','),
  ];
  return '${out.join('\r\n')}\r\n';
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/// What the top of the PDF says, line by line (also what the tests read: the
/// PDF's own text is glyph codes, not searchable bytes).
List<String> statementPdfLines(Statement s) => [
  'Deligro rider statement',
  _riderName(s).isEmpty ? 'Rider' : _riderName(s),
  'Rider ID: ${s.riderCode ?? '—'}',
  'Period: ${formatRange(s.from, s.to)}',
  'Opening pending: ${money(s.openingPending)}',
  'Earned: ${money(s.earned)}',
  'Paid: ${money(s.paid)}',
  'Closing pending: ${money(s.closingPending)}',
];

Future<pw.Font> _font(String asset) async =>
    pw.Font.ttf(await rootBundle.load(asset));

/// The statement as a PDF (A4, as many pages as it takes).
Future<Uint8List> statementPdf(Statement s) async {
  final regular = await _font(statementFontAssets[0]);
  final bold = await _font(statementFontAssets[1]);
  final lines = statementPdfLines(s);
  final name = lines[1];
  final doc = pw.Document(
    title: 'Deligro statement ${s.riderCode ?? ''} ${s.from} to ${s.to}'
        .replaceAll('  ', ' '),
    author: 'Deligro',
    creator: 'Deligro Rider',
    theme: pw.ThemeData.withFont(base: regular, bold: bold),
  );

  const ink = PdfColor.fromInt(0xFF0E1417);
  const muted = PdfColor.fromInt(0xFF52585E);
  const line = PdfColor.fromInt(0xFFDEDCD6);
  const red = PdfColor.fromInt(0xFFD1201A);

  pw.Widget total(String label, double value) => pw.Expanded(
    child: pw.Container(
      padding: const pw.EdgeInsets.all(8),
      decoration: pw.BoxDecoration(
        border: pw.Border.all(color: line),
        borderRadius: pw.BorderRadius.circular(6),
      ),
      child: pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.start,
        children: [
          pw.Text(label, style: const pw.TextStyle(fontSize: 8, color: muted)),
          pw.SizedBox(height: 3),
          pw.Text(
            money(value),
            style: pw.TextStyle(
              fontSize: 13,
              fontWeight: pw.FontWeight.bold,
              color: value < 0 ? red : ink,
            ),
          ),
        ],
      ),
    ),
  );

  final cells = [
    for (final r in s.lines)
      [
        formatDay(r.date),
        r.reversed ? '${r.title} (reversed)' : r.title,
        r.paid ? 'Paid' : 'Pending',
        r.reference ?? '',
        money(r.amount),
      ],
  ];

  doc.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.fromLTRB(36, 36, 36, 40),
      footer: (ctx) => pw.Row(
        mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
        children: [
          pw.Text(
            'Deligro · ${s.riderCode ?? name} · ${s.from} to ${s.to}',
            style: const pw.TextStyle(fontSize: 8, color: muted),
          ),
          pw.Text(
            'Page ${ctx.pageNumber} of ${ctx.pagesCount}',
            style: const pw.TextStyle(fontSize: 8, color: muted),
          ),
        ],
      ),
      build: (ctx) => [
        pw.Text(
          lines[0],
          style: pw.TextStyle(
            fontSize: 18,
            fontWeight: pw.FontWeight.bold,
            color: ink,
          ),
        ),
        pw.SizedBox(height: 10),
        pw.Text(
          name,
          style: pw.TextStyle(
            fontSize: 13,
            fontWeight: pw.FontWeight.bold,
            color: ink,
          ),
        ),
        pw.Text(lines[2], style: const pw.TextStyle(fontSize: 10, color: ink)),
        pw.Text(lines[3], style: const pw.TextStyle(fontSize: 10, color: ink)),
        pw.SizedBox(height: 12),
        pw.Row(
          children: [
            total('Opening pending', s.openingPending),
            pw.SizedBox(width: 6),
            total('Earned', s.earned),
            pw.SizedBox(width: 6),
            total('Paid', s.paid),
            pw.SizedBox(width: 6),
            total('Closing pending', s.closingPending),
          ],
        ),
        if (s.closingPending < 0) ...[
          pw.SizedBox(height: 6),
          pw.Text(
            'A negative closing figure means you owe Deligro; it comes off your next payout.',
            style: const pw.TextStyle(fontSize: 8, color: muted),
          ),
        ],
        pw.SizedBox(height: 14),
        if (cells.isEmpty)
          pw.Text(
            'No records in this range.',
            style: const pw.TextStyle(fontSize: 10, color: muted),
          )
        else
          pw.TableHelper.fromTextArray(
            headers: const [
              'Date',
              'Description',
              'Status',
              'Reference',
              'Amount',
            ],
            data: cells,
            headerStyle: pw.TextStyle(
              fontSize: 9,
              fontWeight: pw.FontWeight.bold,
              color: ink,
            ),
            cellStyle: const pw.TextStyle(fontSize: 9, color: ink),
            headerDecoration: const pw.BoxDecoration(
              color: PdfColor.fromInt(0xFFEDECE8),
            ),
            border: const pw.TableBorder(
              horizontalInside: pw.BorderSide(color: line, width: .5),
            ),
            cellPadding: const pw.EdgeInsets.symmetric(
              horizontal: 4,
              vertical: 4,
            ),
            columnWidths: const {
              0: pw.FixedColumnWidth(62),
              1: pw.FlexColumnWidth(3),
              2: pw.FixedColumnWidth(48),
              3: pw.FlexColumnWidth(1.4),
              4: pw.FixedColumnWidth(58),
            },
            cellAlignments: const {4: pw.Alignment.centerRight},
            headerAlignments: const {4: pw.Alignment.centerRight},
          ),
      ],
    ),
  );
  return doc.save();
}

// ---------------------------------------------------------------------------
// handing the file to the phone
// ---------------------------------------------------------------------------

/// Hands a finished statement to the phone's share sheet, which is where the
/// rider saves it, prints it or sends it. A test or a preview swaps in its own.
abstract interface class StatementSharer {
  Future<void> sharePdf(Uint8List bytes, String fileName);
  Future<void> shareCsv(String csv, String fileName);
}

class SystemStatementSharer implements StatementSharer {
  const SystemStatementSharer();

  @override
  Future<void> sharePdf(Uint8List bytes, String fileName) async {
    await Printing.sharePdf(
      bytes: bytes,
      filename: fileName,
      subject: 'Deligro statement',
    );
  }

  @override
  Future<void> shareCsv(String csv, String fileName) async {
    // A byte-order mark so a spreadsheet reads the file as UTF-8.
    final bytes = Uint8List.fromList([0xEF, 0xBB, 0xBF, ...utf8.encode(csv)]);
    await SharePlus.instance.share(
      ShareParams(
        files: [XFile.fromData(bytes, mimeType: 'text/csv', name: fileName)],
        fileNameOverrides: [fileName],
        subject: 'Deligro statement',
      ),
    );
  }
}
