import 'dart:convert';

import 'package:deligro_manager/features/stats/stats_export.dart';
import 'package:deligro_manager/models/stats.dart';
import 'package:excel/excel.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdf/pdf.dart';

import 'stats_fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final d = StatsData.fromJson(statsJson());
  final meta = ReportMeta(
    title: 'Deligro performance report',
    generatedAt: DateTime.utc(2026, 10, 21, 9, 30),
    generatedBy: 'Asha Verma',
    period: d.from == d.to ? d.from : '1 Oct – 21 Oct 2026',
    zone: 'All my zones',
  );

  test('the CSV opens with who generated it, when, for which period and zone', () {
    final lines = const LineSplitter().convert(statsCsv(d, meta));
    expect(lines[0], 'Deligro performance report');
    expect(lines[1], 'Generated 21 Oct 2026 15:00 IST by Asha Verma');
    expect(lines[2], 'Period,1 Oct – 21 Oct 2026');
    expect(lines[3], 'Zone,All my zones');
  });

  test('a vendor name with a comma is quoted, and money is a plain number', () {
    final csv = statsCsv(d, meta);
    expect(csv, contains('"Tandoor, Bemetara",9,2050'));
    expect(csv, isNot(contains('₹')));
  });

  test('the workbook has a sheet per section and its daily sales add up', () {
    final book = Excel.decodeBytes(statsXlsx(d, meta));
    expect(book.tables.keys, containsAll(['Summary', 'Daily', 'Vendors', 'Categories', 'Zones']));
    final daily = book.tables['Daily']!.rows;
    final header = daily.indexWhere((r) => r.isNotEmpty && r.first?.value.toString() == 'Date');
    var total = 0;
    for (final row in daily.skip(header + 1)) {
      final v = row.length > 2 ? row[2]?.value : null;
      if (v is IntCellValue) total += v.value;
    }
    expect(total, d.daily.fold<int>(0, (s, p) => s + p.sales));
    expect(book.tables['Summary']!.rows.first.first?.value.toString(), 'Deligro performance report');
  });

  test('without finance access the export has no finance rows at all', () {
    final json = statsJson();
    final summary = Map<String, dynamic>.from(json['summary'] as Map)
      ..remove('discounts')
      ..remove('refunds')
      ..remove('netSales')
      ..remove('deliveryFees');
    final limited = StatsData.fromJson({...json, 'summary': summary});
    expect(limited.netSales, isNull);
    expect(limited.deliveryFees, isNull);
    final csv = statsCsv(limited, meta);
    for (final row in ['Discounts', 'Refunds', 'Net sales', 'Delivery fees']) {
      expect(csv, isNot(contains(row)));
    }
    expect(csv, contains('Sales (customer paid)'));
    expect(statsCsv(d, meta), contains('Net sales'));
  });

  test('the PDF is a PDF, drawn with a font that has the rupee sign', () async {
    final regular = await rootBundle.load('assets/fonts/Roboto-Regular.ttf');
    expect(TtfParser(regular).charToGlyphIndexMap.containsKey(0x20B9), isTrue);
    final bytes = await statsPdf(d, meta);
    expect(String.fromCharCodes(bytes.take(4)), '%PDF');
  });
}
