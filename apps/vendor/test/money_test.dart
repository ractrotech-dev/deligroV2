import 'dart:convert';

import 'package:archive/archive.dart';
import 'package:deligro_partner/core/documents.dart';
import 'package:deligro_partner/core/export.dart';
import 'package:deligro_partner/data/money_repository.dart';
import 'package:deligro_partner/features/payments/payments_screen.dart';
import 'package:deligro_partner/features/reports/sales_report_view.dart';
import 'package:deligro_partner/models/money.dart';
import 'package:deligro_partner/models/order.dart';
import 'package:deligro_partner/state/money.dart';
import 'package:deligro_partner/state/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

class MockMoneyRepo extends Mock implements MoneyRepository {}

Map<String, dynamic> paymentsJson({int due = 8650}) => {
  'totalEarnings': 248600,
  'amountSettled': 239950,
  'paymentDue': due,
  'paidOrders': 482,
  'unpaidOrders': 6,
  'partlyPaidOrders': 1,
  'outstandingCorrections': 0,
  'settlementCycle': 'weekly',
  'commissionPct': 18,
  'settlements': [
    {
      'id': 's1',
      'periodLabel': '6–12 Oct 2026',
      'orderCount': 41,
      'foodGross': 21400,
      'charges': 4545,
      'refundsRecovered': 0,
      'netPayable': 16855,
      'status': 'paid',
      'paidAt': '2026-10-14T06:00:00Z',
      'paymentRef': 'UTR123',
    },
    {
      'id': 's0',
      'periodLabel': '29 Sep–5 Oct 2026',
      'orderCount': 3,
      'foodGross': 900,
      'charges': 190,
      'refundsRecovered': 0,
      'netPayable': 710,
      'status': 'void',
      'paidAt': null,
      'paymentRef': null,
    },
  ],
  'unpaid': [
    {
      'orderId': 'o1',
      'code': '#A1B2C3',
      'deliveredAt': '2026-10-20T08:00:00Z',
      'paymentMethod': 'online',
      'sale': 500,
      'charges': 106,
      'earnings': 394,
      'contribution': 394,
    },
    {
      'orderId': 'o2',
      'code': '#D4E5F6',
      'deliveredAt': '2026-10-20T09:00:00Z',
      'paymentMethod': 'cod',
      'sale': 300,
      'charges': 64,
      'earnings': 236,
      'contribution': -64,
    },
  ],
};

Map<String, dynamic> reportJson() => {
  'from': '2026-10-01',
  'to': '2026-10-21',
  'shop': 'Spice Hub Restaurant',
  'includesMoney': true,
  'rows': [
    {
      'orderId': 'o1',
      'code': '#A1B2C3',
      'createdAt': '2026-10-20T08:00:00Z',
      'stage': 'completed',
      'paymentMethod': 'online',
      'paymentStatus': 'paid',
      'total': 560,
      'sale': 500,
      'gross': 520,
      'vendorDiscount': 20,
      'refund': 0,
      'net': 500,
      'charges': 106,
      'earnings': 394,
      'settlement': 'unsettled',
    },
    {
      'orderId': 'o3',
      'code': '#Z9Y8X7',
      'createdAt': '2026-10-19T08:00:00Z',
      'stage': 'cancelled',
      'paymentMethod': 'cod',
      'paymentStatus': 'pending',
      'total': 200,
      'sale': 180,
      'gross': 180,
      'vendorDiscount': 0,
      'refund': 0,
      'net': 180,
      'charges': null,
      'earnings': null,
      'settlement': null,
    },
  ],
  'totals': {
    'orders': 2,
    'completed': 1,
    'cancelled': 1,
    'inProgress': 0,
    'sales': 500,
    'grossSales': 520,
    'netSales': 500,
    'refunds': 0,
    'vendorDiscounts': 20,
    'charges': 106,
    'earnings': 394,
    'settled': 0,
    'unsettled': 394,
    'codOrders': 1,
    'onlineOrders': 1,
    'cancelledValue': 180,
  },
};

void main() {
  setUpAll(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await initializeDateFormatting('en_IN');
    registerFallbackValue(const ReportQuery(from: '', to: ''));
  });

  group('exports', () {
    const table = ExportTable(
      title: 'Sales',
      headers: ['Order', 'Customer', 'Sale'],
      rows: [
        ['#A1', 'Asha, "AV"', 500],
        ['#A2', '=HYPERLINK("x")', 120],
        ['#A3', null, 0],
      ],
    );

    test('CSV: BOM, quoting, and no formula injection', () {
      final bytes = toCsv(table);
      expect(bytes.sublist(0, 3), [0xEF, 0xBB, 0xBF], reason: 'a UTF-8 BOM, so Excel reads ₹ correctly');
      final csv = utf8.decode(bytes.sublist(3));
      final lines = csv.trim().split('\n').map((l) => l.trim()).toList();
      expect(lines[0], 'Order,Customer,Sale');
      expect(lines[1], '#A1,"Asha, ""AV""",500');
      expect(lines[2], startsWith('#A2,"\'=HYPERLINK'));
      expect(lines[3], '#A3,,0');
    });

    test('XLSX: a valid workbook with numbers kept as numbers', () {
      final zip = ZipDecoder().decodeBytes(toXlsx(table));
      final names = zip.files.map((f) => f.name).toSet();
      expect(
        names,
        containsAll(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']),
      );
      final sheet = utf8.decode(zip.findFile('xl/worksheets/sheet1.xml')!.content as List<int>);
      expect(sheet, contains('<c r="C2"><v>500</v></c>'));
      expect(sheet, contains('Asha, &quot;AV&quot;'));
      expect(sheet, contains('<c r="A1" s="1" t="inlineStr">'));
    });

    test('file names', () => expect(fileSlug('Settlement 6–12 Oct 2026'), 'settlement-6-12-oct-2026'));
  });

  group('documents', () {
    final order = VendorOrder.fromJson(
      fakeOrderJson('aa11aa11-0000-0000-0000-000000000001', status: 'delivered')
        ..['invoiceNo'] = 'INV/2026-27/00042'
        ..['invoiceAt'] = '2026-10-20T08:30:00Z',
    );
    const shop = InvoiceProfile(
      name: 'Spice Hub Restaurant',
      address: 'Station Road, Bemetara',
      gstin: '22AAAAA0000A1Z5',
      fssai: '12345678901234',
    );

    test('GST splits into halves that add back up', () {
      expect(splitGst(27), (cgst: 13, sgst: 14));
      expect(splitGst(0), (cgst: 0, sgst: 0));
    });

    test('bill rows: items, discount by whom, fee, CGST/SGST, tip', () {
      final rows = billRows(order);
      expect(rows.first, ('Item total', 530));
      expect(rows.any((r) => r.$1.startsWith('Discount (FLAT10)') && r.$2 == -43), isTrue);
      expect(rows.where((r) => r.$1 == 'CGST' || r.$1 == 'SGST').fold(0, (s, r) => s + r.$2), 27);
      expect(rows.last, ('Rider tip', 10));
    });

    testWidgets('invoice, receipt, statement and report render as PDFs', (t) async {
      await t.runAsync(() async {
        final fonts = await DocFonts.load();
        bool isPdf(List<int> b) => b.length > 1000 && ascii.decode(b.sublist(0, 5)) == '%PDF-';
        expect(isPdf(await invoicePdf(order, shop, fonts)), isTrue);
        expect(isPdf(await receiptPdf(order, shop, fonts)), isTrue);
        expect(
          isPdf(
            await statementPdf(
              Statement.fromJson({
                'id': 's1',
                'shopName': 'Spice Hub',
                'periodLabel': '6–12 Oct',
                'status': 'paid',
                'paidAt': '2026-10-14T06:00:00Z',
                'commissionPct': 18,
                'commissionGstPct': 18,
                'otherChargesPerOrder': 0,
                'foodGross': 500,
                'commission': 90,
                'commissionGst': 16,
                'otherCharges': 0,
                'refundsRecovered': 0,
                'netPayable': 394,
                'lines': [
                  paymentsJson()['unpaid'][0]
                    ..['platformDiscount'] = 0
                    ..['commission'] = 90
                    ..['commissionGst'] = 16
                    ..['otherCharges'] = 0
                    ..['refundRecovered'] = 0,
                ],
              }),
              fonts,
            ),
          ),
          isTrue,
        );
        expect(isPdf(await reportPdf(SalesReport.fromJson(reportJson()), 'All orders', fonts)), isTrue);
      });
    });

    test('report cells keep money as numbers and say when it is unknown', () {
      final r = SalesReport.fromJson(reportJson());
      expect(reportCells(r.rows[0], true), ['#A1B2C3', isA<String>(), 'Completed', 'Online', 520, 20, 0, 500, 106, 394, 'Unsettled']);
      expect(reportCells(r.rows[1], true).sublist(8), [null, null, '']);
      expect(reportHeaders(true).length, reportCells(r.rows[0], true).length);
      expect(reportRangeLabel('2026-10-01', '2026-10-21'), '1 Oct – 21 Oct 2026');
    });
  });

  group('payments screen', () {
    late MockMoneyRepo repo;
    setUp(() => repo = MockMoneyRepo());

    Future<void> open(WidgetTester t, Widget screen) => pumpPartner(
      t,
      child: screen,
      overrides: [moneyRepoProvider.overrideWithValue(repo), vendorMeProvider.overrideWith(() => FixedMe(fakeMe()))],
    );

    testPartner('shows what is due, the figures and the settlements', (t) async {
      when(repo.payments).thenAnswer((_) async => Payments.fromJson(paymentsJson()));
      await open(t, const PaymentsScreen());
      await t.pumpAndSettle();
      expect(find.text('Payment due to you'), findsOneWidget);
      expect(find.text('₹8,650'), findsOneWidget);
      expect(find.text('₹2,48,600'), findsOneWidget);
      expect(find.text('1 partly paid'), findsOneWidget);
      expect(find.text('How it adds up'.toUpperCase()), findsOneWidget);
      await t.scrollUntilVisible(find.text('6–12 Oct 2026'), 300, scrollable: find.byType(Scrollable).first);
      expect(find.text('6–12 Oct 2026'), findsOneWidget);
      expect(find.text('Voided · 3 orders'), findsOneWidget);
      await t.tap(find.text('Unpaid · 2'));
      await t.pumpAndSettle();
      expect(find.text('-₹64 payout'.replaceFirst('-', '')), findsNothing);
      expect(find.text('−₹64 payout'), findsOneWidget);
    });

    testPartner('a negative balance says the shop owes Deligro', (t) async {
      when(repo.payments).thenAnswer((_) async => Payments.fromJson(paymentsJson(due: -420)));
      await open(t, const PaymentsScreen());
      await t.pumpAndSettle();
      expect(find.text('You owe Deligro'), findsOneWidget);
      expect(find.text('₹420'), findsOneWidget);
    });

    testPartner('sales report shows totals and asks again when a filter changes', (t) async {
      when(() => repo.report(any())).thenAnswer((_) async => SalesReport.fromJson(reportJson()));
      await open(t, const Scaffold(body: SalesReportView()));
      await t.pumpAndSettle();
      expect(find.text('₹394'), findsWidgets);
      expect(find.text('2 orders'.toUpperCase()), findsOneWidget);
      await t.tap(find.text('Today'));
      await t.pumpAndSettle();
      final queries = verify(() => repo.report(captureAny())).captured.cast<ReportQuery>();
      expect(queries.length, 2);
      expect(queries.last.from, isNot(queries.first.from));
    });
  });
}
