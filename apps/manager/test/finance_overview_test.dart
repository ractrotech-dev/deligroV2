import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/finance/finance_figures.dart';
import 'package:deligro_manager/features/finance/finance_screen.dart';
import 'package:deligro_manager/models/finance.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_finance_repository.dart';
import 'finance_helpers.dart';

void main() {
  const salesLabels = [
    'Total gross sales',
    'Net sales',
    'Platform commission',
    'Vendor-funded discounts',
    'Deligro-funded discounts',
    'Refunds and adjustments',
    'Delivery fees collected',
    'Rider delivery earnings',
    'Vendor earnings payable',
    'Rider earnings payable',
  ];
  const paymentLabels = [
    'Vendor payments due',
    'Vendor payments completed',
    'Rider payouts due',
    'Rider payouts completed',
    'Failed or delayed transactions',
    'Pending approvals',
  ];

  test('refunds on cancelled orders are explained, not silently left out', () {
    final j = p6('finance_overview');
    (j['sales'] as Map<String, dynamic>)['refunds'] = {'total': 900, 'count': 3, 'onCancelled': 250};
    final refunds = salesFigures(FinanceOverview.fromJson(j)).firstWhere((f) => f.label == 'Refunds and adjustments');
    expect(refunds.detail, contains('₹250 on cancelled orders'));
    expect(refunds.detail, contains('not off net sales'));
  });

  test('figures come in the document\'s order and words', () {
    final o = FinanceOverview.fromJson(p6('finance_overview'));
    expect(salesFigures(o).map((f) => f.label), salesLabels);
    expect(paymentFigures(o).map((f) => f.label), paymentLabels);
    final deligro = salesFigures(o).firstWhere((f) => f.label == 'Deligro-funded discounts');
    expect(deligro.value, '₹6,920');
    // Rider money shows paise only when there are some.
    expect(salesFigures(o).firstWhere((f) => f.label == 'Rider delivery earnings').value, '₹48,000.50');
    expect(salesFigures(o).firstWhere((f) => f.label == 'Rider earnings payable').value, '₹24,000');
    final commission = salesFigures(o).firstWhere((f) => f.label == 'Platform commission');
    expect(commission.detail, contains('GST ₹4,923'));
    expect(paymentFigures(o).firstWhere((f) => f.label == 'Vendor payments due').route, '/finance/vendor-dues');
    expect(paymentFigures(o).firstWhere((f) => f.label == 'Pending approvals').route,
        '/more/approvals?kind=vendor_settlement');
  });

  testWidgets('renders every figure label in order, cancelled apart', (t) async {
    await pumpFinance(t, const FinanceScreen());
    await t.pumpAndSettle();
    var lastY = -1.0;
    for (final l in [...salesLabels]) {
      final y = t.getTopLeft(find.text(l).first).dy;
      expect(y, greaterThan(lastY), reason: l);
      lastY = y;
    }
    expect(find.text('₹6,920'), findsOneWidget);
    expect(find.textContaining('Cancelled orders'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Pending approvals'), 300, scrollable: find.byType(Scrollable).first);
    for (final l in paymentLabels) {
      expect(find.text(l), findsOneWidget);
    }
  });

  testWidgets('tapping Vendor payments due opens the dues list', (t) async {
    final opened = await pumpFinanceRouter(t, (_) => const FinanceScreen());
    await t.pumpAndSettle();
    await t.scrollUntilVisible(find.text('Vendor payments due'), 300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Vendor payments due'));
    await t.pumpAndSettle();
    expect(opened.last, '/finance/vendor-dues');
  });

  testWidgets('a permission refusal says finance is off for this account', (t) async {
    final fakes = FinanceFakes();
    fakes.finance.readError = ApiException(403, 'permission_denied');
    await pumpFinance(t, const FinanceScreen(), fakes: fakes);
    await t.pumpAndSettle();
    expect(find.text("Finance isn't switched on for your account"), findsOneWidget);
  });

  testWidgets('a fault offers Retry, which reloads', (t) async {
    final fakes = FinanceFakes();
    fakes.finance.readError = ApiException(500, 'server_error');
    await pumpFinance(t, const FinanceScreen(), fakes: fakes);
    await t.pumpAndSettle();
    expect(find.text('Retry'), findsOneWidget);
    await t.tap(find.text('Retry'));
    await t.pumpAndSettle();
    expect(find.text('Total gross sales'), findsOneWidget);
  });

  testWidgets('period chips change the range asked for', (t) async {
    final fakes = FinanceFakes();
    await pumpFinance(t, const FinanceScreen(), fakes: fakes);
    await t.pumpAndSettle();
    final first = fakes.finance.overviewCalls.last;
    await t.tap(find.text('Today'));
    await t.pumpAndSettle();
    final today = fakes.finance.overviewCalls.last;
    expect(today.from, today.to);
    expect(first.from, isNot(first.to));
  });

  testWidgets('at 840 dp and wider the two groups sit side by side', (t) async {
    await pumpFinance(t, const FinanceScreen(), size: const Size(1100, 1400));
    await t.pumpAndSettle();
    final sales = t.getTopLeft(find.text('SALES AND COMMISSION'));
    final pay = t.getTopLeft(find.text('PAYMENTS'));
    expect(pay.dx, greaterThan(sales.dx + 200));
    expect((pay.dy - sales.dy).abs(), lessThan(40));
  });
}
