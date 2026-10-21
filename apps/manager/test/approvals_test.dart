import 'package:deligro_manager/core/push.dart';
import 'package:deligro_manager/features/payments/approvals_screen.dart';
import 'package:deligro_manager/features/payments/payout_request_sheet.dart';
import 'package:deligro_manager/features/riders/rider_ledger_screen.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/payment_request.dart';
import 'package:deligro_manager/models/rider.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_rider_repositories.dart';
import 'rider_helpers.dart';

const _approver = {
  ...riderViewer,
  'manager.finance.view',
  'manager.finance.approve_payment',
  'manager.finance.initiate_payment',
};

Future<RiderFakes> _approvals(WidgetTester tester, {RiderFakes? fakes, Uri? query}) async {
  final f = fakes ?? RiderFakes();
  await pumpRider(tester, ApprovalsScreen(query: query), fakes: f, permissions: _approver, size: const Size(420, 1000));
  return f;
}

void main() {
  testWidgets('my own request: "another person" line, no Approve, Withdraw instead', (tester) async {
    await _approvals(tester);
    expect(find.text('You asked for this — another person must approve it.'), findsOneWidget);
    expect(find.byKey(const Key('pr-approve-pr-2')), findsNothing);
    expect(find.byKey(const Key('pr-withdraw-pr-2')), findsOneWidget);
  });

  testWidgets("someone else's request with canDecide shows Approve and Reject", (tester) async {
    await _approvals(tester);
    expect(find.byKey(const Key('pr-approve-pr-1')), findsOneWidget);
    expect(find.byKey(const Key('pr-reject-pr-1')), findsOneWidget);
    expect(find.byKey(const Key('pr-withdraw-pr-1')), findsNothing);
  });

  testWidgets('Approve without a reference keeps Submit off', (tester) async {
    await _approvals(tester);
    await tester.tap(find.byKey(const Key('pr-approve-pr-1')));
    await tester.pumpAndSettle();
    final submit = find.byKey(const Key('approve-submit'));
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('approve-reference')), 'UTR778899');
    await tester.pump();
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
  });

  testWidgets('amount_changed asks again and resends with confirmAmount and the same id', (tester) async {
    final fakes = RiderFakes();
    fakes.payments.decideOutcomes.add(const Refused('amount_changed', ['12500']));
    await _approvals(tester, fakes: fakes);
    await tester.tap(find.byKey(const Key('pr-approve-pr-1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('approve-reference')), 'UTR778899');
    await tester.pump();
    await tester.tap(find.byKey(const Key('approve-submit')));
    await tester.pumpAndSettle();
    expect(find.text('The amount is now ₹12,500.00 (was ₹12,000.00). Approve ₹12,500.00?'), findsOneWidget);
    await tester.tap(find.text('Approve ₹12,500.00'));
    await tester.pumpAndSettle();
    final calls = fakes.payments.decideCalls;
    expect(calls, hasLength(2));
    expect(calls[1].decision.confirmAmount, 12500);
    expect(calls[1].decision.clientActionId, calls[0].decision.clientActionId);
    expect(calls[1].decision.reference, 'UTR778899');
    expect(calls[0].decision.toJson().containsKey('confirmAmount'), isFalse);
  });

  testWidgets('Reject needs a note', (tester) async {
    final fakes = await _approvals(tester);
    await tester.tap(find.byKey(const Key('pr-reject-pr-1')));
    await tester.pumpAndSettle();
    final submit = find.byKey(const Key('reason-submit'));
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.enterText(find.byType(TextField).last, 'Wrong period');
    await tester.pump();
    await tester.tap(submit);
    await tester.pumpAndSettle();
    final d = fakes.payments.decideCalls.single.decision;
    expect(d.decision, PaymentDecisionKind.reject);
    expect(d.note, 'Wrong period');
  });

  testWidgets('"Waiting (2)" asks for pending requests; Mine asks for mine', (tester) async {
    final fakes = await _approvals(tester);
    expect(find.text('Waiting (2)'), findsOneWidget);
    expect(fakes.payments.listCalls.first.status, PaymentStatus.pendingApproval);
    await tester.ensureVisible(find.byKey(const Key('approvals-tab-mine')));
    await tester.tap(find.byKey(const Key('approvals-tab-mine')));
    await tester.pumpAndSettle();
    expect(fakes.payments.listCalls.map((f) => f.mine), contains(true));
  });

  testWidgets('same_person is explained', (tester) async {
    final fakes = RiderFakes();
    fakes.payments.decideOutcomes.add(const Refused('same_person'));
    await _approvals(tester, fakes: fakes);
    await tester.tap(find.byKey(const Key('pr-approve-pr-1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('approve-reference')), 'UTR1');
    await tester.pump();
    await tester.tap(find.byKey(const Key('approve-submit')));
    await tester.pumpAndSettle();
    expect(find.text('You asked for this payment, so someone else has to approve it.'), findsOneWidget);
  });

  testWidgets('the payout form refuses a period that ends in the future', (tester) async {
    final fakes = RiderFakes();
    await pumpRider(
      tester,
      Consumer(
        builder: (context, ref, _) => Scaffold(
          body: Center(
            child: FilledButton(
              onPressed: () => showPayoutRequestSheet(context, ref, fixtureRider()),
              child: const Text('open'),
            ),
          ),
        ),
      ),
      fakes: fakes,
      permissions: _approver,
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('payout-period-end')), '2999-01-31');
    await tester.pump();
    expect(find.text("The period can't end in the future."), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('payout-submit'))).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('payout-period-end')), '2026-09-30');
    await tester.enterText(find.byKey(const Key('payout-salary')), '12000');
    await tester.pump();
    expect(find.text('Will pay ₹24,000.00 (salary ₹12,000.00 + ₹12,000.00 pending in the ledger)'), findsOneWidget);
    await tester.tap(find.byKey(const Key('payout-submit')));
    await tester.pumpAndSettle();
    final d = fakes.payments.requestCalls.single;
    expect(d.toJson()['periodEnd'], '2026-09-30');
    expect(d.salaryAmount, 12000);
    expect(d.riderId, 'r-1');
  });

  testWidgets('ledger: the Pending filter asks for pending rows', (tester) async {
    final fakes = RiderFakes();
    await pumpRider(tester, const RiderLedgerScreen(riderId: 'r-1'), fakes: fakes, permissions: _approver);
    expect(find.text('Rain shift'), findsOneWidget);
    expect(find.text('−₹200.00'), findsOneWidget, reason: 'a deduction reads as money off');
    await tester.tap(find.byKey(const Key('ledger-filter-pending')));
    await tester.pumpAndSettle();
    expect(fakes.riders.ledgerCalls.last, LedgerStatus.pending);
  });

  test('push links: payment request, cash deposit and delivery exception', () {
    expect(inAppPathFrom(null, {'appPath': '/more/approvals?id=pr-1aaaaaaa'}), '/more/approvals?id=pr-1aaaaaaa');
    expect(inAppPathFrom(null, {'type': 'payment_request', 'id': 'abcdef12-0000'}), '/more/approvals?id=abcdef12-0000');
    expect(inAppPathFrom(null, {'type': 'cash_deposit', 'id': 'abcdef12-0000'}), '/more/cash');
    expect(inAppPathFrom(null, {'type': 'delivery_exception', 'id': 'abcdef12-0000'}), '/live/exceptions?id=abcdef12-0000');
    expect(inAppPathFrom('/live/exceptions?id=abcdef12-0000', null), '/live/exceptions?id=abcdef12-0000');
  });

  // One-admin payments (0152): the server sends canDecide on the viewer's own
  // request only for an admin with the switch on.
  PaymentRequestPage ownPage({required bool canDecide, String status = 'pending_approval', bool selfApproved = false}) {
    final j = p5('payment_requests');
    final items = (j['items'] as List).cast<Map<String, dynamic>>();
    final mine = Map<String, dynamic>.from(items[1])
      ..['canDecide'] = canDecide
      ..['status'] = status
      ..['selfApproved'] = selfApproved;
    if (status == 'approved') {
      mine
        ..['decidedBy'] = mine['requestedBy']
        ..['decidedAt'] = '2026-10-21T08:00:00Z'
        ..['reference'] = 'UTR5'
        ..['paidOn'] = '2026-10-21'
        ..['decisionNote'] = 'No second admin';
    }
    return PaymentRequestPage.fromJson({...j, 'items': [items[0], mine]});
  }

  testWidgets('an admin approving their own request must give a reason', (tester) async {
    final fakes = RiderFakes(payments: FakePaymentsRepository(page: ownPage(canDecide: true)));
    await _approvals(tester, fakes: fakes);
    expect(find.text('You asked for this — another person must approve it.'), findsNothing);
    await tester.tap(find.byKey(const Key('pr-approve-pr-2')));
    await tester.pumpAndSettle();
    expect(find.text('Reason (you are approving your own request)'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('approve-reference')), 'UTR5551');
    await tester.pump();
    final submit = find.byKey(const Key('approve-submit'));
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('approve-note')), 'No second admin');
    await tester.pump();
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(fakes.payments.decideCalls.single.decision.note, 'No second admin');
  });

  testWidgets('a self-approved request says so', (tester) async {
    final fakes = RiderFakes(
      payments: FakePaymentsRepository(page: ownPage(canDecide: false, status: 'approved', selfApproved: true)),
    );
    await _approvals(tester, fakes: fakes);
    expect(find.text('Self-approved by admin'), findsOneWidget);
  });

  test('selfApproved parses and defaults to false', () {
    expect(PaymentRequestPage.fromJson(p5('payment_requests')).items.first.selfApproved, isFalse);
    expect(ownPage(canDecide: false, status: 'approved', selfApproved: true).items[1].selfApproved, isTrue);
  });
}
