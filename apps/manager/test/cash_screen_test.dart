import 'package:deligro_manager/features/cash/cash_screen.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'rider_helpers.dart';

const _cashier = {...riderViewer, 'manager.cash'};

Future<RiderFakes> _pump(WidgetTester tester, {RiderFakes? fakes}) async {
  final f = fakes ?? RiderFakes();
  await pumpRider(tester, const CashScreen(), fakes: f, permissions: _cashier, size: const Size(420, 1000));
  return f;
}

Future<void> _tab(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(Key('cash-tab-$key')));
  await tester.pump();
  await tester.tap(find.byKey(Key('cash-tab-$key')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('submitted deposits are listed, with the counts from the server', (tester) async {
    final fakes = await _pump(tester);
    expect(fakes.cash.depositCalls.first, 'submitted');
    expect(find.text('Deposits (3)'), findsOneWidget);
    expect(find.text('Disputes (1)'), findsOneWidget);
    expect(find.text('₹2,400'), findsOneWidget);
    expect(find.text('Ravi Kumar · DR-0007'), findsOneWidget);
  });

  testWidgets('Confirm is sent once on a double tap', (tester) async {
    final fakes = await _pump(tester);
    final btn = find.byKey(const Key('deposit-confirm-cd-1'));
    await tester.tap(btn);
    await tester.tap(btn, warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(fakes.cash.decideCalls, hasLength(1));
    expect(fakes.cash.decideCalls.single.decision.confirm, isTrue);
  });

  testWidgets('Dispute without a note keeps Submit off', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('deposit-dispute-cd-1')));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
  });

  testWidgets('already_decided says so and re-reads the list', (tester) async {
    final fakes = RiderFakes();
    fakes.cash.depositOutcomes.add(const Refused('already_decided'));
    await _pump(tester, fakes: fakes);
    final before = fakes.cash.depositCalls.length;
    await tester.tap(find.byKey(const Key('deposit-confirm-cd-1')));
    await tester.pumpAndSettle();
    expect(find.text('Already handled by someone else.'), findsOneWidget);
    expect(fakes.cash.depositCalls.length, greaterThan(before));
  });

  testWidgets('Resolve needs at least three characters', (tester) async {
    final fakes = await _pump(tester);
    await _tab(tester, 'disputes');
    await tester.tap(find.byKey(const Key('dispute-resolve-cx-1')));
    await tester.pumpAndSettle();
    final submit = find.byKey(const Key('reason-submit'));
    await tester.enterText(find.byType(TextField).last, 'ok');
    await tester.pump();
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.enterText(find.byType(TextField).last, 'Recounted, rider was right');
    await tester.pump();
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(fakes.cash.resolveCalls.single.resolution.resolution, 'Recounted, rider was right');
  });

  testWidgets('History asks for decided deposits', (tester) async {
    final fakes = await _pump(tester);
    await _tab(tester, 'history');
    expect(fakes.cash.depositCalls, containsAll(['confirmed', 'disputed']));
    expect(find.text('Nothing decided yet.'), findsOneWidget);
  });
}
