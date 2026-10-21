import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/riders/rider_detail_screen.dart';
import 'package:deligro_manager/models/cash.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/rider.dart';
import 'package:deligro_manager/widgets/contact_buttons.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_rider_repositories.dart';
import 'rider_helpers.dart';

const _manage = {
  ...riderViewer,
  'manager.riders.status',
  'manager.cash',
  'manager.finance.view',
};

Future<RiderFakes> _open(
  WidgetTester tester, {
  RiderDetail? rider,
  Set<String> permissions = _manage,
  List extra = const [],
}) async {
  final fakes = RiderFakes(riders: FakeRidersRepository(detail: rider ?? fixtureRider()));
  await pumpRider(tester, const RiderDetailScreen(riderId: 'r-1'), fakes: fakes, permissions: permissions, extra: extra);
  return fakes;
}

Future<void> _tab(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.widgetWithText(Tab, label));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(Tab, label));
  await tester.pumpAndSettle();
}

/// The reason dialog's own submit button (the header has buttons with the
/// same words).
final _submit = find.byKey(const Key('reason-submit'));

Future<void> _reason(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField).last, text);
  await tester.pump();
}

void main() {
  testWidgets('shows the rider: name, code and state', (tester) async {
    await _open(tester);
    expect(find.text('Ravi Kumar'), findsWidgets);
    expect(find.text('DR-0007'), findsOneWidget);
    expect(find.text('On delivery'), findsOneWidget);
    expect(find.text('Waiting for review'), findsWidgets);
  });

  testWidgets('offline rider: the location line, and no rider marker', (tester) async {
    await _open(tester, rider: fixtureRider(money: false));
    expect(find.text('Location shown only while the rider is online or on a delivery.'), findsOneWidget);
    expect(find.bySemanticsLabel('Rider'), findsNothing);
  });

  testWidgets('the Money tab is absent without money', (tester) async {
    await _open(tester, rider: fixtureRider(money: false));
    expect(find.widgetWithText(Tab, 'Money'), findsNothing);
  });

  testWidgets('the Money tab is present with money', (tester) async {
    await _open(tester);
    expect(find.widgetWithText(Tab, 'Money'), findsOneWidget);
  });

  testWidgets('only allowed actions are offered', (tester) async {
    await _open(tester, rider: fixtureRider(money: false));
    expect(find.byKey(const Key('rider-action-suspend')), findsOneWidget);
    expect(find.byKey(const Key('rider-action-approve')), findsNothing);
    expect(find.byKey(const Key('rider-action-reactivate')), findsNothing);
    expect(find.byKey(const Key('rider-action-force_offline')), findsNothing);
  });

  testWidgets('Suspend asks why and sends Suspend(expected: active)', (tester) async {
    final fakes = await _open(tester);
    await tester.tap(find.byKey(const Key('rider-action-suspend')));
    await tester.pumpAndSettle();
    final submit = _submit;
    expect(tester.widget<FilledButton>(submit).onPressed, isNull, reason: 'under 3 characters');
    await _reason(tester, 'No-shows twice');
    await tester.tap(submit);
    await tester.pumpAndSettle();
    final a = fakes.riders.actCalls.single.action;
    expect(a, isA<SuspendRider>());
    expect(a.toJson()['expected'], 'active');
    expect(a.toJson()['reason'], 'No-shows twice');
  });

  testWidgets('active_delivery says which order to reassign, and opens it', (tester) async {
    final fakes = RiderFakes(riders: FakeRidersRepository(detail: fixtureRider()));
    fakes.riders.actOutcomes.add(const Refused('active_delivery', ['AB12CD34']));
    final opened = await pumpRiderRouter(
      tester,
      (_) => const RiderDetailScreen(riderId: 'r-1'),
      fakes: fakes,
      permissions: _manage,
    );
    await tester.tap(find.byKey(const Key('rider-action-suspend')));
    await tester.pumpAndSettle();
    await _reason(tester, 'Repeated no-shows');
    await tester.tap(_submit);
    await tester.pumpAndSettle();
    expect(find.text('Reassign AB12CD34 first'), findsOneWidget);
    await tester.tap(find.text('Reassign AB12CD34 first'));
    await tester.pumpAndSettle();
    expect(opened, ['/orders/o-1']);
  });

  testWidgets('Approve refused for documents → "Approve anyway" resends with override and the same id', (tester) async {
    final fakes = RiderFakes(riders: FakeRidersRepository(detail: fixtureRider()));
    fakes.riders.actOutcomes.add(const Refused('documents_unverified', ['driving_licence']));
    await pumpRider(tester, const RiderDetailScreen(riderId: 'r-1'), fakes: fakes, permissions: _manage);
    await tester.tap(find.byKey(const Key('rider-action-approve')));
    await tester.pumpAndSettle();
    await _reason(tester, 'Documents checked');
    await tester.tap(_submit);
    await tester.pumpAndSettle();
    expect(find.textContaining('Missing verified: Driving licence'), findsOneWidget);
    await tester.tap(find.text('Approve anyway'));
    await tester.pumpAndSettle();
    final calls = fakes.riders.actCalls;
    expect(calls, hasLength(2));
    expect(calls[1].action.toJson()['override'], isTrue);
    expect(calls[0].action.toJson()['override'], isFalse);
    expect(calls[1].action.clientActionId, calls[0].action.clientActionId);
  });

  testWidgets('a network fault offers Retry with the same action id', (tester) async {
    final fakes = RiderFakes(riders: FakeRidersRepository(detail: fixtureRider()));
    fakes.riders.actError = ApiException(500, 'action_failed');
    await pumpRider(tester, const RiderDetailScreen(riderId: 'r-1'), fakes: fakes, permissions: _manage);
    await tester.tap(find.byKey(const Key('rider-action-force_offline')));
    await tester.pumpAndSettle();
    await _reason(tester, 'Not answering calls');
    await tester.tap(_submit);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    final calls = fakes.riders.actCalls;
    expect(calls, hasLength(2));
    expect(calls[1].action.clientActionId, calls[0].action.clientActionId);
  });

  testWidgets('rejecting a document needs remarks', (tester) async {
    final fakes = await _open(tester);
    await _tab(tester, 'Documents');
    await tester.tap(find.byKey(const Key('doc-reject-d-1')));
    await tester.pumpAndSettle();
    final submit = _submit;
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await _reason(tester, 'Blurry photo');
    await tester.tap(submit);
    await tester.pumpAndSettle();
    final a = fakes.riders.actCalls.single.action;
    expect(a, isA<RejectRiderDocument>());
    expect(a.toJson()['remarks'], 'Blurry photo');
    expect(a.toJson()['documentId'], 'd-1');
  });

  testWidgets('Deliveries: the Failed chip asks for failed deliveries', (tester) async {
    final fakes = await _open(tester);
    await _tab(tester, 'Deliveries');
    await tester.tap(find.byKey(const Key('history-outcome-failed')));
    await tester.pumpAndSettle();
    expect(fakes.riders.historyCalls.last.outcome, RiderOutcome.failed);
  });

  testWidgets('Call dials the rider', (tester) async {
    final opened = <Uri>[];
    await _open(tester, extra: [
      urlOpenerProvider.overrideWithValue((Uri u) async {
        opened.add(u);
        return true;
      }),
    ]);
    await tester.tap(find.byKey(const Key('contact-call')).first);
    await tester.pump();
    expect(opened.single.toString(), 'tel:+919876500001');
  });

  testWidgets('Cash: disputing a deposit needs a note', (tester) async {
    final fakes = await _open(tester);
    await _tab(tester, 'Cash');
    await tester.tap(find.byKey(const Key('deposit-dispute-cd-1')));
    await tester.pumpAndSettle();
    final submit = _submit;
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await _reason(tester, 'Only 2000 received');
    await tester.tap(submit);
    await tester.pumpAndSettle();
    final d = fakes.cash.decideCalls.single;
    expect(d.id, 'cd-1');
    expect(d.decision.confirm, isFalse);
    expect(d.decision.note, 'Only 2000 received');
  });

  testWidgets('Cash: confirm sends once even on a double tap', (tester) async {
    final fakes = await _open(tester);
    await _tab(tester, 'Cash');
    final btn = find.byKey(const Key('deposit-confirm-cd-1'));
    await tester.tap(btn);
    await tester.tap(btn, warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(fakes.cash.decideCalls, hasLength(1));
    expect(fakes.cash.decideCalls.single.decision, isA<DepositDecision>());
  });

  testWidgets('Complaints open the ticket thread', (tester) async {
    final fakes = RiderFakes(riders: FakeRidersRepository(detail: fixtureRider()));
    final opened = await pumpRiderRouter(
      tester,
      (_) => const RiderDetailScreen(riderId: 'r-1'),
      fakes: fakes,
      permissions: _manage,
    );
    await _tab(tester, 'Complaints');
    await tester.tap(find.text('Rider was rude'));
    await tester.pumpAndSettle();
    expect(opened, ['/more/tickets/t-1']);
  });
}
