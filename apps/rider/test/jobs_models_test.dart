// The jobs models mirror src/lib/data-access/rider-jobs.ts; the fixture backend
// is debug-only and drives the screenshots of the job screens.
import 'dart:convert';

import 'package:deligro_rider/core/action_queue.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final now = DateTime.utc(2026, 10, 21, 9, 30);

  group('RiderBoard', () {
    test('parses the wire shape', () {
      final board = RiderBoard.fromJson({
        'offerWindowSeconds': 180,
        'offers': [
          {
            'orderId': 'o1',
            'code': 'DL-1042',
            'shop': {'name': 'Mehta Sweets', 'line': 'MG Road', 'point': {'lat': 12.9, 'lng': 77.6}, 'phone': null},
            'drop': {'name': 'Home', 'line': '4th Cross', 'point': null, 'phone': null},
            'instructions': 'Ring twice',
            'itemCount': 3,
            'shopToDropKm': 2.4,
            'riderToShopKm': 1,
            'etaMinutes': 18,
            'offerExpiresAt': '2026-10-21T09:30:45.000Z',
            'reservedForYou': true,
            'payment': {'instruction': 'collect', 'collectAmount': 349},
            'estimatedEarning': null,
          },
        ],
        'upcoming': [],
        'active': null,
      });

      expect(board.offerWindowSeconds, 180);
      final o = board.offers.single;
      expect(o.code, 'DL-1042');
      expect(o.shop.point, (lat: 12.9, lng: 77.6));
      expect(o.drop.point, isNull);
      expect(o.shopToDropKm, 2.4);
      expect(o.riderToShopKm, 1.0);
      expect(o.offerExpiresAt, DateTime.utc(2026, 10, 21, 9, 30, 45));
      expect(o.reservedForYou, isTrue);
      expect(o.payment.instruction, CashInstruction.collect);
      expect(o.payment.collectAmount, 349.0);
      expect(o.estimatedEarning, isNull);
      expect(board.active, isNull);
    });

    test('an unknown payment instruction is treated as unconfirmed, never as collect', () {
      final p = RiderPayment.fromJson({'instruction': 'something_new', 'collectAmount': 500});
      expect(p.instruction, CashInstruction.unconfirmed);
      expect(p.collectAmount, 0, reason: 'only a collect instruction carries an amount');
    });

    test('an unknown delivery status is a parse error, not a guess', () {
      final j = FixtureData.active('accepted', now: now)..['status'] = 'teleported';
      expect(() => RiderActive.fromJson(j), throwsFormatException);
    });
  });

  group('fixtures', () {
    test('every scenario parses and round-trips', () {
      for (final name in FixtureData.scenarios) {
        final json = FixtureData.board(name, now: now);
        final board = RiderBoard.fromJson(json);
        final again = RiderBoard.fromJson(jsonDecode(jsonEncode(board.toJson())) as Map<String, dynamic>);
        expect(jsonEncode(again.toJson()), jsonEncode(board.toJson()), reason: name);
      }
    });

    test('the full board round-trips field by field', () {
      final board = RiderBoard.fromJson(FixtureData.board('full', now: now));
      final back = RiderBoard.fromJson(jsonDecode(jsonEncode(board.toJson())) as Map<String, dynamic>);

      expect(back.offers.map((o) => o.orderId), board.offers.map((o) => o.orderId));
      expect(back.upcoming.single.readyInMinutes, board.upcoming.single.readyInMinutes);
      final a = back.active!;
      final b = board.active!;
      expect(a.status, b.status);
      expect(a.items.map((i) => (i.name, i.qty)), b.items.map((i) => (i.name, i.qty)));
      expect(a.timeline.map((e) => (e.kind, e.at)), b.timeline.map((e) => (e.kind, e.at)));
      expect(a.exceptions.map((e) => e.id), b.exceptions.map((e) => e.id));
      expect(a.drop.customerName, b.drop.customerName);
      expect(a.unreachableWaitMinutes, b.unreachableWaitMinutes);
      expect(a.podPhotoRequired, b.podPhotoRequired);
    });

    test('together they cover every delivery status', () {
      final seen = <RiderDeliveryStatus>{
        for (final name in FixtureData.scenarios)
          if (RiderBoard.fromJson(FixtureData.board(name, now: now)).active case final a?) a.status,
      };
      expect(seen, RiderDeliveryStatus.values.toSet());
    });

    test('they cover held and open offers, upcoming, and pending and decided exceptions', () {
      final offers = RiderBoard.fromJson(FixtureData.board('offers', now: now)).offers;
      expect(offers.where((o) => o.reservedForYou), isNotEmpty);
      expect(offers.where((o) => !o.reservedForYou), isNotEmpty);
      expect(offers.where((o) => o.reservedForYou).first.offerExpiresAt!.isAfter(now), isTrue);
      expect(RiderBoard.fromJson(FixtureData.board('offers', now: now)).upcoming, isNotEmpty);

      final ex = RiderBoard.fromJson(FixtureData.board('exceptions', now: now)).active!.exceptions;
      expect(ex.map((e) => e.status), containsAll(['pending', 'approved', 'rejected']));
      expect(ex.any((e) => e.decisionNote != null), isTrue);
    });

    test('an unknown scenario is an error', () {
      expect(() => FixtureData.board('nope', now: now), throwsArgumentError);
    });

    test('the repository refuses to load when a release build is simulated', () {
      expect(
        () => FixtureJobsRepository.create(releaseMode: true),
        throwsA(isA<StateError>()),
      );
    });

    test('it loads in a debug build, and the build flag is off by default', () {
      expect(kReleaseMode, isFalse);
      expect(fixturesEnabled, isFalse, reason: 'FIXTURES is not defined for the test run');
      expect(FixtureJobsRepository.create(now: now), isNotNull);
    });

    test('the fixture repository plays the delivery forward', () async {
      final repo = FixtureJobsRepository.create(scenario: 'accepted', now: now);
      final id = (await repo.board()).active!.orderId;

      Future<ActionOutcome> step(String action, {String? code, String? method}) => repo.act(
            QueuedAction(actionId: 'x-$action', orderId: id, action: action, code: code, method: method, queuedAt: now),
          );

      expect((await step('arrive_pickup')).kind, ActionOutcomeKind.applied);
      expect((await repo.board()).active!.status, RiderDeliveryStatus.arrivedPickup);

      final bad = await step('pickup', code: '0000', method: 'code');
      expect(bad.kind, ActionOutcomeKind.rejected);
      expect(bad.code, 'bad_pickup_otp');
      expect((await step('pickup', code: '1234', method: 'code')).kind, ActionOutcomeKind.applied);
      expect((await repo.board()).active!.status, RiderDeliveryStatus.pickedUp);

      await step('start_trip');
      await step('arrive_drop');
      expect((await step('deliver', code: '1234', method: 'code')).kind, ActionOutcomeKind.applied);
      expect((await repo.board()).active!.status, RiderDeliveryStatus.delivered);
    });

    test('accepting a fixture offer makes it the active delivery', () async {
      final repo = FixtureJobsRepository.create(scenario: 'offers', now: now);
      final board = await repo.board();
      expect(board.active, isNull);

      await repo.accept(board.offers.first.orderId);

      final after = await repo.board();
      expect(after.active?.orderId, board.offers.first.orderId);
      expect(after.active?.status, RiderDeliveryStatus.accepted);
      expect(after.offers.map((o) => o.orderId), isNot(contains(board.offers.first.orderId)));
    });
  });

  group('QueuedAction', () {
    test('round-trips through json and omits empty fields on the wire', () {
      final a = QueuedAction(
        actionId: 'u1',
        orderId: 'o1',
        action: 'deliver',
        code: '1234',
        method: 'code',
        lat: 12.5,
        lng: 77.5,
        queuedAt: now,
      );
      final back = QueuedAction.fromJson(jsonDecode(jsonEncode(a.toJson())) as Map<String, dynamic>);
      expect(back.toJson(), a.toJson());
      expect(back.queuedAt, now);

      final bare = QueuedAction(actionId: 'u2', orderId: 'o1', action: 'arrive_drop', queuedAt: now);
      expect(bare.requestBody(), {'action': 'arrive_drop', 'actionId': 'u2'});
      expect(a.requestBody(), {
        'action': 'deliver',
        'actionId': 'u1',
        'code': '1234',
        'method': 'code',
        'lat': 12.5,
        'lng': 77.5,
      });
    });
  });
}
