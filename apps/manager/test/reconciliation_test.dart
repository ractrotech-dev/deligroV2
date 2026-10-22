import 'package:deligro_manager/features/finance/reconciliation_screen.dart';
import 'package:deligro_manager/features/shell/nav.dart';
import 'package:deligro_manager/models/finance.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'finance_helpers.dart';

void main() {
  testWidgets('orders: summary chips filter by state', (t) async {
    final fakes = FinanceFakes();
    await pumpFinance(t, const ReconciliationScreen(), fakes: fakes);
    await t.pumpAndSettle();
    expect(fakes.finance.reconCalls.last.section, ReconSection.orders);
    expect(find.text('Mismatch (1)'), findsOneWidget);
    await t.tap(find.text('Mismatch (1)'));
    await t.pumpAndSettle();
    expect(fakes.finance.reconCalls.last.state, 'paid_mismatch');
  });

  testWidgets('a negative difference is red, a positive one is not', (t) async {
    await pumpFinance(t, const ReconciliationScreen());
    await t.pumpAndSettle();
    final neg = find.text('−₹120');
    expect(neg, findsOneWidget);
    final colors = t.element(neg).colors;
    expect(t.widget<Text>(neg).style?.color, colors.deal);
    expect(t.widget<Text>(find.text('₹410')).style?.color, isNot(colors.deal));
  });

  testWidgets('switching to Online payments and Cash asks for those sections', (t) async {
    final fakes = FinanceFakes();
    await pumpFinance(t, const ReconciliationScreen(), fakes: fakes);
    await t.pumpAndSettle();
    await t.tap(find.text('Online payments'));
    await t.pumpAndSettle();
    expect(fakes.finance.reconCalls.last.section, ReconSection.online);
    expect(find.text('MN56OP78'), findsOneWidget);
    await t.tap(find.text('Cash'));
    await t.pumpAndSettle();
    expect(fakes.finance.reconCalls.last.section, ReconSection.cash);
    expect(find.text('Sunil Verma'), findsOneWidget);
    expect(find.text('Disputed'), findsWidgets);
    expect(find.textContaining('Vikram'), findsOneWidget);
  });

  testWidgets('a cash-only manager sees only the Cash section', (t) async {
    final fakes = FinanceFakes();
    await pumpFinance(t, const ReconciliationScreen(), fakes: fakes, permissions: {'manager.cash'});
    await t.pumpAndSettle();
    expect(find.text('Online payments'), findsNothing);
    expect(fakes.finance.reconCalls.last.section, ReconSection.cash);
  });

  test('cash-only managers reach it from More → Cash', () {
    expect(permissionFor('/more/cash/reconciliation'), 'manager.cash');
    expect(permissionFor('/finance/reconciliation'), 'manager.finance.view');
  });
}
