import 'dart:convert';
import 'dart:io';

import 'package:deligro_manager/models/cash.dart';
import 'package:deligro_manager/models/delivery_exception.dart';
import 'package:deligro_manager/models/payment_request.dart';
import 'package:deligro_manager/models/rider.dart';
import 'package:flutter_test/flutter_test.dart';

/// Phase 5 contract check, app half. `scripts/qa/manager-contract-phase5.ts`
/// runs the rider, money, cash and exception readers against a seeded fake
/// PostgREST and writes what each route sends to
/// `fixtures/api/generated/phase5/`. The app's screens are tested against the
/// hand-written fixtures in `fixtures/api/phase5/`, so this checks every key a
/// hand fixture has is also in the server's answer, with the same JSON type,
/// and then parses the server's answer with the models.
///
///   npm run test:manager-contract   (from the repo root)
///   flutter test test/contract_phase5_test.dart
Map<String, dynamic> _json(String path) => jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
Map<String, dynamic> _gen(String name) => _json('test/fixtures/api/generated/phase5/$name.json');
Map<String, dynamic> _hand(String name) => _json('test/fixtures/api/phase5/$name.json');
Map<String, dynamic> _rider(String name) => (_gen(name)['rider'] as Map).cast<String, dynamic>();

String _kind(Object? v) => switch (v) {
      null => 'null',
      bool() => 'bool',
      num() => 'num',
      String() => 'str',
      List() => 'list',
      Map() => 'object',
      _ => v.runtimeType.toString(),
    };

/// Every key in [hand] is in [gen] with the same JSON type. A null on either
/// side matches anything (the field is nullable); list elements are each
/// checked against the hand fixture's first element. [optional] lists dotted
/// paths the server may leave out.
void _sameShape(Object? hand, Object? gen, String path, List<String> errors, Set<String> optional) {
  if (hand == null || gen == null) return;
  if (_kind(hand) != _kind(gen)) {
    errors.add('$path: server sends ${_kind(gen)}, app fixture has ${_kind(hand)}');
    return;
  }
  if (hand is Map && gen is Map) {
    for (final k in hand.keys) {
      final p = '$path.$k';
      if (!gen.containsKey(k)) {
        if (!optional.contains(p)) errors.add('$p: missing from the server answer');
        continue;
      }
      _sameShape(hand[k], gen[k], p, errors, optional);
    }
  } else if (hand is List && gen is List && hand.isNotEmpty) {
    for (var i = 0; i < gen.length; i++) {
      _sameShape(hand.first, gen[i], '$path[]', errors, optional);
    }
  }
}

void _expectSameShape(String hand, String gen, {Set<String> optional = const {}}) {
  final errors = <String>[];
  _sameShape(_hand(hand), _gen(gen), gen, errors, optional);
  expect(errors, isEmpty, reason: errors.join('\n'));
}

void main() {
  group('server answers carry every field the app fixtures have', () {
    test('riders list', () => _expectSameShape('riders_list', 'riders_list'));
    test('rider detail', () => _expectSameShape('rider_detail', 'rider_detail'));
    test('rider detail without money', () {
      _expectSameShape('rider_detail', 'rider_detail_no_money', optional: {'rider_detail_no_money.rider.money'});
      expect(_rider('rider_detail_no_money').containsKey('money'), isFalse);
    });
    test('rider history', () => _expectSameShape('rider_history', 'rider_history'));
    test('rider ledger', () => _expectSameShape('rider_ledger', 'rider_ledger'));
    test('rider ratings', () => _expectSameShape('rider_ratings', 'rider_ratings'));
    test('rider document upload', () => _expectSameShape('rider_document', 'rider_document'));
    test('rider document link: the url the repository reads', () {
      final link = _gen('rider_document_url');
      expect(link['url'], isA<String>());
      expect(link['expiresAt'], isA<String>());
    });
    test('cash deposits', () => _expectSameShape('cash_deposits', 'cash_deposits'));
    test('cash disputes', () => _expectSameShape('cash_disputes', 'cash_disputes'));
    test('delivery exceptions', () => _expectSameShape('exceptions', 'exceptions'));
    test('payment requests', () => _expectSameShape('payment_requests', 'payment_requests'));
  });

  group('the models read the server answers without falling back', () {
    test('riders list', () {
      final p = RiderPage.fromJson(_gen('riders_list'));
      expect(p.items, hasLength(1));
      final r = p.items.single;
      expect(r.riderCode, 'DR-0007');
      expect(r.state, isNot(RiderState.unknown));
      expect(r.verification, isNot(RiderVerification.unknown));
      expect(r.account, isNot(RiderAccount.unknown));
      expect(p.counts.all, 1);
    });

    test('rider detail: documents, active route, money', () {
      final d = RiderDetail.fromJson(_rider('rider_detail'));
      expect(d.documents.map((x) => x.type), isNot(contains(RiderDocType.unknown)));
      expect(d.documents.map((x) => x.status), isNot(contains(RiderDocStatus.unknown)));
      expect(d.active, hasLength(1));
      expect(d.active.single.route.length, greaterThanOrEqualTo(2));
      expect(d.money, isNotNull);
      expect(d.money!.pendingRequests.single.method, isNot(PayMethod.unknown));
      expect(d.money!.lastPayout?.method, PayMethod.upi);
      expect(RiderDetail.fromJson(_rider('rider_detail_no_money')).money, isNull);
    });

    test('history has no earning and reads its outcome', () {
      final h = RiderHistoryPage.fromJson(_gen('rider_history'));
      expect(h.items.single.outcome, isNot(RiderOutcome.unknown));
      expect((_gen('rider_history')['items'] as List).every((i) => !(i as Map).containsKey('earning')), isTrue);
    });

    test('ledger rows and payouts', () {
      final l = LedgerPage.fromJson(_gen('rider_ledger'));
      expect(l.items, hasLength(2));
      expect(l.items.map((r) => r.type), isNot(contains(LedgerType.unknown)));
      expect(l.items.map((r) => r.status), isNot(contains(LedgerStatus.unknown)));
      expect(l.payouts.single.method, PayMethod.upi);
    });

    test('ratings', () => expect(RatingPage.fromJson(_gen('rider_ratings')).items, hasLength(2)));

    test('cash: deposits and disputes with their counts', () {
      final deps = CashDepositPage.fromJson(_gen('cash_deposits'));
      expect(deps.items.single.method, isNot(CashMethod.unknown));
      expect(deps.items.single.status, DepositStatus.submitted);
      final disputes = CashDisputePage.fromJson(_gen('cash_disputes'));
      expect(disputes.counts?.open, 1);
      expect(disputes.items.single.status, isNot(DisputeStatus.unknown));
    });

    test('exceptions: the stored other_issue reads as Other', () {
      final p = ExceptionPage.fromJson(_gen('exceptions'));
      expect(p.items.single.kind, ExceptionKind.other);
      expect(p.items.single.status, isNot(ExceptionStatus.unknown));
    });

    test('payment requests: someone else\'s request is decidable', () {
      final p = PaymentRequestPage.fromJson(_gen('payment_requests'));
      final r = p.items.single;
      expect(r.kind, PaymentKind.riderPayout);
      expect(r.status, PaymentStatus.pendingApproval);
      expect(r.canDecide, isTrue);
    });
  });
}
