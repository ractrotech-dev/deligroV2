// Writes sample invoice / receipt / statement / report PDFs to
// test_screens/out/ for review. Not part of `flutter test` (outside test/).
//   flutter test test_screens/docs_test.dart
import 'dart:io';

import 'package:deligro_partner/core/documents.dart';
import 'package:deligro_partner/models/money.dart';
import 'package:deligro_partner/models/order.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

import '../test/money_test.dart' show reportJson;
import '../test/support/fakes.dart';

void main() {
  testWidgets('sample documents', (t) async {
    await initializeDateFormatting('en_IN');
    await t.runAsync(() async {
      final fonts = await DocFonts.load();
      final json = fakeOrderJson('aa11aa11-0000-0000-0000-000000000001', status: 'delivered')
        ..['invoiceNo'] = 'INV/2026-27/00042'
        ..['invoiceAt'] = '2026-10-20T08:30:00Z'
        ..['lines'] = [
          {'name': 'Paneer Tikka', 'qty': 2, 'price': 180},
          {'name': 'Chicken Biryani (Full)', 'qty': 1, 'price': 310, 'addons': ['Mint raita', 'Egg']},
          {'name': 'Garlic Naan', 'qty': 2, 'price': 40},
        ];
      final o = VendorOrder.fromJson(json);
      const shop = InvoiceProfile(
        name: 'Spice Hub Restaurant',
        address: 'Station Road, near bus stand, Bemetara 491335',
        phone: '+91 98765 43210',
        gstin: '22AAAAA0000A1Z5',
        fssai: '12345678901234',
      );
      File('test_screens/out/invoice.pdf').writeAsBytesSync(await invoicePdf(o, shop, fonts));
      File('test_screens/out/receipt.pdf').writeAsBytesSync(await receiptPdf(o, shop, fonts));
      File('test_screens/out/report.pdf').writeAsBytesSync(await reportPdf(SalesReport.fromJson(reportJson()), 'All orders', fonts));
    });
  });
}
