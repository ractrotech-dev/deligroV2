import 'package:deligro_partner/features/orders/order_detail_screen.dart';
import 'package:deligro_partner/models/order.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

const _id = 'aa11aa11-0000-0000-0000-000000000001';

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  late MockOrdersRepo repo;
  setUp(() {
    repo = MockOrdersRepo();
    when(repo.board).thenAnswer((_) async => fakeBoard());
  });

  Future<void> open(
    WidgetTester t,
    Map<String, dynamic> json, {
    Map<String, bool>? features,
    Brightness b = Brightness.light,
    double scale = 1,
  }) async {
    when(() => repo.detail(_id)).thenAnswer((_) async => VendorOrder.fromJson(json));
    await pumpPartner(
      t,
      child: const OrderDetailScreen(orderId: _id),
      overrides: ordersOverrides(repo, me: fakeMe(features: features ?? const {'vendor.reject_orders': true})),
      b: b,
      scale: scale,
    );
    await t.pumpAndSettle();
  }

  testPartner('shows every §3 field of a new order', (t) async {
    await open(
      t,
      fakeOrderJson(
        _id,
        events: [
          {'kind': 'status', 'from': null, 'to': 'placed', 'by': 'customer', 'at': DateTime.now().toIso8601String()},
        ],
      ),
    );
    expect(find.text('New'), findsOneWidget);
    expect(find.text('Asha Verma'), findsOneWidget);
    expect(find.text('Paneer Tikka'), findsOneWidget);
    expect(find.text('2×'), findsNWidgets(2));
    expect(find.text('₹180 each'), findsOneWidget);
    expect(find.text('Discount (FLAT10)'), findsOneWidget);
    expect(find.text('Funded by you'), findsOneWidget);
    expect(find.text('Delivery fee'), findsOneWidget);
    expect(find.text('Taxes'), findsOneWidget);
    expect(find.text('Rider tip'), findsOneWidget);
    expect(find.text('₹553'), findsOneWidget);
    expect(find.text('Cash'), findsOneWidget);
    expect(find.text('Call'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Order placed'), 200);
    expect(find.text('Order placed'), findsOneWidget);
  });

  testPartner('shows the add-ons the customer chose', (t) async {
    final json = fakeOrderJson(_id)
      ..['lines'] = [
        {
          'name': 'Chicken Biryani (Full)',
          'qty': 1,
          'price': 310,
          'addons': ['Mint raita', 'Egg'],
        },
      ];
    await open(t, json);
    expect(find.text('Chicken Biryani (Full)'), findsOneWidget);
    expect(find.text('+ Mint raita, Egg'), findsOneWidget);
  });

  testPartner('accept asks for the prep time and sends it', (t) async {
    when(() => repo.accept(_id, prepMinutes: any(named: 'prepMinutes'))).thenAnswer((_) async {});
    await open(t, fakeOrderJson(_id));
    await t.tap(find.text('Accept'));
    await t.pumpAndSettle();
    expect(find.text('How long until it\'s ready for pickup?'), findsOneWidget);
    await t.tap(find.text('30 min'));
    await t.pumpAndSettle();
    await t.tap(find.text('Accept · ready in 30 min'));
    await t.pumpAndSettle();
    verify(() => repo.accept(_id, prepMinutes: 30)).called(1);
    expect(find.text('Order accepted'), findsOneWidget);
  });

  testPartner('reject sends the customer-facing reason', (t) async {
    when(() => repo.reject(_id, any())).thenAnswer((_) async {});
    await open(t, fakeOrderJson(_id));
    await t.tap(find.text('Reject'));
    await t.pumpAndSettle();
    await t.tap(find.text('One of the items is out of stock'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(FilledButton, 'Reject order'));
    await t.pumpAndSettle();
    verify(() => repo.reject(_id, 'One of the items is out of stock')).called(1);
  });

  testPartner('no Reject button when the shop may not reject', (t) async {
    await open(t, fakeOrderJson(_id), features: const {'vendor.reject_orders': false});
    expect(find.text('Reject'), findsNothing);
    expect(find.text('Accept'), findsOneWidget);
  });

  testPartner('accepted and preparing orders offer no kitchen step: Accept is the only action', (t) async {
    await open(t, fakeOrderJson(_id, status: 'kitchen'));
    expect(find.text('Start preparing'), findsNothing);
    expect(find.text('Mark ready for pickup'), findsNothing);
    await open(t, fakeOrderJson(_id, status: 'kitchen', preparingAt: DateTime.now().toIso8601String()));
    expect(find.text('Mark ready for pickup'), findsNothing);
  });

  testPartner('a ready order shows its rider and no handover code', (t) async {
    await open(t, fakeOrderJson(_id, status: 'ready', rider: 'Ravi'));
    expect(find.textContaining('this code'), findsNothing);
    expect(find.text('Ravi is on the way to you'), findsOneWidget);
  });

  testPartner('a cancelled order shows why', (t) async {
    await open(t, fakeOrderJson(_id, status: 'cancelled', cancellationReason: 'One of the items is out of stock'));
    await t.scrollUntilVisible(find.text('One of the items is out of stock'), 200);
    expect(find.text('One of the items is out of stock'), findsOneWidget);
    expect(find.text('Accept'), findsNothing);
  });

  for (final (b, scale, name) in [
    (Brightness.light, 1.0, 'light'),
    (Brightness.dark, 1.0, 'dark'),
    (Brightness.light, 1.3, 'large text'),
  ]) {
    testPartner('renders without overflow ($name)', (t) async {
      await open(
        t,
        fakeOrderJson(_id, status: 'ready', rider: 'Ravi'),
        b: b,
        scale: scale,
      );
      expect(t.takeException(), isNull);
    });
  }
}
