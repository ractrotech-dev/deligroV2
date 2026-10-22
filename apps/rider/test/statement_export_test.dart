// The statement as a file: CSV (header, rows, escaping) and PDF (a real PDF
// carrying the rider's name, ID and range, in a font that has the ₹ sign).
// English only: no Devanagari font is bundled.
import 'dart:convert';

import 'package:deligro_rider/core/statement_export.dart';
import 'package:deligro_rider/models/earnings.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdf/src/pdf/font/ttf_parser.dart' show TtfParser;

EarningRecord _delivery(
  String id, {
  double amount = 32,
  String date = '2026-10-21',
  bool paid = false,
}) => EarningRecord(
  kind: RecordKind.delivery,
  id: id,
  orderId: 'o-$id',
  orderCode: '#${id.toUpperCase()}',
  date: date,
  baseFee: 20,
  distanceKm: 3.4,
  distanceSource: DistanceSource.road,
  distanceFee: 12,
  minTopup: 0,
  tip: 0,
  tipInCash: false,
  amount: amount,
  paid: paid,
  settledOn: paid ? '2026-10-22' : null,
  reference: paid ? 'UTR-1' : null,
);

Statement _statement({
  List<EarningRecord>? rows,
  String? name = 'Ravi Kumar',
  String? code = 'DR-0042',
}) => Statement(
  riderCode: code,
  name: name,
  from: '2026-10-01',
  to: '2026-10-22',
  openingPending: 100,
  earned: 250.5,
  paid: 300,
  closingPending: 50.5,
  rows:
      rows ??
      [
        _delivery('a1'),
        _delivery('b2', amount: 47.5, paid: true, date: '2026-10-20'),
      ],
);

/// A CSV line split on commas that are not inside quotes.
List<String> _cells(String line) {
  final out = <String>[];
  final cell = StringBuffer();
  var quoted = false;
  for (var i = 0; i < line.length; i++) {
    final ch = line[i];
    if (quoted) {
      if (ch == '"' && i + 1 < line.length && line[i + 1] == '"') {
        cell.write('"');
        i++;
      } else if (ch == '"') {
        quoted = false;
      } else {
        cell.write(ch);
      }
    } else if (ch == '"') {
      quoted = true;
    } else if (ch == ',') {
      out.add(cell.toString());
      cell.clear();
    } else {
      cell.write(ch);
    }
  }
  out.add(cell.toString());
  return out;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('file names', () {
    test('deligro-statement-<riderCode>-<from>-<to>', () {
      expect(
        statementFileName(_statement(), 'pdf'),
        'deligro-statement-DR-0042-2026-10-01-2026-10-22.pdf',
      );
      expect(
        statementFileName(_statement(), 'csv'),
        'deligro-statement-DR-0042-2026-10-01-2026-10-22.csv',
      );
    });

    test('a rider without a code still gets a safe name', () {
      expect(
        statementFileName(_statement(code: null), 'pdf'),
        'deligro-statement-rider-2026-10-01-2026-10-22.pdf',
      );
      expect(
        statementFileName(_statement(code: '../DR 42?'), 'pdf'),
        'deligro-statement-DR42-2026-10-01-2026-10-22.pdf',
      );
    });
  });

  group('CSV', () {
    test('has the rider, the range and the four totals before the table', () {
      final lines = const LineSplitter().convert(statementCsv(_statement()));
      expect(lines.first, 'Deligro rider statement');
      expect(lines, contains('Rider,Ravi Kumar'));
      expect(lines, contains('Rider ID,DR-0042'));
      expect(lines, contains('From,2026-10-01'));
      expect(lines, contains('To,2026-10-22'));
      expect(lines, contains('Pending at start,100.00'));
      expect(lines, contains('Earned,250.50'));
      expect(lines, contains('Paid,300.00'));
      expect(lines, contains('Pending at end,50.50'));
    });

    test('the table has one header line and one line per row', () {
      final lines = const LineSplitter().convert(statementCsv(_statement()));
      final header = lines.indexWhere((l) => l.startsWith('Date,'));
      expect(header, greaterThan(0));
      expect(_cells(lines[header]), [
        'Date',
        'Order',
        'Type',
        'Description',
        'Amount',
        'Status',
        'Settled on',
        'Reference',
      ]);
      final rows = lines
          .sublist(header + 1)
          .where((l) => l.isNotEmpty)
          .toList();
      expect(rows, hasLength(2));
      expect(_cells(rows[0]), [
        '2026-10-21',
        '#A1',
        'Delivery',
        'Delivery #A1',
        '32.00',
        'Pending',
        '',
        '',
      ]);
      expect(_cells(rows[1]), [
        '2026-10-20',
        '#B2',
        'Delivery',
        'Delivery #B2',
        '47.50',
        'Paid',
        '2026-10-22',
        'UTR-1',
      ]);
    });

    test('a negative amount stays a number', () {
      final csv = statementCsv(
        _statement(
          rows: [
            EarningRecord(
              kind: RecordKind.adjustment,
              id: 'r1',
              orderCode: '#A1',
              date: '2026-10-21',
              amount: -32,
              paid: false,
              note: 'Delivery corrected',
              reversesId: 'e1',
            ),
          ],
        ),
      );
      final row = const LineSplitter().convert(csv).last;
      expect(_cells(row)[2], 'Reversal');
      expect(_cells(row)[3], 'Automatic reversal — the delivery was corrected');
      expect(_cells(row)[4], '-32.00');
    });

    test(
      'commas and quotes in a note are quoted; a leading = is neutralised',
      () {
        final csv = statementCsv(
          _statement(
            rows: [
              const EarningRecord(
                kind: RecordKind.bonus,
                id: 'b1',
                date: '2026-10-21',
                amount: 50,
                paid: false,
                note: '=cmd|"x", thanks',
              ),
            ],
          ),
        );
        final row = const LineSplitter().convert(csv).last;
        final cells = _cells(row);
        expect(cells, hasLength(8));
        expect(cells[3], startsWith('Bonus — '));
        expect(cells[3], contains('"x", thanks'));
        // The cell starts with a word, so a spreadsheet cannot read it as a formula.
        expect(cells[3][0], isNot(anyOf('=', '+', '-', '@')));
        final reference = statementCsv(
          _statement(
            rows: [
              const EarningRecord(
                kind: RecordKind.delivery,
                id: 'd1',
                date: '2026-10-21',
                amount: 10,
                paid: true,
                reference: '=HYPERLINK("http://x")',
              ),
            ],
          ),
        );
        expect(
          _cells(const LineSplitter().convert(reference).last)[7],
          startsWith("'="),
        );
      },
    );

    test('₹0 delivery rows are not in the file; salary and deliveries with an amount are', () {
      final csv = statementCsv(
        _statement(
          rows: [
            _delivery('z1', amount: 0),
            _delivery('a1', amount: 32),
            const EarningRecord(
              kind: RecordKind.salary,
              id: 's1',
              date: '2026-10-20',
              amount: 18000,
              paid: false,
              note: 'October salary',
            ),
          ],
        ),
      );
      final lines = const LineSplitter().convert(csv);
      final rows = lines
          .sublist(lines.indexWhere((l) => l.startsWith('Date,')) + 1)
          .where((l) => l.isNotEmpty);
      expect(rows, hasLength(2));
      expect(csv, isNot(contains('#Z1')));
      expect(csv, contains('Salary — October salary'));
      expect(csv, contains('18000.00'));
    });

    test('an empty statement is still a statement', () {
      final lines = const LineSplitter().convert(
        statementCsv(_statement(rows: [])),
      );
      expect(lines.where((l) => l.startsWith('Date,')), hasLength(1));
      expect(lines.last, startsWith('Date,'));
    });

    test('a rider with no name or ID leaves the cells empty, not "null"', () {
      final csv = statementCsv(_statement(name: null, code: null));
      expect(csv, isNot(contains('null')));
      expect(csv, contains('Rider ID,'));
    });
  });

  group('PDF', () {
    test('the header text carries the rider, the ID and the range', () {
      final lines = statementPdfLines(_statement());
      expect(lines.join('\n'), contains('Ravi Kumar'));
      expect(lines.join('\n'), contains('DR-0042'));
      expect(lines.join('\n'), contains('1 Oct 2026 – 22 Oct 2026'));
      expect(lines.join('\n'), contains('₹100'));
      expect(lines.join('\n'), contains('₹250.50'));
      expect(lines.join('\n'), contains('₹300'));
      expect(lines.join('\n'), contains('₹50.50'));
    });

    test('bytes are a PDF and name the rider ID and range', () async {
      final bytes = await statementPdf(_statement());
      expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
      expect(
        String.fromCharCodes(bytes.reversed.take(8).toList().reversed),
        contains('%%EOF'),
      );
      // The document's own title is uncompressed in the info dictionary.
      final raw = latin1.decode(bytes);
      expect(raw, contains('DR-0042'));
      expect(raw, contains('2026-10-01'));
      expect(raw, contains('2026-10-22'));
    });

    test('a long statement runs over several pages', () async {
      final many = _statement(
        rows: [for (var i = 0; i < 150; i++) _delivery('d$i')],
      );
      final bytes = await statementPdf(many);
      final pages = RegExp(r'/Type\s*/Page\b')
          .allMatches(latin1.decode(bytes))
          .length;
      expect(pages, greaterThan(2));
    });

    test('an empty statement is a one-page PDF', () async {
      final bytes = await statementPdf(_statement(rows: []));
      expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
    });

    test('the bundled fonts have the rupee sign and the minus sign', () async {
      for (final asset in statementFontAssets) {
        final font = TtfParser(await rootBundle.load(asset));
        expect(
          font.charToGlyphIndexMap.containsKey(0x20B9),
          isTrue,
          reason: '$asset has no ₹',
        );
        expect(
          font.charToGlyphIndexMap.containsKey(0x2212),
          isTrue,
          reason: '$asset has no −',
        );
        expect(
          font.charToGlyphIndexMap.containsKey(0x2014),
          isTrue,
          reason: '$asset has no —',
        );
        expect(
          font.charToGlyphIndexMap.containsKey(0x2013),
          isTrue,
          reason: '$asset has no –',
        );
      }
    });
  });
}
