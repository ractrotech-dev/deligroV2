import 'package:deligro_partner/features/orders/incoming_order.dart';
import 'package:deligro_partner/state/orders.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

const _a = 'aa11aa11-0000-0000-0000-000000000001';
const _b = 'bb22bb22-0000-0000-0000-000000000002';

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  group('nextIncoming', () {
    final now = DateTime.now();
    test('offers the order that has waited longest', () {
      final orders = [fakeOrder(_a, minutesAgo: 1), fakeOrder(_b, minutesAgo: 5)];
      expect(nextIncoming(orders, {}, now)?.id, _b);
    });
    test('skips orders that are no longer new', () {
      expect(nextIncoming([fakeOrder(_a, status: 'kitchen')], {}, now), isNull);
    });
    test('skips a snoozed order until its snooze runs out', () {
      final orders = [fakeOrder(_a, minutesAgo: 5), fakeOrder(_b, minutesAgo: 1)];
      expect(nextIncoming(orders, {_a: now.add(const Duration(minutes: 1))}, now)?.id, _b);
      expect(nextIncoming(orders, {_a: now.subtract(const Duration(seconds: 1))}, now)?.id, _a);
    });
  });

  test('waitedText', () {
    expect(waitedText(const Duration(seconds: 42)), '0:42');
    expect(waitedText(const Duration(minutes: 3, seconds: 5)), '3:05');
  });

  group('IncomingOrderDialog', () {
    late MockOrdersRepo repo;
    setUp(() {
      repo = MockOrdersRepo();
      when(repo.board).thenAnswer((_) async => [fakeOrder(_a, minutesAgo: 2)]);
    });

    Future<ProviderContainer> open(WidgetTester t, {double scale = 1, Brightness b = Brightness.light}) async {
      final c = await pumpPartner(
        t,
        child: Consumer(
          builder: (context, ref, _) {
            ref.watch(boardProvider);
            return Scaffold(
              body: Builder(
                builder: (ctx) => TextButton(
                  onPressed: () => showDialog<IncomingOutcome>(
                    context: ctx,
                    builder: (_) => const IncomingOrderDialog(orderId: _a),
                  ),
                  child: const Text('open'),
                ),
              ),
            );
          },
        ),
        overrides: ordersOverrides(repo),
        scale: scale,
        b: b,
      );
      await t.tap(find.text('open'));
      await t.pump(const Duration(milliseconds: 400));
      return c;
    }

    testPartner('shows the order with Accept and Reject', (t) async {
      await open(t);
      expect(find.text('NEW ORDER'), findsOneWidget);
      expect(find.textContaining('Order '), findsWidgets);
      expect(find.text('Accept'), findsOneWidget);
      expect(find.text('Reject'), findsOneWidget);
      expect(find.text('Cash on delivery'), findsOneWidget);
    });

    for (final (b, scale, name) in [
      (Brightness.light, 1.0, 'light'),
      (Brightness.dark, 1.0, 'dark'),
      (Brightness.light, 1.3, 'large text'),
    ]) {
      testPartner('fits a 360 px phone ($name)', (t) async {
        await open(t, scale: scale, b: b);
        expect(t.takeException(), isNull);
        expect(find.text('Reject'), findsOneWidget);
      });
    }

    testPartner('Accept asks for the prep time, then accepts the order', (t) async {
      when(() => repo.accept(_a, prepMinutes: any(named: 'prepMinutes'))).thenAnswer((_) async {
        when(repo.board).thenAnswer((_) async => [fakeOrder(_a, status: 'kitchen')]);
      });
      await open(t);
      await t.tap(find.text('Accept'));
      for (var i = 0; i < 4; i++) {
        await t.pump(const Duration(milliseconds: 300));
      }
      expect(find.text('How long until it\'s ready for pickup?'), findsOneWidget);
      await t.tap(find.text('15 min'));
      await t.pump();
      await t.tap(find.text('Accept · ready in 15 min'));
      for (var i = 0; i < 4; i++) {
        await t.pump(const Duration(milliseconds: 300));
      }
      verify(() => repo.accept(_a, prepMinutes: 15)).called(1);
      expect(find.text('NEW ORDER'), findsNothing);
    });

    testPartner('closes by itself when the order is taken elsewhere', (t) async {
      final c = await open(t);
      when(repo.board).thenAnswer((_) async => [fakeOrder(_a, status: 'cancelled')]);
      await c.read(boardProvider.notifier).refresh();
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(find.text('NEW ORDER'), findsNothing);
    });
  });
}
