// The owner's cancelling and refund rules on the tracking screen: a Cancel button
// with a live countdown for the seconds the server says are left, gone after that;
// a request that arrives too late is told so; there is no refund button anywhere.
// No network: the order repository is faked.

import 'package:deligro_customer/core/api.dart';
import 'package:deligro_customer/core/errors.dart';
import 'package:deligro_customer/data/order_repository.dart';
import 'package:deligro_customer/features/orders/tracking_screen.dart';
import 'package:deligro_customer/models/order.dart';
import 'package:deligro_customer/models/tracking.dart';
import 'package:deligro_customer/state/prefs.dart';
import 'package:deligro_customer/state/providers.dart';
import 'package:deligro_customer/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

const _orderId = '3be2e4c7-46d6-4415-98a5-9b341acf17b9';

final _client = SupabaseClient(
  'http://localhost:1',
  'test-key',
  authOptions: const AuthClientOptions(autoRefreshToken: false),
);

class _FakeOrders extends OrderRepository {
  _FakeOrders({required this.status, required this.seconds, this.cancelError}) : super(_client, ApiClient(_client.auth));

  String status;

  /// What the next poll says is left.
  int seconds;
  final ApiException? cancelError;
  var cancels = 0;

  @override
  Future<TrackingSnapshot> tracking(String orderId) async => TrackingSnapshot.fromJson({
        'status': status,
        'eta': null,
        'rider': null,
        'restaurant': null,
        'destination': null,
        'riderPositionSource': 'none',
        'cancelSecondsLeft': seconds,
      });

  @override
  Future<void> cancel(String orderId) async {
    cancels++;
    if (cancelError != null) {
      seconds = 0;
      status = 'KITCHEN';
      throw cancelError!;
    }
    seconds = 0;
    status = 'CANCELLED';
  }

  @override
  Future<({String? url, bool removed})> proof(String orderId) async => (url: null, removed: false);

  @override
  Future<({int rating, String? comment})?> riderRating(String orderId) async => null;
}

Order _order(String status, {String payment = 'pending'}) => Order.fromRow({
      'id': _orderId,
      'status': status,
      'total': 413,
      'delivery_fee': 29,
      'tax_amount': 18,
      'tip': 20,
      'discount': 0,
      'payment_method': 'cod',
      'payment_status': payment,
      'created_at': DateTime.now().toUtc().toIso8601String(),
      'address': {'label': 'Home', 'line': 'House 12, Station Road, Bemetara'},
      'order_items': [
        {'name': 'Chicken Biryani', 'qty': 2, 'price': 173, 'menu_items': {'external_id': 'e1', 'veg': false}},
      ],
      'restaurants': {'slug': 'sonna-da-dhaba', 'name': 'Sonna Da Dhaba', 'eta_min': 25},
    });

late SharedPreferences _prefs;

Future<void> _pump(WidgetTester tester, _FakeOrders repo, {String orderStatus = 'placed', String payment = 'pending'}) async {
  tester.view.physicalSize = const Size(1080, 3400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(_prefs),
      supabaseProvider.overrideWithValue(_client),
      userIdProvider.overrideWithValue('u1'),
      orderProvider.overrideWith((_, _) async => _order(orderStatus, payment: payment)),
      activeOrderProvider.overrideWith((_) async => null),
      myOrdersProvider.overrideWith((_) async => const []),
      orderRepoProvider.overrideWithValue(repo),
    ],
    child: MaterialApp(
      theme: buildTheme(Brightness.light),
      home: const TrackingScreen(orderId: _orderId),
    ),
  ));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 10));
  await tester.pump();
}

/// Ends the screen so its timers stop before the test does.
Future<void> _leave(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 4));
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    GoogleFonts.config.allowRuntimeFetching = false;
    SharedPreferences.setMockInitialValues({});
    _prefs = await SharedPreferences.getInstance();
  });

  testWidgets('the button counts down the seconds the server gave, then goes', (tester) async {
    final repo = _FakeOrders(status: 'PLACED', seconds: 3);
    await _pump(tester, repo);
    expect(find.text('Cancel order (3s)'), findsOneWidget);

    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Cancel order (2s)'), findsOneWidget);

    repo.seconds = 0;
    await tester.pump(const Duration(seconds: 2));
    expect(find.byKey(const Key('cancel-order')), findsNothing);
    await _leave(tester);
  });

  testWidgets('each poll takes the server\'s figure, not the phone\'s count', (tester) async {
    final repo = _FakeOrders(status: 'PLACED', seconds: 20);
    await _pump(tester, repo);
    expect(find.text('Cancel order (20s)'), findsOneWidget);

    repo.seconds = 7;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('Cancel order (7s)'), findsOneWidget);
    await _leave(tester);
  });

  testWidgets('no seconds left: no button, even on a placed order', (tester) async {
    await _pump(tester, _FakeOrders(status: 'PLACED', seconds: 0));
    expect(find.byKey(const Key('cancel-order')), findsNothing);
    await _leave(tester);
  });

  testWidgets('a server that sends no window offers no button', (tester) async {
    expect(TrackingSnapshot.fromJson({'status': 'PLACED', 'riderPositionSource': 'none'}).cancelSecondsLeft, 0);
  });

  testWidgets('an accepted order has no button, whatever the figure says', (tester) async {
    await _pump(tester, _FakeOrders(status: 'KITCHEN', seconds: 15), orderStatus: 'kitchen');
    expect(find.byKey(const Key('cancel-order')), findsNothing);
    await _leave(tester);
  });

  testWidgets('a request that arrives just too late says so, and the button goes', (tester) async {
    final repo = _FakeOrders(status: 'PLACED', seconds: 5, cancelError: ApiException(409, 'too_late'));
    await _pump(tester, repo);
    await tester.ensureVisible(find.byKey(const Key('cancel-order')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('cancel-order')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Yes, cancel'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();

    expect(repo.cancels, 1);
    expect(find.byKey(const Key('cancel-order')), findsNothing);
    expect(find.text('Too late to cancel. Your order will be delivered.'), findsOneWidget);
    await _leave(tester);
  });

  testWidgets('no refund on a delivered or a paid cancelled order', (tester) async {
    await _pump(tester, _FakeOrders(status: 'DELIVERED', seconds: 0), orderStatus: 'delivered');
    expect(find.textContaining('refund'), findsNothing);
    expect(find.textContaining('Refund'), findsNothing);
    await _leave(tester);

    await _pump(tester, _FakeOrders(status: 'CANCELLED', seconds: 0), orderStatus: 'cancelled', payment: 'paid');
    expect(find.textContaining('refund'), findsNothing);
    expect(find.textContaining('Refund'), findsNothing);
    expect(find.textContaining('go back to how you paid'), findsNothing);
    await _leave(tester);
  });

  test('the too-late answer says the rule', () {
    expect(friendlyError('too_late'), 'Too late to cancel. Your order will be delivered.');
  });
}
