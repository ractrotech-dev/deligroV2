import 'package:deligro_partner/core/api.dart';
import 'package:deligro_partner/data/orders_repository.dart';
import 'package:deligro_partner/models/order.dart';
import 'package:deligro_partner/state/orders.dart';
import 'package:deligro_partner/state/prefs.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _MockRepo extends Mock implements OrdersRepository {}

Map<String, dynamic> orderJson({String status = 'placed', String? preparingAt, String? stage}) => {
      'id': 'a1b2c3d4-0000-0000-0000-000000000001',
      'code': '#D-4821',
      'status': status,
      'stage': ?stage,
      'preparingAt': preparingAt,
      'createdAt': '2026-10-21T10:24:00Z',
      'customerProfile': {'name': 'Asha Verma', 'phone': '+919876543210', 'initials': 'AV'},
      'area': 'Home',
      'deliveryLine': 'House 12, Station Road',
      'lines': [
        {'name': 'Paneer Tikka', 'qty': 2, 'price': 180},
        {'name': 'Cold Coffee', 'qty': 1, 'price': 90},
      ],
      'total': 486,
      'itemsSubtotal': 450,
      'deliveryFee': 29,
      'taxAmount': 23,
      'tip': 10,
      'discount': 26,
      'couponCode': 'FLAT26',
      'discountFundedBy': 'vendor',
      'paymentMethod': 'cod',
      'paymentStatus': 'pending',
      'acceptedAt': '2026-10-21T10:25:00Z',
      'prepMinutes': 20,
    };

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('stages mirror src/lib/orders/kitchen-stage.ts', () {
    test('from the database status', () {
      expect(OrderStage.fromStatus('placed'), OrderStage.newOrder);
      expect(OrderStage.fromStatus('kitchen'), OrderStage.accepted);
      expect(OrderStage.fromStatus('kitchen', preparingAt: '2026-10-21T10:30:00Z'), OrderStage.preparing);
      expect(OrderStage.fromStatus('ready'), OrderStage.ready);
      expect(OrderStage.fromStatus('on_the_way'), OrderStage.completed);
      expect(OrderStage.fromStatus('delivered'), OrderStage.completed);
      expect(OrderStage.fromStatus('cancelled'), OrderStage.cancelled);
      expect(OrderStage.fromStatus('lost'), isNull);
    });

    test('the server\'s stage wins when sent', () {
      final o = VendorOrder.fromJson(orderJson(status: 'kitchen', stage: 'preparing'));
      expect(o.stage, OrderStage.preparing);
    });

    test('derived when the server sends none', () {
      final o = VendorOrder.fromJson(orderJson(status: 'kitchen', preparingAt: '2026-10-21T10:30:00Z'));
      expect(o.stage, OrderStage.preparing);
    });
  });

  test('an order reads every §3 field', () {
    final o = VendorOrder.fromJson(orderJson());
    expect(o.shortId, 'D-4821');
    expect(o.itemCount, 3);
    expect(o.lines.first.amount, 360);
    expect(o.itemsSubtotal, 450);
    expect(o.discount, 26);
    expect(o.discountFundedBy, 'vendor');
    expect(o.isCod, isTrue);
    expect(o.customerPhone, '+919876543210');
    expect(o.dueAt, DateTime.parse('2026-10-21T10:45:00Z').toLocal());
  });

  test('search matches order ID (with or without #) and customer name', () {
    final o = VendorOrder.fromJson(orderJson());
    expect(o.matches('4821'), isTrue);
    expect(o.matches('#D-48'), isTrue);
    expect(o.matches('asha'), isTrue);
    expect(o.matches('ravi'), isFalse);
    expect(o.matches(''), isTrue);
  });

  test('a failed poll keeps the last board and marks it stale', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final repo = _MockRepo();
    var fail = false;
    when(repo.board).thenAnswer((_) async {
      if (fail) throw ApiException(0, 'network');
      return [VendorOrder.fromJson(orderJson())];
    });
    final c = ProviderContainer(overrides: [
      prefsProvider.overrideWithValue(prefs),
      ordersRepoProvider.overrideWithValue(repo),
    ]);
    addTearDown(c.dispose);
    final sub = c.listen(boardProvider, (_, _) {});
    addTearDown(sub.close);

    final first = await c.read(boardProvider.future);
    expect(first.orders, hasLength(1));
    expect(first.stale, isFalse);

    fail = true;
    await c.read(boardProvider.notifier).refresh();
    final after = c.read(boardProvider).value!;
    expect(after.orders, hasLength(1));
    expect(after.stale, isTrue);
  });
}
