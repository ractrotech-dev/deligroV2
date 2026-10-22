import 'dart:convert';

import 'package:deligro_manager/core/report_export.dart';
import 'package:deligro_manager/features/reports/report_filters_sheet.dart';
import 'package:deligro_manager/features/reports/report_view.dart';
import 'package:deligro_manager/features/reports/reports_screen.dart';
import 'package:deligro_manager/features/stats/stats_export.dart' show ReportFormat;
import 'package:deligro_manager/models/report.dart';
import 'package:excel/excel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_finance_repository.dart';
import 'finance_helpers.dart';

void main() {
  final sales = ReportPayload.fromJson(p6('report_sales'));

  group('exporter', () {
    test('CSV: header lines, label row, one line per row, totals; numbers raw', () {
      final csv = reportCsv(sales);
      expect(csv.startsWith('﻿'), isTrue);
      final lines = const LineSplitter().convert(csv.substring(1));
      expect(lines[0], 'Sales report');
      expect(lines[1], 'Generated 21 Oct 2026 15:00 IST by Asha Verma');
      expect(lines, contains('Period,19 Oct – 21 Oct 2026'));
      expect(lines, contains('Zone,Bemetara'));
      expect(lines.any((l) => l.startsWith('Filters,') && l.contains('Vendor: Spice Hub') && l.contains('Payment: Online')),
          isTrue);
      final head = lines.indexOf(
          'Date,Orders,Customer paid,Gross sales,Discounts,Refunds,Net sales,Delivery fees,Average order,Note');
      expect(head, greaterThan(0));
      expect(lines[head + 1], startsWith('2026-10-19,15,6420,6000,200,0,5800,300,428,'));
      // A typed-in cell starting with = is defused.
      expect(lines[head + 1], contains("'=HYPERLINK"));
      expect(lines[head + 2], '2026-10-20,16,7120,6600,100,120,6380,330,445,');
      expect(lines[head + 4], 'Total,46,19520,18200,470,120,17610,910,424,');
      expect(csv.contains('₹'), isFalse);
    });

    test('Excel holds the same cell values', () {
      final book = Excel.decodeBytes(reportXlsx(sales));
      final sheet = book.tables.values.first;
      final rows = sheet.rows.map((r) => r.map((c) => c?.value?.toString() ?? '').toList()).toList();
      final head = rows.indexWhere((r) => r.isNotEmpty && r.first == 'Date');
      expect(head, greaterThan(0));
      expect(rows[head + 1].take(3), ['2026-10-19', '15', '6420']);
      expect(rows[head + 4].first, 'Total');
      expect(rows.first.first, 'Sales report');
    });

    test('PDF builds, with the generated line', () async {
      final bytes = await reportPdf(sales);
      expect(bytes.length, greaterThan(1000));
      expect(reportGeneratedLine(sales), 'Generated 21 Oct 2026 15:00 IST by Asha Verma');
    });

    test('with no server stamp the line says it is the phone\'s time', () {
      final j = Map<String, dynamic>.from(p6('report_sales'))..remove('generatedAt');
      expect(reportGeneratedLine(ReportPayload.fromJson(j)), contains('phone time'));
    });

    test('cell words: money, percent, minutes, null', () {
      const money = ReportColumn(key: 'm', label: 'M', type: ReportColumnType.money);
      const pct = ReportColumn(key: 'p', label: 'P', type: ReportColumnType.percent);
      const mins = ReportColumn(key: 'n', label: 'N', type: ReportColumnType.minutes);
      expect(reportCellText(money, 123456), '₹1,23,456');
      expect(reportCellText(pct, 0.125), '12.5%');
      expect(reportCellText(mins, 14.4), '14 min');
      expect(reportCellText(money, null), '—');
    });
  });

  testWidgets('the picker lists only the kinds the server allows', (t) async {
    final fakes = FinanceFakes(reports: FakeReportsRepository(finance: false));
    await pumpFinance(t, const ReportsScreen(), fakes: fakes, permissions: {'manager.reports.view'});
    await t.pumpAndSettle();
    expect(find.text('Sales report'), findsOneWidget);
    expect(find.text('Commission report'), findsNothing);
  });

  testWidgets('the filters sheet shows only the kind\'s filters', (t) async {
    await pumpFinance(t, const ReportViewScreen(kind: 'sales'));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('report-filters')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('filter-vendor')), findsOneWidget);
    expect(find.byKey(const Key('filter-payment')), findsOneWidget);
    expect(find.byKey(const Key('filter-rider')), findsNothing);
    expect(find.byKey(const Key('filter-status')), findsNothing);
  });

  test('filters sheet keys follow the kind', () {
    const info = ReportKindInfo(kind: 'orders', label: 'Order report', filters: ['vendor', 'rider', 'status']);
    expect(reportFilterKeys(info), ['vendor', 'rider', 'status']);
  });

  testWidgets('the view shows highlights, notes, rows and the totals row', (t) async {
    await pumpFinance(t, const ReportViewScreen(kind: 'sales'), size: const Size(1200, 1400));
    await t.pumpAndSettle();
    expect(find.text('₹17,610'), findsWidgets);
    expect(find.textContaining('Cancelled orders are excluded'), findsOneWidget);
    expect(find.text('2026-10-21'), findsOneWidget);
    expect(find.text('Total'), findsOneWidget);
  });

  testWidgets('too many rows: asks for a narrower range', (t) async {
    final fakes = FinanceFakes();
    fakes.reports.exportError = const ReportTooLarge(rows: 18420, max: 10000);
    await pumpFinance(t, const ReportViewScreen(kind: 'sales'), fakes: fakes);
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('report-export')));
    await t.pumpAndSettle();
    await t.tap(find.text('CSV'));
    await t.pumpAndSettle();
    expect(find.text('Too many rows (18,420). Narrow the range.'), findsOneWidget);
    expect(fakes.reports.runCalls.last.all, isTrue);
  });

  testWidgets('an export shares the file built from every row', (t) async {
    final fakes = FinanceFakes();
    final shared = <(ReportPayload, ReportFormat)>[];
    await pumpFinance(t, ReportViewScreen(kind: 'sales', share: (p, f) async => shared.add((p, f))), fakes: fakes);
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('report-export')));
    await t.pumpAndSettle();
    await t.tap(find.text('PDF'));
    await t.pumpAndSettle();
    expect(shared.single.$2, ReportFormat.pdf);
    expect(fakes.reports.runCalls.last.all, isTrue);
  });

  testWidgets('an empty report shows the empty line and export is off', (t) async {
    final fakes = FinanceFakes();
    fakes.reports.payload = ReportPayload.fromJson(p6('report_empty'));
    await pumpFinance(t, const ReportViewScreen(kind: 'cancellation'), fakes: fakes);
    await t.pumpAndSettle();
    expect(find.text('No rows for these dates and filters.'), findsOneWidget);
    expect(t.widget<IconButton>(find.byKey(const Key('report-export'))).onPressed, isNull);
  });
}
