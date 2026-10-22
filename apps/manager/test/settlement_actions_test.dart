import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/finance/refunds_screen.dart';
import 'package:deligro_manager/features/finance/vendor_dues_screen.dart';
import 'package:deligro_manager/features/payments/approvals_screen.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/payment_request.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_finance_repository.dart';
import 'fakes/fake_rider_repositories.dart';
import 'finance_helpers.dart';

const initiator = {...financeViewer, 'manager.finance.initiate_payment'};
const approver = {...financeViewer, 'manager.finance.approve_payment'};
const adjuster = {...financeViewer, 'manager.finance.adjust'};

FinanceFakes _withSettlementRequests() =>
    FinanceFakes(payments: FakePaymentsRepository(page: PaymentRequestPage.fromJson(p6('payment_requests_settlement'))));

void main() {
  testWidgets('"Put up for payment" needs initiate_payment', (t) async {
    await pumpFinance(t, const VendorDuesScreen());
    await t.pumpAndSettle();
    expect(find.text('Put up for payment'), findsNothing);
  });

  testWidgets('initiating: preview of net, then "Waiting for approval by someone else"', (t) async {
    final fakes = FinanceFakes();
    await pumpFinance(t, const VendorDuesScreen(), fakes: fakes, permissions: initiator);
    await t.pumpAndSettle();
    // Spice Hub is owed and has no request yet; Green Leaf already waits.
    expect(find.byKey(const Key('initiate-v-1')), findsOneWidget);
    expect(find.byKey(const Key('initiate-v-2')), findsNothing);
    await t.tap(find.byKey(const Key('initiate-v-1')));
    await t.pumpAndSettle();
    expect(find.textContaining('Spice Hub'), findsWidgets);
    await t.tap(find.byKey(const Key('initiate-submit')));
    await t.pumpAndSettle();
    final sent = fakes.finance.initiateCalls.single;
    expect(sent.vendorId, 'v-1');
    expect(sent.orderId, isNull);
    expect(sent.from, isNotNull);
    expect(find.textContaining('Waiting for approval by someone else'), findsOneWidget);
    expect(find.textContaining('₹6,420'), findsWidgets);
  });

  testWidgets('a negative net says the shop owes Deligro', (t) async {
    final fakes = FinanceFakes();
    fakes.finance.initiateOutcomes.add(const Refused('negative_net', [], null, {'netPayable': -340}));
    await pumpFinance(t, const VendorDuesScreen(), fakes: fakes, permissions: initiator);
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('initiate-v-1')));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('initiate-submit')));
    await t.pumpAndSettle();
    expect(find.text('This shop owes Deligro ₹340 — collect it separately'), findsOneWidget);
  });

  testWidgets('settlement cards: shop, period, net, Open settlement, self-approved mark', (t) async {
    final opened = await pumpFinanceRouter(t, (s) => ApprovalsScreen(query: s.uri),
        fakes: _withSettlementRequests(), permissions: approver);
    await t.pumpAndSettle();
    expect(find.text('Green Leaf Cafe'), findsOneWidget);
    expect(find.textContaining('to 2026-10-14'), findsOneWidget);
    expect(find.text('Self-approved by admin'), findsOneWidget);
    await t.tap(find.byKey(const Key('open-settlement-pr-9')));
    await t.pumpAndSettle();
    expect(opened.last, '/finance/settlements/s-2');
  });

  testWidgets('?kind=vendor_settlement shows only settlements', (t) async {
    final fakes = _withSettlementRequests();
    fakes.payments.page = PaymentRequestPage(items: [
      ...fakes.payments.page.items,
      ...FakePaymentsRepository().page.items, // rider payouts
    ]);
    await pumpFinance(t, ApprovalsScreen(query: Uri.parse('/more/approvals?kind=vendor_settlement')),
        fakes: fakes, permissions: approver);
    await t.pumpAndSettle();
    expect(find.text('Green Leaf Cafe'), findsOneWidget);
    expect(find.textContaining('Ravi Kumar'), findsNothing);
  });

  testWidgets('amount_changed on a settlement re-sends with a NEW id and the new amount', (t) async {
    final fakes = _withSettlementRequests();
    fakes.payments.decideOutcomes.add(const Refused('amount_changed', ['1600'], null, {'amount': 1600, 'settlementId': 's-5'}));
    await pumpFinance(t, const ApprovalsScreen(), fakes: fakes, permissions: approver);
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('pr-approve-pr-9')));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('approve-reference')), 'UTR777');
    await t.pump();
    await t.tap(find.byKey(const Key('approve-submit')));
    await t.pumpAndSettle();
    expect(find.textContaining('₹1,600'), findsWidgets);
    await t.tap(find.text('Approve ₹1,600'));
    await t.pumpAndSettle();
    final calls = fakes.payments.decideCalls;
    expect(calls, hasLength(2));
    expect(calls[1].decision.confirmAmount, 1600);
    expect(calls[1].decision.reference, 'UTR777');
    expect(calls[1].decision.clientActionId, isNot(calls[0].decision.clientActionId));
  });

  testWidgets('the requester gets no Approve on their own settlement request', (t) async {
    final fakes = FinanceFakes(payments: FakePaymentsRepository(page: PaymentRequestPage.fromJson({
      'items': [
        {...(p6('payment_requests_settlement')['items'] as List).first as Map,
          'requestedBy': {'id': 'u1', 'name': 'Asha Verma'}, 'canDecide': false},
      ],
    })));
    await pumpFinance(t, const ApprovalsScreen(), fakes: fakes, permissions: {...approver, ...initiator});
    await t.pumpAndSettle();
    expect(find.byKey(const Key('pr-approve-pr-9')), findsNothing);
    expect(find.textContaining('another person must approve'), findsOneWidget);
  });

  testWidgets('refund decisions need finance.adjust', (t) async {
    await pumpFinance(t, const RefundsScreen());
    await t.pumpAndSettle();
    expect(find.text('AB12CD34'), findsOneWidget);
    expect(find.byKey(const Key('refund-approve-rf-1')), findsNothing);
  });

  testWidgets('deny asks for a reason of at least 3 characters', (t) async {
    final fakes = FinanceFakes();
    await pumpFinance(t, const RefundsScreen(), fakes: fakes, permissions: adjuster);
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('refund-deny-rf-1')));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField).last, 'no');
    await t.pump();
    final submit = find.widgetWithText(FilledButton, 'Deny refund');
    expect(t.widget<FilledButton>(submit).onPressed, isNull);
    await t.enterText(find.byType(TextField).last, 'Already refunded in cash');
    await t.pump();
    await t.tap(submit);
    await t.pumpAndSettle();
    expect(fakes.finance.decideCalls.single.decision.approve, isFalse);
    expect(fakes.finance.decideCalls.single.decision.reason, 'Already refunded in cash');
  });

  testWidgets('effect_failed: decision saved, retry reuses the same id', (t) async {
    final fakes = FinanceFakes();
    fakes.finance.decideError = ApiException(502, 'effect_failed', body: const {'refundId': 'rf-1'});
    await pumpFinance(t, const RefundsScreen(), fakes: fakes, permissions: adjuster);
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('refund-approve-rf-1')));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField).last, 'Item missing, confirmed');
    await t.pump();
    await t.tap(find.widgetWithText(FilledButton, 'Approve refund'));
    await t.pumpAndSettle();
    expect(find.text('Decision saved; finishing it failed — retry'), findsOneWidget);
    await t.tap(find.text('Retry'));
    await t.pumpAndSettle();
    final calls = fakes.finance.decideCalls;
    expect(calls, hasLength(2));
    expect(calls[1].decision.clientActionId, calls[0].decision.clientActionId);
  });
}
