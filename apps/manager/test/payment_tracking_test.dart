import 'package:deligro_manager/core/push.dart';
import 'package:deligro_manager/features/finance/issues_screen.dart';
import 'package:deligro_manager/features/finance/rider_dues_screen.dart';
import 'package:deligro_manager/features/finance/rider_payouts_screen.dart';
import 'package:deligro_manager/features/finance/settlement_detail_screen.dart';
import 'package:deligro_manager/features/finance/settlements_screen.dart';
import 'package:deligro_manager/features/finance/vendor_dues_screen.dart';
import 'package:deligro_manager/models/settlement.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'finance_helpers.dart';

void main() {
  testWidgets('vendor dues: delayed marked, "Delayed only" asks the server', (t) async {
    final fakes = FinanceFakes();
    await pumpFinance(t, const VendorDuesScreen(), fakes: fakes);
    await t.pumpAndSettle();
    expect(find.text('Spice Hub'), findsOneWidget);
    expect(find.text('Delayed'), findsOneWidget);
    expect(find.textContaining('Shop owes Deligro ₹340'), findsOneWidget);
    expect(fakes.finance.vendorDuesCalls.last.delayed, isFalse);
    await t.tap(find.text('Delayed only'));
    await t.pumpAndSettle();
    expect(fakes.finance.vendorDuesCalls.last.delayed, isTrue);
    expect(find.text('Green Leaf Cafe'), findsNothing);
  });

  testWidgets('rider dues show paise only where there are some', (t) async {
    await pumpFinance(t, const RiderDuesScreen());
    await t.pumpAndSettle();
    expect(find.text('₹12,000.50'), findsOneWidget);
    expect(find.text('₹9,000'), findsOneWidget);
    expect(find.textContaining('Waiting for approval'), findsOneWidget);
  });

  testWidgets('settlement history: the status filter maps to status=', (t) async {
    final fakes = FinanceFakes();
    await pumpFinance(t, const SettlementsScreen(), fakes: fakes);
    await t.pumpAndSettle();
    expect(fakes.finance.settlementCalls.last.status, SettlementFilter.all);
    await t.tap(find.widgetWithText(ChoiceChip, 'Awaiting approval'));
    await t.pumpAndSettle();
    expect(fakes.finance.settlementCalls.last.status, SettlementFilter.awaiting);
    expect(fakes.finance.settlementCalls.last.toQuery()['status'], 'pending_approval');
  });

  testWidgets('settlement history opens on a status from the link', (t) async {
    final fakes = FinanceFakes();
    await pumpFinance(t, SettlementsScreen(query: Uri.parse('/finance/settlements?status=paid')), fakes: fakes);
    await t.pumpAndSettle();
    expect(fakes.finance.settlementCalls.last.status, SettlementFilter.paid);
  });

  testWidgets('the transaction reference is shown in full and copies', (t) async {
    String? copied;
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    await pumpFinance(t, const SettlementsScreen());
    await t.pumpAndSettle();
    expect(find.text('UTR1234567890ABC'), findsOneWidget);
    expect(find.byType(SelectableText), findsWidgets);
    await t.tap(find.byKey(const Key('copy-ref-s-1')));
    await t.pump();
    expect(copied, 'UTR1234567890ABC');
  });

  testWidgets('settlement detail: an outstanding correction is spelled out', (t) async {
    await pumpFinance(t, const SettlementDetailScreen(settlementId: 's-2'));
    await t.pumpAndSettle();
    expect(find.text('Refund approved after this payout — correction outstanding ₹120'), findsOneWidget);
    expect(find.text('AB12CD34'), findsOneWidget);
    expect(find.text('Awaiting approval'), findsWidgets);
    expect(find.text('−₹177'), findsOneWidget);
  });

  testWidgets('issues are grouped with counts; each opens its subject', (t) async {
    final opened = await pumpFinanceRouter(t, (_) => const IssuesScreen(), size: const Size(400, 2400));
    await t.pumpAndSettle();
    expect(find.textContaining('ONLINE PAYMENTS FAILED (1)'), findsWidgets);
    final targets = {
      'AB12CD34': '/orders/o-1',
      'Spice Hub': '/more/vendors/v-1',
      'Green Leaf Cafe': '/finance/settlements/s-2',
      'Sunil Verma': '/more/approvals?id=pr-2',
      'Ravi Kumar': '/more/riders/r-1',
    };
    for (final e in targets.entries) {
      await t.tap(find.text(e.key).first);
      await t.pumpAndSettle();
      expect(opened.last, e.value, reason: e.key);
      final nav = t.state<NavigatorState>(find.byType(Navigator).first);
      nav.pop();
      await t.pumpAndSettle();
    }
  });

  testWidgets('rider payouts carry the reference and who approved', (t) async {
    await pumpFinance(t, const RiderPayoutsScreen());
    await t.pumpAndSettle();
    expect(find.text('UTR998877'), findsOneWidget);
    expect(find.text('₹9,000.50'), findsOneWidget);
  });

  test('a settlement push opens that settlement', () {
    expect(inAppPathFrom(null, {'type': 'settlement', 'id': 'abcdef12'}), '/finance/settlements/abcdef12');
    expect(inAppPathFrom('/finance/settlements/abcdef12', null), '/finance/settlements/abcdef12');
    expect(inAppPathFrom('/finance/vendor-dues', null), '/finance/vendor-dues');
    expect(inAppPathFrom('/finance/nowhere', null), '/finance');
  });
}
