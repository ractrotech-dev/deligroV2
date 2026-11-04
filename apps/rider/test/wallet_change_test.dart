// The rider's "No change? Add to wallet": what the door says about points, the sheet that
// adds the change, and what the API's answers become. No network: the repository is faked
// or the HTTP client is. The server works out the change and decides; these only say it.

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/data/wallet_change_repository.dart';
import 'package:deligro_rider/features/delivery/wallet_change_sheet.dart';
import 'package:deligro_rider/features/jobs/offer_card.dart' show PaymentBanner;
import 'package:deligro_rider/models/cash.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

class _Fake implements WalletChangeRepository {
  _Fake(this.answer);
  final WalletChangeResult Function(int received, String code) answer;
  final calls = <({int received, String code, String actionId})>[];

  @override
  Future<WalletChangeResult> add(String orderId, {required int received, required String code, required String actionId}) async {
    calls.add((received: received, code: code, actionId: actionId));
    return answer(received, code);
  }
}

Widget _sheet(_Fake repo, {int due = 150, int max = 100, void Function(WalletChangeResult?)? onDone}) => ProviderScope(
      overrides: [walletChangeRepoProvider.overrideWithValue(repo)],
      child: MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  final done = await showWalletChangeSheet(context, orderId: 'o1', cashDue: due, maxPerOrder: max);
                  onDone?.call(done);
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );

Future<void> _open(WidgetTester t) async {
  await t.tap(find.text('open'));
  await t.pumpAndSettle();
}

void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('the model', () {
    test('reads the points and the change state, and keeps them through the phone\'s copy', () {
      final p = RiderPayment.fromJson({
        'instruction': 'collect',
        'collectAmount': 150,
        'pointsUsed': 50,
        'walletChange': {
          'allowed': true,
          'maxPerOrder': 100,
          'added': {'change': 50, 'received': 200},
        },
      });
      expect(p.collectAmount, 150);
      expect(p.pointsUsed, 50);
      expect(p.walletChange!.allowed, isTrue);
      expect(p.walletChange!.maxPerOrder, 100);
      expect(p.walletChange!.addedChange, 50);
      expect(p.walletChange!.addedReceived, 200);
      final copy = RiderPayment.fromJson(p.toJson());
      expect(copy.pointsUsed, 50);
      expect(copy.walletChange!.addedReceived, 200);
    });

    test('a server older than the wallet: no change step, nothing assumed', () {
      final p = RiderPayment.fromJson({'instruction': 'collect', 'collectAmount': 150});
      expect(p.walletChange, isNull);
      expect(p.pointsUsed, 0);
      expect(p.paidWithPoints, isFalse);
    });

    test('a points order in Collections is not "paid online"', () {
      final c = CashCollection.fromJson({
        'orderId': 'o',
        'code': '#A',
        'at': '2026-11-04T10:00:00Z',
        'amount': 0,
        'method': 'cod',
        'status': 'paid_points',
      });
      expect(c.paidWithPoints, isTrue);
      expect(c.online, isFalse);
    });
  });

  group('the door', () {
    Future<void> banner(WidgetTester t, RiderPayment p) => t.pumpWidget(
          MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: PaymentBanner(payment: p))),
        );

    testWidgets('part paid with points: asks only for the cash due', (t) async {
      await banner(t, const RiderPayment(instruction: CashInstruction.collect, collectAmount: 150, pointsUsed: 50));
      expect(find.text('Collect ₹150 cash'), findsOneWidget);
    });

    testWidgets('fully paid with points: asks for nothing and doesn\'t say online', (t) async {
      await banner(t, const RiderPayment(instruction: CashInstruction.prepaid, paidWithPoints: true));
      expect(find.text('Paid with points. Collect nothing.'), findsOneWidget);
      expect(find.textContaining('online'), findsNothing);
    });

    testWidgets('paid online still reads as it did', (t) async {
      await banner(t, const RiderPayment(instruction: CashInstruction.prepaid));
      expect(find.text('Paid online'), findsOneWidget);
    });
  });

  group('the sheet', () {
    testWidgets('previews the change from the amount received and refuses over the limit before sending', (t) async {
      final repo = _Fake((_, _) => const WalletChangeResult.added(change: 0, received: 0));
      await t.pumpWidget(_sheet(repo));
      await _open(t);

      await t.enterText(find.byKey(const Key('wallet-received')), '200');
      await t.enterText(find.byKey(const Key('wallet-code')), '123456');
      await t.pump();
      expect(find.text('₹50 goes to the customer\'s wallet.'), findsOneWidget);
      expect(t.widget<FilledButton>(find.byKey(const Key('wallet-add'))).onPressed, isNotNull);

      await t.enterText(find.byKey(const Key('wallet-received')), '251');
      await t.pump();
      expect(find.textContaining('more than the ₹100 you can add'), findsOneWidget);
      expect(t.widget<FilledButton>(find.byKey(const Key('wallet-add'))).onPressed, isNull);

      await t.enterText(find.byKey(const Key('wallet-received')), '150');
      await t.pump();
      expect(t.widget<FilledButton>(find.byKey(const Key('wallet-add'))).onPressed, isNull, reason: 'no change to add');
    });

    testWidgets('needs the whole code', (t) async {
      await t.pumpWidget(_sheet(_Fake((_, _) => const WalletChangeResult.added(change: 0, received: 0))));
      await _open(t);
      await t.enterText(find.byKey(const Key('wallet-received')), '200');
      await t.enterText(find.byKey(const Key('wallet-code')), '123');
      await t.pump();
      expect(t.widget<FilledButton>(find.byKey(const Key('wallet-add'))).onPressed, isNull);
    });

    testWidgets('right code: sends the amount and code, never a change figure, and closes with the answer', (t) async {
      final repo = _Fake((_, _) => const WalletChangeResult.added(change: 50, received: 200));
      WalletChangeResult? done;
      await t.pumpWidget(_sheet(repo, onDone: (r) => done = r));
      await _open(t);
      await t.enterText(find.byKey(const Key('wallet-received')), '200');
      await t.enterText(find.byKey(const Key('wallet-code')), '123456');
      await t.pump();
      await t.tap(find.byKey(const Key('wallet-add')));
      await t.pumpAndSettle();
      expect(repo.calls.single.received, 200);
      expect(repo.calls.single.code, '123456');
      expect(done?.change, 50);
      expect(find.byKey(const Key('wallet-add')), findsNothing);
    });

    testWidgets('wrong code: says so, stays open, keeps the same action for the retry', (t) async {
      var n = 0;
      final repo = _Fake((_, _) => ++n == 1
          ? const WalletChangeResult.refused('Wrong code. 4 tries left.')
          : const WalletChangeResult.added(change: 50, received: 200));
      await t.pumpWidget(_sheet(repo));
      await _open(t);
      await t.enterText(find.byKey(const Key('wallet-received')), '200');
      await t.enterText(find.byKey(const Key('wallet-code')), '111111');
      await t.pump();
      await t.tap(find.byKey(const Key('wallet-add')));
      await t.pumpAndSettle();
      expect(find.text('Wrong code. 4 tries left.'), findsOneWidget);
      expect(find.byKey(const Key('wallet-add')), findsOneWidget);

      await t.enterText(find.byKey(const Key('wallet-code')), '123456');
      await t.pump();
      await t.tap(find.byKey(const Key('wallet-add')));
      await t.pumpAndSettle();
      expect(repo.calls, hasLength(2));
      expect(repo.calls[0].actionId, repo.calls[1].actionId);
      expect(repo.calls[0].actionId, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
    });

    testWidgets('a rider can always close it and give cash', (t) async {
      WalletChangeResult? done = const WalletChangeResult.refused('unset');
      await t.pumpWidget(_sheet(_Fake((_, _) => const WalletChangeResult.refused('x')), onDone: (r) => done = r));
      await _open(t);
      await t.tap(find.text('Close, give cash instead'));
      await t.pumpAndSettle();
      expect(done, isNull);
    });
  });

  test('ApiException keeps the server\'s sentence for the rider', () {
    final e = ApiException(409, 'locked', message: 'Too many wrong codes. Give the change in cash and finish the delivery.');
    expect(e.message, contains('Too many'));
  });
}
