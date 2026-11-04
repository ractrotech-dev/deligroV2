// The customer wallet on the customer's phone: balance and history, the code during a
// cash delivery, "Use my wallet" at checkout, and the bill's words when points are on it.
// No network: the wallet repository is faked. The server decides everything for real;
// these screens only have to say it right.

import 'package:deligro_customer/core/api.dart';
import 'package:deligro_customer/data/wallet_repository.dart';
import 'package:deligro_customer/features/checkout/wallet_choice.dart';
import 'package:deligro_customer/features/orders/orders_screen.dart' show paymentLabel;
import 'package:deligro_customer/features/orders/wallet_code_card.dart';
import 'package:deligro_customer/features/profile/wallet_screen.dart';
import 'package:deligro_customer/models/order.dart';
import 'package:deligro_customer/models/wallet.dart';
import 'package:deligro_customer/state/providers.dart';
import 'package:deligro_customer/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

final _client = SupabaseClient(
  'http://localhost:1',
  'test-key',
  authOptions: const AuthClientOptions(autoRefreshToken: false),
);

class _FakeWallet extends WalletRepository {
  _FakeWallet({this.info, this.codes = const ['482913'], this.codeError}) : super(ApiClient(_client.auth));

  final WalletInfo? info;
  final List<String> codes;
  final ApiException? codeError;
  var asked = 0;

  @override
  Future<WalletInfo> wallet({String? cursor}) async => info!;

  @override
  Future<String> changeCode(String orderId) async {
    asked++;
    if (codeError != null) throw codeError!;
    return codes[(asked - 1) % codes.length];
  }
}

Order _order({int total = 200, int points = 0, String status = 'pending', OrderStatus st = OrderStatus.onTheWay}) => Order(
      id: 'o1',
      status: st,
      restaurantSlug: 's',
      restaurantName: 'Shop',
      restaurantImage: null,
      restaurantAccent: null,
      createdAt: null,
      lines: const [],
      subtotal: total,
      deliveryFee: 0,
      tax: 0,
      tip: 0,
      discount: 0,
      couponCode: null,
      total: total,
      paymentMethod: 'cod',
      paymentStatus: status,
      cancelledBy: null,
      cancellationReason: null,
      address: '',
      etaMin: null,
      pointsUsed: points,
    );

Widget _app(Widget child, _FakeWallet wallet) => ProviderScope(
      overrides: [walletRepoProvider.overrideWithValue(wallet)],
      child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: SingleChildScrollView(child: child))),
    );

void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('the numbers', () {
    test('cash due is the bill less the points, never below zero', () {
      expect(_order(total: 200, points: 50).cashDue, 150);
      expect(_order(total: 200, points: 200).cashDue, 0);
      expect(_order(total: 200, points: 500).cashDue, 0);
    });

    test('the most a customer can use is their balance, up to the bill', () {
      expect(maxPointsFor(50, 200), 50);
      expect(maxPointsFor(500, 200), 200);
      expect(maxPointsFor(0, 200), 0);
    });

    test('an order reads its points from the database row and from the API', () {
      final row = Order.fromRow({
        'id': 'a',
        'status': 'placed',
        'total': 150,
        'wallet_points_used': 30,
        'order_items': const [],
        'restaurants': const {},
      });
      expect(row.pointsUsed, 30);
      expect(row.cashDue, 120);
      final ui = Order.fromUi({'id': 'a', 'status': 'PLACED', 'total': 150, 'pointsUsed': 30, 'charges': const {}, 'lines': const []});
      expect(ui.pointsUsed, 30);
    });

    test('the order list and receipt never call a points order plain cash', () {
      expect(paymentLabel(_order()), 'Cash on delivery');
      expect(paymentLabel(_order(points: 50)), 'Points and cash');
      expect(paymentLabel(_order(points: 200, status: 'paid')), 'Wallet points');
    });

    test('the columns ask for the points only where the fallback can drop them', () {
      expect(Order.columns.contains('wallet_points_used'), isFalse);
      expect(Order.columnsWithOptions.contains('wallet_points_used'), isTrue);
    });
  });

  group('the code during a cash delivery', () {
    testWidgets('shows nothing until asked, then the code, and asking again replaces it', (t) async {
      final fake = _FakeWallet(codes: const ['482913', '100200']);
      await t.pumpWidget(_app(const WalletCodeCard(orderId: 'o1'), fake));
      expect(find.byKey(const Key('wallet-code')), findsNothing);
      expect(find.textContaining('Rider has no change'), findsOneWidget);

      await t.tap(find.byKey(const Key('wallet-get-code')));
      await t.pump();
      expect(find.text('482913'), findsOneWidget);
      expect(find.text('Works for 10 minutes.'), findsOneWidget);

      await t.tap(find.byKey(const Key('wallet-get-code')));
      await t.pump();
      expect(find.text('482913'), findsNothing);
      expect(find.text('100200'), findsOneWidget);
    });

    testWidgets('a refusal says so in the server\'s words and shows no code', (t) async {
      final fake = _FakeWallet(
        codeError: ApiException(409, 'locked', message: 'Too many wrong codes were tried on this order. Take your change in cash.'),
      );
      await t.pumpWidget(_app(const WalletCodeCard(orderId: 'o1'), fake));
      await t.tap(find.byKey(const Key('wallet-get-code')));
      await t.pump();
      expect(find.byKey(const Key('wallet-code')), findsNothing);
      expect(find.textContaining('Too many wrong codes'), findsOneWidget);
    });
  });

  group('checkout', () {
    Widget choice({
      bool use = true,
      bool online = false,
      int cashDue = 150,
      int max = 50,
      ValueChanged<bool>? onUse,
      TextEditingController? ctrl,
    }) =>
        _app(
          WalletChoice(
            balance: 50,
            max: max,
            use: use,
            controller: ctrl ?? TextEditingController(text: '50'),
            cashDue: cashDue,
            online: online,
            enabled: true,
            onUse: onUse ?? (_) {},
            onAmount: () {},
          ),
          _FakeWallet(),
        );

    testWidgets('off: the balance and the switch, no amount', (t) async {
      await t.pumpWidget(choice(use: false));
      expect(find.text('You have 50 points (1 point = ₹1)'), findsOneWidget);
      expect(find.byKey(const Key('wallet-points')), findsNothing);
    });

    testWidgets('on: says the most they can use and the cash left', (t) async {
      await t.pumpWidget(choice());
      expect(find.text('You can use up to 50 on this order.'), findsOneWidget);
      expect(find.text('Pay the rider ₹150 in cash.'), findsOneWidget);
    });

    testWidgets('all of it: nothing to pay the rider', (t) async {
      await t.pumpWidget(choice(cashDue: 0));
      expect(find.text('Your points cover this order. Nothing to pay the rider.'), findsOneWidget);
    });

    testWidgets('paying online: the switch is off and says why', (t) async {
      var flipped = false;
      await t.pumpWidget(choice(use: true, online: true, onUse: (_) => flipped = true));
      expect(find.text('Points can only be used on cash orders for now.'), findsOneWidget);
      expect(find.byKey(const Key('wallet-points')), findsNothing);
      await t.tap(find.byKey(const Key('wallet-use')));
      expect(flipped, isFalse);
    });
  });

  group('the wallet screen', () {
    const info = WalletInfo(
      enabled: true,
      balance: 50,
      moves: [
        WalletMove(id: 'a', amount: 50, kind: 'change_credit', reason: 'x', orderId: null, at: null),
        WalletMove(id: 'b', amount: -30, kind: 'order_spend', reason: 'x', orderId: null, at: null),
        WalletMove(id: 'c', amount: 30, kind: 'order_return', reason: 'x', orderId: null, at: null),
        WalletMove(id: 'd', amount: 5, kind: 'admin_correction', reason: 'Rider typed the wrong order', orderId: null, at: null),
      ],
    );

    Widget screen(WalletInfo i) => ProviderScope(
          overrides: [walletRepoProvider.overrideWithValue(_FakeWallet(info: i))],
          child: MaterialApp(theme: buildTheme(Brightness.light), home: const WalletScreen()),
        );

    testWidgets('balance, the rule in words, and each kind of row', (t) async {
      await t.pumpWidget(screen(info));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('wallet-balance')), findsOneWidget);
      expect(find.textContaining('never expire'), findsOneWidget);
      expect(find.text('Change from a cash order'), findsOneWidget);
      expect(find.text('Used on an order'), findsOneWidget);
      expect(find.text('Returned, order cancelled'), findsOneWidget);
      expect(find.text('Corrected by Deligro'), findsOneWidget);
      expect(find.text('Rider typed the wrong order'), findsOneWidget);
      expect(find.text('−₹30'), findsOneWidget);
    });

    testWidgets('switched off: the balance stays, and it says so', (t) async {
      await t.pumpWidget(screen(const WalletInfo(enabled: false, balance: 50)));
      await t.pumpAndSettle();
      expect(find.text('The wallet is switched off right now.'), findsOneWidget);
      expect(find.text('50'), findsOneWidget);
    });

    testWidgets('nothing yet: says what will show here', (t) async {
      await t.pumpWidget(screen(const WalletInfo(enabled: true, balance: 0)));
      await t.pumpAndSettle();
      expect(find.textContaining('Nothing yet'), findsOneWidget);
    });
  });
}
