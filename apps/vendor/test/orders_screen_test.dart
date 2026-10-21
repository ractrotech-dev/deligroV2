import 'package:deligro_partner/core/api.dart';
import 'package:deligro_partner/router.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  late MockOrdersRepo repo;
  setUp(() {
    repo = MockOrdersRepo();
    when(repo.board).thenAnswer((_) async => fakeBoard());
    when(
      () => repo.history(
        kind: any(named: 'kind'),
        range: any(named: 'range'),
        date: any(named: 'date'),
        search: any(named: 'search'),
        limit: any(named: 'limit'),
      ),
    ).thenAnswer(
      (_) async => (orders: [fakeOrder('ff66ff66-0000-0000-0000-000000000006', status: 'delivered')], total: 1),
    );
    when(() => repo.detail(any())).thenAnswer((i) async => fakeOrder(i.positionalArguments.first as String));
  });

  Future<void> openOrders(WidgetTester t, {Brightness b = Brightness.light, double scale = 1}) async {
    final c = await pumpPartner(
      t,
      router: (ref) => ref.watch(routerProvider),
      overrides: ordersOverrides(repo),
      b: b,
      scale: scale,
    );
    c.read(routerProvider).go('/orders');
    await t.pumpAndSettle();
  }

  testPartner('chips count each live stage', (t) async {
    await openOrders(t);
    expect(find.text('All (5)'), findsOneWidget);
    expect(find.text('New (1)'), findsOneWidget);
    expect(find.text('Accepted (1)'), findsOneWidget);
    expect(find.text('Preparing (1)'), findsOneWidget);
    expect(find.text('Ready (1)'), findsOneWidget);
    expect(find.text('Out for delivery (1)'), findsOneWidget);
  });

  testPartner('a chip filters the list', (t) async {
    await openOrders(t);
    await t.ensureVisible(find.text('Preparing (1)'));
    await t.pumpAndSettle();
    await t.tap(find.text('Preparing (1)'));
    await t.pumpAndSettle();
    expect(find.text('#D-CC33'), findsOneWidget);
    expect(find.text('#D-AA11'), findsNothing);
  });

  testPartner('search finds by customer name and by order ID', (t) async {
    await openOrders(t);
    await t.enterText(find.byType(TextField).first, 'ravi');
    await t.pumpAndSettle();
    expect(find.text('#D-BB22'), findsOneWidget);
    expect(find.text('#D-AA11'), findsNothing);
    await t.enterText(find.byType(TextField).first, 'dd44');
    await t.pumpAndSettle();
    expect(find.text('#D-DD44'), findsOneWidget);
  });

  testPartner('a failed refresh keeps the board and says so', (t) async {
    await openOrders(t);
    when(repo.board).thenThrow(ApiException(0, 'network'));
    await t.drag(find.text('#D-AA11'), const Offset(0, 400));
    await t.pumpAndSettle();
    expect(find.textContaining('Can\'t refresh'), findsOneWidget);
    expect(find.text('#D-AA11'), findsOneWidget);
  });

  testPartner('past orders show completed ones', (t) async {
    await openOrders(t);
    await t.tap(find.text('Past'));
    await t.pumpAndSettle();
    expect(find.text('#D-FF66'), findsOneWidget);
    expect(find.text('1 orders'), findsOneWidget);
  });

  testPartner('tapping an order opens it', (t) async {
    await openOrders(t);
    await t.tap(find.text('#D-AA11'));
    await t.pumpAndSettle();
    expect(find.text('Accept'), findsOneWidget);
    expect(find.text('Paneer Tikka'), findsOneWidget);
  });

  for (final (b, scale, name) in [
    (Brightness.light, 1.0, 'light'),
    (Brightness.dark, 1.0, 'dark'),
    (Brightness.light, 1.3, 'large text'),
  ]) {
    testPartner('live and past render without overflow ($name)', (t) async {
      await openOrders(t, b: b, scale: scale);
      expect(t.takeException(), isNull);
      await t.tap(find.text('Past'));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
    });
  }
}
