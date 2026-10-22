// Customers rate their rider (Phase 4 Task 3): the stars submit, an order that
// already has a rating shows what was given, the server's refusals are shown in
// words, and the card appears on a delivered order that has a rider. No network:
// the order repository is faked.

import 'package:deligro_customer/core/api.dart';
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

class _Call {
  _Call(this.rating, this.comment);
  final int rating;
  final String? comment;
}

class _FakeOrders extends OrderRepository {
  _FakeOrders(this.status, {this.given, this.rateError, this.givenAfterError})
      : super(_client, ApiClient(_client.auth));

  final String status;

  /// What `GET …/rider-rating` answers first.
  ({int rating, String? comment})? given;

  /// Thrown by `POST …/rider-rating`, when set.
  final ApiException? rateError;

  /// What the read-back answers after a refused post (the "already rated" case).
  final ({int rating, String? comment})? givenAfterError;

  final calls = <_Call>[];
  var reads = 0;

  @override
  Future<TrackingSnapshot> tracking(String orderId) async => TrackingSnapshot.fromJson({
        'status': status,
        'eta': null,
        'rider': {'name': 'Ravi Kumar', 'id': 'AB12CD34', 'phone': '+919999999999'},
        'restaurant': null,
        'destination': null,
        'riderPositionSource': 'none',
      });

  @override
  Future<String?> deliveryCode(String orderId) async => null;

  @override
  Future<String?> proofUrl(String orderId) async => null;

  @override
  Future<({int rating, String? comment})?> riderRating(String orderId) async {
    reads++;
    // The first read is the card opening; a later one is the read-back after a refused post.
    if (rateError != null && reads > 1) return givenAfterError;
    return given;
  }

  @override
  Future<void> rateRider(String orderId, int rating, {String? comment}) async {
    calls.add(_Call(rating, comment));
    if (rateError != null) throw rateError!;
  }
}

Order _order(String status) => Order.fromRow({
      'id': _orderId,
      'status': status,
      'total': 413,
      'delivery_fee': 29,
      'tax_amount': 18,
      'tip': 20,
      'discount': 0,
      'payment_method': 'cod',
      'payment_status': 'pending',
      'created_at': DateTime.now().toUtc().toIso8601String(),
      'address': {'label': 'Home', 'line': 'House 12, Station Road, Bemetara'},
      'order_items': [
        {'name': 'Chicken Biryani', 'qty': 2, 'price': 173, 'menu_items': {'external_id': 'e1', 'veg': false}},
      ],
      'restaurants': {'slug': 'sonna-da-dhaba', 'name': 'Sonna Da Dhaba', 'eta_min': 25},
    });

late SharedPreferences _prefs;

/// The card alone, on a scrolling page (the tracker brings its own Scaffold).
class _CardHost extends StatelessWidget {
  const _CardHost(this.child);
  final Widget child;
  @override
  Widget build(BuildContext context) => Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: child));
}

Future<void> _pump(WidgetTester tester, Widget home, _FakeOrders repo, {String orderStatus = 'delivered'}) async {
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(_prefs),
      supabaseProvider.overrideWithValue(_client),
      userIdProvider.overrideWithValue('u1'),
      orderProvider.overrideWith((_, _) async => _order(orderStatus)),
      activeOrderProvider.overrideWith((_) async => null),
      myOrdersProvider.overrideWith((_) async => const []),
      orderRepoProvider.overrideWithValue(repo),
    ],
    child: MaterialApp(
      theme: buildTheme(Brightness.light),
      home: home,
    ),
  ));
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _tapStar(WidgetTester tester, int n) async {
  await tester.ensureVisible(find.byKey(Key('rider-star-$n')));
  await tester.tap(find.byKey(Key('rider-star-$n')));
  await tester.pump();
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    _prefs = await SharedPreferences.getInstance();
  });

  testWidgets('the stars submit: the rating and comment go to the server and the card shows what was given', (tester) async {
    final repo = _FakeOrders('delivered');
    await _pump(tester, const _CardHost(RiderRateCard(orderId: _orderId, riderName: 'Ravi Kumar')), repo);

    expect(find.text('Rate Ravi'), findsOneWidget, reason: 'the rider\'s first name');
    expect(find.byKey(const Key('rider-rating-comment')), findsNothing, reason: 'the comment box opens once a star is chosen');
    await _tapStar(tester, 4);
    await tester.enterText(find.byKey(const Key('rider-rating-comment')), '  Quick and polite ');
    await tester.tap(find.byKey(const Key('rider-rating-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(repo.calls, hasLength(1));
    expect(repo.calls.single.rating, 4);
    expect(repo.calls.single.comment, 'Quick and polite');
    expect(find.byKey(const Key('rider-rating-given')), findsOneWidget);
    expect(find.text('You rated Ravi'), findsOneWidget);
    expect(find.text('“Quick and polite”'), findsOneWidget);
    expect(find.byKey(const Key('rider-star-1')), findsNothing, reason: 'no form once rated');
  });

  testWidgets('a rating without a comment sends none', (tester) async {
    final repo = _FakeOrders('delivered');
    await _pump(tester, const _CardHost(RiderRateCard(orderId: _orderId, riderName: 'Ravi Kumar')), repo);
    await _tapStar(tester, 5);
    await tester.tap(find.byKey(const Key('rider-rating-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(repo.calls.single.rating, 5);
    expect(repo.calls.single.comment, isNull);
  });

  testWidgets('already rated: the card shows the given rating, not the stars', (tester) async {
    final repo = _FakeOrders('delivered', given: (rating: 5, comment: 'Great ride'));
    await _pump(tester, const _CardHost(RiderRateCard(orderId: _orderId, riderName: 'Ravi Kumar')), repo);

    expect(find.byKey(const Key('rider-rating-given')), findsOneWidget);
    expect(find.text('You rated Ravi'), findsOneWidget);
    expect(find.bySemanticsLabel('5 out of 5 stars'), findsOneWidget);
    expect(find.text('“Great ride”'), findsOneWidget);
    expect(find.byKey(const Key('rider-star-1')), findsNothing);
    expect(find.byKey(const Key('rider-rating-submit')), findsNothing);
    expect(repo.calls, isEmpty);
  });

  testWidgets('the server says already_rated (another device): the card switches to what was given', (tester) async {
    final repo = _FakeOrders(
      'delivered',
      rateError: ApiException(409, 'already_rated'),
      givenAfterError: (rating: 2, comment: null),
    );
    await _pump(tester, const _CardHost(RiderRateCard(orderId: _orderId, riderName: 'Ravi Kumar')), repo);
    await _tapStar(tester, 5);
    await tester.tap(find.byKey(const Key('rider-rating-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byKey(const Key('rider-rating-given')), findsOneWidget);
    expect(find.bySemanticsLabel('2 out of 5 stars'), findsOneWidget, reason: 'the rating that was already given, not the one just tapped');
  });

  testWidgets('a refusal is shown in words and the form stays', (tester) async {
    final repo = _FakeOrders('delivered', rateError: ApiException(400, 'comment_too_long'));
    await _pump(tester, const _CardHost(RiderRateCard(orderId: _orderId, riderName: 'Ravi Kumar')), repo);
    await _tapStar(tester, 3);
    await tester.tap(find.byKey(const Key('rider-rating-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('Keep your comment under 300 characters.'), findsOneWidget);
    expect(find.byKey(const Key('rider-rating-form')), findsOneWidget);
    expect(find.byKey(const Key('rider-rating-submit')), findsOneWidget, reason: 'they can try again');
  });

  testWidgets('a placeholder rider name reads "Rate your rider"', (tester) async {
    for (final name in ['Your courier', 'Your rider']) {
      final repo = _FakeOrders('delivered');
      await _pump(tester, _CardHost(RiderRateCard(orderId: _orderId, riderName: name)), repo);
      expect(find.text('Rate your rider'), findsOneWidget, reason: name);
    }
  });

  testWidgets('the tracker shows the rider card on a delivered order that has a rider, apart from the food rating', (tester) async {
    final repo = _FakeOrders('delivered');
    await _pump(tester, const TrackingScreen(orderId: _orderId), repo);
    expect(find.text('Hope it was delicious. How was it?'), findsOneWidget);
    expect(find.text('Rate Ravi'), findsOneWidget);
    expect(find.byKey(const Key('rider-rating-form')), findsOneWidget);
  });

  testWidgets('the tracker shows no rider card while the order is on the way', (tester) async {
    final repo = _FakeOrders('on_the_way');
    await _pump(tester, const TrackingScreen(orderId: _orderId), repo, orderStatus: 'on_the_way');
    expect(find.text('Rate Ravi'), findsNothing);
    expect(find.byKey(const Key('rider-rating-form')), findsNothing);
    expect(repo.reads, 0, reason: 'nothing is asked until the order is delivered');
  });
}
