import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/data/riders_repository.dart';
import 'package:deligro_manager/models/cash.dart';
import 'package:deligro_manager/models/delivery_exception.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/payment_request.dart';
import 'package:deligro_manager/models/rider.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixtures/fixtures.dart';

Map<String, dynamic> p5(String name) => apiFixture('phase5/$name');

void main() {
  group('Phase 5 fixtures parse', () {
    test('riders list', () {
      final page = RiderPage.fromJson(p5('riders_list'));
      expect(page.items, hasLength(3));
      expect(page.nextCursor, 'c-2');
      expect(page.counts.available, 5);
      expect(page.counts.needsReview, 2);
      final r = page.items.first;
      expect(r.riderCode, 'DR-0007');
      expect(r.state, RiderState.onDelivery);
      expect(r.zones.single.name, 'Bemetara');
      expect(r.verification, RiderVerification.verified);
      expect(r.rating, 4.6);
      final bare = page.items.last;
      expect(bare.name, isNull);
      expect(bare.account, RiderAccount.suspended);
      expect(bare.fixAgeSeconds, isNull);
    });

    test('rider detail with money', () {
      final d = RiderDetail.fromJson(p5('rider_detail')['rider'] as Map<String, dynamic>);
      expect(d.summary.name, 'Ravi Kumar');
      expect(d.money, isNotNull);
      expect(d.money!.pending, 12000.0);
      expect(d.money!.pendingRequests.single.canDecide, isTrue);
      expect(d.availability.position, isNotNull);
      expect(d.active.single.route, hasLength(3));
      expect(d.active.single.delay?.minutes, 7);
      expect(d.performance.acceptanceRate, 0.91);
      expect(d.performance.months.single.month, '2026-09');
      expect(d.ratings.distribution[5], 20);
      expect(d.documents.first.type, RiderDocType.drivingLicence);
      expect(d.documents.first.status, RiderDocStatus.pending);
      expect(d.cash.openDeposits.single.method, CashMethod.upi);
      expect(d.openComplaints.single.subject, 'Rider was rude');
      expect(d.allowed.forceOffline, isTrue);
      expect(d.profile.emergency.relation, 'Wife');
    });

    test('detail without money → money == null; null position parses', () {
      final d = RiderDetail.fromJson(p5('rider_detail_no_money')['rider'] as Map<String, dynamic>);
      expect(d.money, isNull);
      expect(d.availability.position, isNull);
      expect(d.active, isEmpty);
    });

    test('unknown state → unknown', () {
      final j = Map<String, dynamic>.from((p5('riders_list')['items'] as List).first as Map)..['state'] = 'teleporting';
      expect(RiderListItem.fromJson(j).state, RiderState.unknown);
    });

    test('rider money with paise parses as double', () {
      final l = LedgerPage.fromJson(p5('rider_ledger'));
      expect(l.items[1].amount, 500.5);
      expect(l.items[1].type, LedgerType.bonus);
      expect(l.summary.pending, 12500.5);
      expect(l.payouts.single.reference, 'UTR123');
      expect(l.items[2].status, LedgerStatus.paid);
    });

    test('history, ratings, payment requests, cash, exceptions, onboarding', () {
      final h = RiderHistoryPage.fromJson(p5('rider_history'));
      expect(h.items[1].outcome, RiderOutcome.failed);
      expect(h.totals.reassigned, 1);
      expect(RatingPage.fromJson(p5('rider_ratings')).items, hasLength(2));
      final pr = PaymentRequestPage.fromJson(p5('payment_requests'));
      expect(pr.counts.pendingApproval, 2);
      expect(pr.items.last.canDecide, isFalse);
      expect(pr.items.first.salaryAmount, 12000.0);
      expect(CashDepositPage.fromJson(p5('cash_deposits')).counts.submitted, 3);
      expect(CashDisputePage.fromJson(p5('cash_disputes')).items.single.claimedAmount, 1800);
      final ex = ExceptionPage.fromJson(p5('exceptions'));
      expect(ex.items.first.kind, ExceptionKind.failedDelivery);
      expect(ex.items.first.decisions, [ExceptionDecision.approve, ExceptionDecision.reject]);
      expect(ex.items.last.decisions, [ExceptionDecision.acknowledge]);
      final o = RiderOnboardResult.fromJson(p5('rider_onboard'));
      expect(o.riderCode, 'DR-0025');
      expect(o.password, 'Gen-erated9');
      expect(RiderDocument.fromJson(p5('rider_document')['document'] as Map<String, dynamic>).type, RiderDocType.photo);
    });
  });

  group('RiderFilters', () {
    test('fromUri reads the dashboard deep link', () {
      final f = RiderFilters.fromUri(Uri.parse('/more/riders?state=available'));
      expect(f.states, {RiderState.available});
    });

    test('toQuery round-trips', () {
      const f = RiderFilters(
        q: 'DR-00',
        states: {RiderState.online, RiderState.onDelivery},
        verification: RiderVerification.pending,
        account: RiderAccount.active,
        zoneId: 'z-1',
        filter: RiderQuickFilter.needsReview,
      );
      final back = RiderFilters.fromUri(Uri(path: '/more/riders', queryParameters: f.toQuery()));
      expect(back, f);
      expect(f.toQuery()['state'], 'online,on_delivery');
      expect(f.toQuery()['filter'], 'needs_review');
    });
  });

  group('refusals', () {
    Future<Outcome<Object?>> refuse(int status, Map<String, dynamic> body) =>
        runAction<Object?>(() async => throw ApiException(status, '${body['error']}', body: body), (_) => null);

    test('active_delivery carries the order codes', () async {
      final out = await refuse(409, {'error': 'active_delivery', 'orders': ['AB12CD34']});
      expect(out, isA<Refused<Object?>>());
      out as Refused;
      expect(out.code, 'active_delivery');
      expect(out.reasons, ['AB12CD34']);
    });

    test('amount_changed carries the new amount', () async {
      final out = await refuse(409, {'error': 'amount_changed', 'amount': 12500});
      out as Refused;
      expect(out.code, 'amount_changed');
      expect(out.reasons, ['12500']);
      final paise = await refuse(409, {'error': 'amount_changed', 'amount': 12500.5}) as Refused;
      expect(paise.reasons, ['12500.5']);
    });
  });

  test('a retried action keeps its clientActionId', () {
    final a = SuspendRider(expected: RiderAccount.active, reason: 'Repeated no-shows');
    final json1 = a.toJson();
    final json2 = a.toJson();
    expect(json1['clientActionId'], json2['clientActionId']);
    expect(json1['action'], 'suspend');
    expect(json1['expected'], 'active');
    final b = ApproveRider(expected: RiderVerification.pending, reason: 'Checked');
    final anyway = b.anyway();
    expect(anyway.toJson()['override'], isTrue);
    expect(anyway.clientActionId, b.clientActionId);
    final adj = AddRiderAdjustment(
      kind: AdjustmentKind.bonus,
      amount: 500.5,
      effectiveOn: DateTime(2026, 10, 20),
      reason: 'Rain shift',
    ).toJson();
    expect(adj['adjustment'], {'kind': 'bonus', 'amount': 500.5, 'effectiveOn': '2026-10-20', 'orderId': null});
  });

  test('repository paths', () {
    expect(riderPageSize, 50);
  });
}
