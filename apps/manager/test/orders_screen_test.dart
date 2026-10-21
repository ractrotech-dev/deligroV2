import 'package:deligro_manager/features/orders/orders_screen.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/widgets/async_view.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'auth_test.dart' show meJson;
import 'fakes/fake_orders_repository.dart';
import 'fixtures/fixtures.dart';
import 'helpers.dart';

class _FixedMe extends ManagerMeNotifier {
  @override
  Future<ManagerMe?> build() async => ManagerMe.fromJson(meJson);
}

/// The fixture page with every id (and code) made unique by [tag].
OrderPage _page(String tag, {String? next}) {
  final j = apiFixture('orders_list');
  final items = [
    for (final m in (j['items'] as List).cast<Map<String, dynamic>>())
      {...m, 'id': '${m['id']}-$tag', 'code': '${(m['code'] as String).substring(0, 6)}$tag'},
  ];
  return OrderPage.fromJson({...j, 'items': items, 'nextCursor': next});
}

Future<FakeOrdersRepository> _screen(
  WidgetTester tester, {
  FakeOrdersRepository? repo,
  Uri? query,
  Size size = const Size(390, 800),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final fake = repo ?? FakeOrdersRepository();
  await tester.pumpWidget(await themed(OrdersScreen(query: query), overrides: [
    ordersRepoProvider.overrideWithValue(fake),
    managerMeProvider.overrideWith(_FixedMe.new),
    activeZoneProvider.overrideWithValue(null),
    signedInProvider.overrideWithValue(true),
  ]));
  await tester.pump();
  await tester.pump();
  return fake;
}

void main() {
  testWidgets('the first page renders and is asked for without a cursor', (tester) async {
    final fake = await _screen(tester);
    expect(fake.listCalls.first.cursor, isNull);
    expect(find.text('AB12CD34'), findsOneWidget);
    expect(find.text('Spice Hub → Asha'), findsWidgets);
    expect(find.text('₹420'), findsWidgets);
  });

  testWidgets('scrolling to the end loads the next page, and stops at the last', (tester) async {
    final fake = FakeOrdersRepository();
    fake.pages[null] = _page('a', next: 'c2');
    fake.pages['c2'] = _page('b');
    await _screen(tester, repo: fake);
    await tester.drag(find.byKey(const Key('orders-list')), const Offset(0, -3000));
    await tester.pump();
    await tester.pump();
    expect(fake.listCalls.map((c) => c.cursor), contains('c2'));
    final before = fake.listCalls.length;
    await tester.drag(find.byKey(const Key('orders-list')), const Offset(0, -6000));
    await tester.pump();
    await tester.pump();
    expect(fake.listCalls.length, before, reason: 'no next cursor, no more calls');
    expect(find.text('BB77CCb'), findsOneWidget);
  });

  testWidgets('the Delayed queue shows its count and asks for queue=delayed', (tester) async {
    final fake = await _screen(tester);
    expect(find.text('Delayed (2)'), findsOneWidget);
    expect(find.text('Unassigned (1)'), findsOneWidget);
    await tester.tap(find.text('Delayed (2)'));
    await tester.pump();
    await tester.pump();
    expect(fake.listCalls.last.filters.queue, OrderQueue.delayed);
    expect(fake.listCalls.last.filters.toQuery()['queue'], 'delayed');
  });

  testWidgets('a search goes out once, after the 400 ms pause', (tester) async {
    final fake = await _screen(tester);
    await tester.enterText(find.byKey(const Key('orders-search')), 'ab12');
    await tester.pump(const Duration(milliseconds: 399));
    expect(fake.listCalls.where((c) => c.filters.q == 'ab12'), isEmpty);
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump();
    expect(fake.listCalls.where((c) => c.filters.q == 'ab12'), hasLength(1));
  });

  testWidgets('a filtered list with nothing in it is one quiet line, not the empty screen', (tester) async {
    final fake = FakeOrdersRepository(page: const OrderPage(items: []));
    await _screen(tester, repo: fake, query: Uri.parse('/orders?status=kitchen'));
    expect(find.byType(EmptyLine), findsOneWidget);
    expect(find.text('No orders match these filters.'), findsOneWidget);
    expect(find.text('No orders yet'), findsNothing);
  });

  testWidgets('with no filters and no orders, the whole screen says so', (tester) async {
    await _screen(tester, repo: FakeOrdersRepository(page: const OrderPage(items: [])));
    expect(find.text('No orders yet'), findsOneWidget);
  });

  testWidgets('a failed load offers Retry, and Retry asks again', (tester) async {
    final fake = FakeOrdersRepository()..listError = networkError();
    await _screen(tester, repo: fake);
    expect(find.text('Retry'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pump();
    await tester.pump();
    expect(fake.listCalls, hasLength(2));
    expect(find.text('AB12CD34'), findsOneWidget);
  });

  testWidgets('/orders?status=cancelled opens on the Cancelled queue with reasons shown', (tester) async {
    final fake = await _screen(tester, query: Uri.parse('/orders?status=cancelled'));
    expect(fake.listCalls.first.filters.queue, OrderQueue.cancelled);
    final chip = tester.widget<ChoiceChip>(find.byKey(const Key('queue-cancelled')));
    expect(chip.selected, isTrue);
    await tester.scrollUntilVisible(find.text('Vendor cancelled · Out of stock'), 200,
        scrollable: find.descendant(of: find.byKey(const Key('orders-list')), matching: find.byType(Scrollable)));
    expect(find.text('Vendor cancelled · Out of stock'), findsOneWidget);
  });

  testWidgets('delay badges read in words', (tester) async {
    await _screen(tester, size: const Size(390, 2400));
    expect(find.text('Kitchen 12 min late'), findsOneWidget);
    expect(find.text('Late 9 min'), findsOneWidget);
    expect(find.text('Waiting for pickup 4 min'), findsOneWidget);
    expect(find.text('No rider 6 min'), findsOneWidget);
    expect(find.text('No rider'), findsWidgets);
  });

  testWidgets('active filters show as removable chips', (tester) async {
    final fake = await _screen(tester, query: Uri.parse('/orders?payment=cod&status=ready'));
    expect(find.byKey(const Key('filter-chip-status-ready')), findsOneWidget);
    expect(find.byKey(const Key('filter-chip-payment-cod')), findsOneWidget);
    await tester.tap(find.descendant(
        of: find.byKey(const Key('filter-chip-payment-cod')), matching: find.byIcon(Icons.close)));
    await tester.pump();
    await tester.pump();
    expect(fake.listCalls.last.filters.payments, isEmpty);
    expect(fake.listCalls.last.filters.statuses, {'ready'});
  });

  testWidgets('polls page one every 10 s while shown, and stops once gone', (tester) async {
    final fake = await _screen(tester);
    final first = fake.listCalls.length;
    await tester.pump(const Duration(seconds: 10));
    await tester.pump();
    expect(fake.listCalls.length, first + 1);
    expect(fake.listCalls.last.cursor, isNull);
    await tester.pumpWidget(const SizedBox());
    final after = fake.listCalls.length;
    await tester.pump(const Duration(seconds: 30));
    expect(fake.listCalls.length, after);
  });
}
